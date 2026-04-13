'use strict';

/**
 * hotkeyManager.js
 * ----------------
 * Centralized hotkey registration, health monitoring, conflict detection,
 * self-healing, and diagnostic logging.
 *
 * Replaces the ad-hoc globalShortcut calls that were scattered through main.js.
 * Every accelerator is registered through this module so we get:
 *   - Return-value checking on every register() call
 *   - Retry with backoff when registration fails
 *   - Pre-flight conflict detection via isRegistered()
 *   - Re-registration on sleep/wake and display changes
 *   - Periodic health checks (every 60s)
 *   - Diagnostic log file in userData
 *   - Native notification when hotkeys fail
 *   - Externalised config (hotkeys.json) so users can remap shortcuts
 */

const { globalShortcut, Notification, powerMonitor } = require('electron');
const fs   = require('fs');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────

const SNIPPET_KEYS = ['B', 'E', 'F', 'G', 'I', 'J', 'K', 'O', 'P'];

const DEFAULT_FEATURE_HOTKEYS = {
  sonar:           'CommandOrControl+Shift+X',
  selection:       'CommandOrControl+Shift+D',
  cursorHighlight: 'CommandOrControl+Shift+H',
  snippetManager:  'CommandOrControl+Shift+S',
  spotlight:       'CommandOrControl+Shift+L',
  freezeFrame:     'CommandOrControl+Shift+Z',
  annotation:      'CommandOrControl+Shift+A',
  annotationClear: 'CommandOrControl+Shift+C',
  zoomLens:        'CommandOrControl+Shift+M',
  cueCard:         'CommandOrControl+Shift+N',
  cueCardNext:     'CommandOrControl+Shift+Right',
  cueCardPrev:     'CommandOrControl+Shift+Left',
  recordToggle:    'CommandOrControl+Shift+R'
};

const SNIPPET_ACCEL_PREFIX = 'CommandOrControl+Alt+';

const MAX_RETRIES     = 3;
const RETRY_DELAY_MS  = 1000;
const HEALTH_CHECK_MS = 60_000;
const LOG_MAX_BYTES   = 512 * 1024; // rotate at 512 KB

// ─── State ───────────────────────────────────────────────────────────────────

let userDataPath   = '';
let configFile     = '';
let logFile        = '';
let featureHotkeys = { ...DEFAULT_FEATURE_HOTKEYS };

// Map: accelerator string -> { label, registered, error, callback, lastCheck }
const registry = new Map();

let healthInterval   = null;
let onStatusChange   = () => {};
let systemListenersAttached = false;

// ─── Config I/O (Phase 5a) ──────────────────────────────────────────────────

function init({ userDataDir, statusCallback }) {
  userDataPath = userDataDir;
  configFile   = path.join(userDataPath, 'hotkeys.json');
  logFile      = path.join(userDataPath, 'hotkeys.log');
  if (statusCallback) onStatusChange = statusCallback;

  featureHotkeys = loadConfig();
  log('HotkeyManager initialised');
}

function loadConfig() {
  try {
    if (fs.existsSync(configFile)) {
      const raw = fs.readFileSync(configFile, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so new keys are always present
      const merged = { ...DEFAULT_FEATURE_HOTKEYS, ...parsed };

      // Validate all accelerators — replace invalid ones with defaults
      let needsSave = false;
      for (const [action, accel] of Object.entries(merged)) {
        if (!isValidAccelerator(accel)) {
          log(`Config: invalid accelerator for ${action}: "${accel}" — resetting to default`);
          merged[action] = DEFAULT_FEATURE_HOTKEYS[action] || '';
          needsSave = true;
        }
      }
      if (needsSave) {
        saveConfig(merged);
      }

      return merged;
    }
  } catch (e) {
    log(`Config load error: ${e.message}`);
  }
  // First run — write defaults
  saveConfig(DEFAULT_FEATURE_HOTKEYS);
  return { ...DEFAULT_FEATURE_HOTKEYS };
}

function saveConfig(hotkeys) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(hotkeys, null, 2), 'utf8');
    log('Config saved');
  } catch (e) {
    log(`Config save error: ${e.message}`);
  }
}

function getAccelerator(action) {
  const accel = featureHotkeys[action] || DEFAULT_FEATURE_HOTKEYS[action] || null;
  if (accel && !isValidAccelerator(accel)) {
    log(`Invalid accelerator for ${action}: "${accel}" — falling back to default`);
    const fallback = DEFAULT_FEATURE_HOTKEYS[action] || null;
    // Auto-fix the config
    if (fallback) {
      featureHotkeys[action] = fallback;
      saveConfig(featureHotkeys);
    }
    return fallback;
  }
  return accel;
}

/**
 * Validate an Electron accelerator string.
 * Rejects strings containing non-ASCII characters (like Ω, é, etc.)
 * that would cause globalShortcut.register() to throw.
 */
function isValidAccelerator(accel) {
  if (!accel || typeof accel !== 'string') return false;
  // Electron accelerators must only contain ASCII characters
  if (/[^\x20-\x7E]/.test(accel)) return false;
  // Must have at least one key part
  const parts = accel.split('+');
  if (parts.length === 0) return false;
  return true;
}

function setAccelerator(action, accel) {
  featureHotkeys[action] = accel;
  saveConfig(featureHotkeys);
}

function getFeatureHotkeys() {
  return { ...featureHotkeys };
}

function getDefaultHotkeys() {
  return { ...DEFAULT_FEATURE_HOTKEYS };
}

// ─── Diagnostic Logging (Phase 3b) ──────────────────────────────────────────

function log(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  console.log(`[hotkeyManager] ${message}`);

  try {
    // Rotate if too large
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      if (stat.size > LOG_MAX_BYTES) {
        const rotated = logFile + '.old';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(logFile, rotated);
      }
    }
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (_) {
    // Logging should never crash the app
  }
}

// ─── Single Registration with Conflict Check (Phase 1a + 3a) ────────────────

function registerSingle(accel, callback, label) {
  // Validate accelerator before passing to Electron — non-ASCII chars crash the app
  if (!isValidAccelerator(accel)) {
    log(`SKIPPED: ${label} — invalid accelerator "${accel}"`);
    registry.set(accel, {
      label, registered: false, error: `Invalid accelerator: "${accel}"`, callback, lastCheck: Date.now()
    });
    return false;
  }

  // Phase 3a: pre-flight conflict check
  try {
    if (globalShortcut.isRegistered(accel)) {
      // It might be ours from a previous registration cycle — unregister first
      try { globalShortcut.unregister(accel); } catch (_) {}
    }
  } catch (e) {
    log(`isRegistered() threw for ${label} (${accel}): ${e.message}`);
  }

  try {
    const ok = globalShortcut.register(accel, callback);
    const entry = { label, registered: ok, error: null, callback, lastCheck: Date.now() };
    registry.set(accel, entry);

    if (ok) {
      log(`Registered: ${label} (${accel})`);
    } else {
      entry.error = 'register() returned false — likely claimed by another application';
      log(`FAILED: ${label} (${accel}) — register returned false`);
    }
    return ok;
  } catch (e) {
    registry.set(accel, {
      label, registered: false, error: e.message, callback, lastCheck: Date.now()
    });
    log(`ERROR: ${label} (${accel}) — ${e.message}`);
    return false;
  }
}

// ─── Retry with Backoff (Phase 1c) ──────────────────────────────────────────

function registerWithRetry(accel, callback, label, attempt = 1) {
  const ok = registerSingle(accel, callback, label);
  if (ok) return;

  if (attempt < MAX_RETRIES) {
    const delay = RETRY_DELAY_MS * attempt;
    log(`Retry ${attempt}/${MAX_RETRIES} for ${label} (${accel}) in ${delay}ms`);
    setTimeout(() => {
      registerWithRetry(accel, callback, label, attempt + 1);
    }, delay);
  } else {
    log(`GAVE UP: ${label} (${accel}) after ${MAX_RETRIES} retries`);
  }
}

// ─── Bulk Registration (Phase 1a) ───────────────────────────────────────────

/**
 * Register all feature hotkeys.
 * @param {Object} handlers - { sonar: fn, selection: fn, cursorHighlight: fn, snippetManager: fn }
 */
function registerFeatureHotkeys(handlers) {
  const labels = {
    sonar:           'Sonar Blip',
    selection:       'Selection Box',
    cursorHighlight: 'Cursor Highlight',
    snippetManager:  'Snippet Manager',
    spotlight:       'Spotlight',
    freezeFrame:     'Freeze Frame',
    annotation:      'Annotation Mode',
    annotationClear: 'Clear Annotations',
    zoomLens:        'Zoom Lens',
    cueCard:         'Cue Cards',
    cueCardNext:     'Next Cue Card',
    cueCardPrev:     'Previous Cue Card',
    recordToggle:    'Record Toggle'
  };

  const failures = [];

  for (const [action, handler] of Object.entries(handlers)) {
    const accel = getAccelerator(action);
    if (!accel) continue;
    registerWithRetry(accel, handler, labels[action] || action);
  }

  // Check after retries complete (give them time)
  setTimeout(() => {
    collectAndNotifyFailures();
    onStatusChange(getStatus());
  }, (MAX_RETRIES + 1) * RETRY_DELAY_MS + 500);
}

/**
 * Register snippet hotkeys (F1–F9).
 * @param {Array} snippets - Array of snippet objects with .text
 * @param {Function} onTrigger - Called with (snippetText) when hotkey fires and autofill is enabled
 * @param {Function} isEnabled - Returns boolean: is autofill feature enabled?
 */
function registerSnippetHotkeys(snippets, onTrigger, isEnabled) {
  // Unregister all previous snippet hotkeys
  for (const key of SNIPPET_KEYS) {
    const accel = `${SNIPPET_ACCEL_PREFIX}${key}`;
    try { globalShortcut.unregister(accel); } catch (_) {}
    registry.delete(accel);
  }

  snippets.slice(0, 9).forEach((snippet, index) => {
    const accel = `${SNIPPET_ACCEL_PREFIX}${SNIPPET_KEYS[index]}`;
    const label = `Snippet ${index + 1} (${snippet.name || 'Untitled'})`;

    registerWithRetry(accel, () => {
      log(`Snippet hotkey fired: ${label} (enabled=${isEnabled()})`);
      if (!isEnabled()) {
        log(`Snippet blocked — autofill is disabled`);
        return;
      }
      onTrigger(snippet.text);
    }, label);
  });

  // Notify after retries settle
  setTimeout(() => {
    collectAndNotifyFailures();
    onStatusChange(getStatus());
  }, (MAX_RETRIES + 1) * RETRY_DELAY_MS + 500);
}

function unregisterAll() {
  log('Unregistering all hotkeys');
  globalShortcut.unregisterAll();
  registry.clear();
}

// ─── Re-register Everything (Phase 2) ───────────────────────────────────────

let _cachedFeatureHandlers = null;
let _cachedSnippets        = null;
let _cachedSnippetTrigger  = null;
let _cachedIsEnabled       = null;

/**
 * Full re-registration — call this after sleep/wake, display changes, etc.
 * Uses the handlers/snippets from the most recent registerFeatureHotkeys /
 * registerSnippetHotkeys calls so callers don't have to track them.
 */
function reregisterAll() {
  log('Re-registering all hotkeys');
  // Unregister first to clear stale state
  globalShortcut.unregisterAll();
  registry.clear();

  if (_cachedFeatureHandlers) {
    registerFeatureHotkeys(_cachedFeatureHandlers);
  }
  if (_cachedSnippets && _cachedSnippetTrigger && _cachedIsEnabled) {
    registerSnippetHotkeys(_cachedSnippets, _cachedSnippetTrigger, _cachedIsEnabled);
  }
}

// Wrap the public register functions to cache arguments for re-registration
const _origRegFeature = registerFeatureHotkeys;
const _origRegSnippet = registerSnippetHotkeys;

// Override exports at bottom to cache

// ─── System Event Listeners (Phase 2a + 2b) ─────────────────────────────────

function setupSystemListeners() {
  if (systemListenersAttached) return;
  systemListenersAttached = true;

  // Phase 2a: sleep/wake
  powerMonitor.on('resume', () => {
    log('System resumed from sleep — re-registering hotkeys');
    reregisterAll();
  });

  // Also handle lock-screen return on macOS
  powerMonitor.on('unlock-screen', () => {
    log('Screen unlocked — re-registering hotkeys');
    reregisterAll();
  });

  log('System event listeners attached (resume, unlock-screen)');
}

// ─── Periodic Health Check (Phase 2c) ────────────────────────────────────────

function startHealthCheck() {
  if (healthInterval) return;

  healthInterval = setInterval(() => {
    checkHealth();
  }, HEALTH_CHECK_MS);

  log(`Health check started (every ${HEALTH_CHECK_MS / 1000}s)`);
}

function stopHealthCheck() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
    log('Health check stopped');
  }
}

function checkHealth() {
  let recoveredCount = 0;
  let failedCount    = 0;

  for (const [accel, entry] of registry) {
    const isAlive = globalShortcut.isRegistered(accel);
    entry.lastCheck = Date.now();

    if (isAlive && entry.registered) {
      // All good
      continue;
    }

    if (!isAlive && entry.registered) {
      // Was registered, now gone — re-register
      log(`Health check: ${entry.label} (${accel}) lost — re-registering`);
      entry.registered = false;

      const ok = registerSingle(accel, entry.callback, entry.label);
      if (ok) {
        recoveredCount++;
        log(`Health check: ${entry.label} (${accel}) recovered`);
      } else {
        failedCount++;
        log(`Health check: ${entry.label} (${accel}) recovery FAILED`);
      }
    }

    if (!isAlive && !entry.registered) {
      // Was already known-failed, try again
      const ok = registerSingle(accel, entry.callback, entry.label);
      if (ok) {
        recoveredCount++;
        log(`Health check: ${entry.label} (${accel}) recovered from prior failure`);
      } else {
        failedCount++;
      }
    }
  }

  if (recoveredCount > 0 || failedCount > 0) {
    log(`Health check complete: ${recoveredCount} recovered, ${failedCount} still failing`);
    onStatusChange(getStatus());
  }

  if (failedCount > 0) {
    collectAndNotifyFailures();
  }
}

// ─── User Notification (Phase 1b) ────────────────────────────────────────────

let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN_MS = 30_000; // Don't spam — max once per 30s

function collectAndNotifyFailures() {
  const failures = [];
  for (const [accel, entry] of registry) {
    if (!entry.registered) {
      failures.push({ accel, label: entry.label, error: entry.error });
    }
  }

  if (failures.length === 0) return;

  const now = Date.now();
  if (now - lastNotificationTime < NOTIFICATION_COOLDOWN_MS) return;
  lastNotificationTime = now;

  const names = failures.map(f => f.label).join(', ');
  const body  = failures.length === 1
    ? `"${failures[0].label}" could not be registered. Another app may be using ${failures[0].accel}.`
    : `${failures.length} hotkeys failed: ${names}. Another app may be using the same shortcuts.`;

  try {
    const notification = new Notification({
      title: 'Demo Assistant — Hotkey Issue',
      body,
      silent: true
    });
    notification.show();
  } catch (e) {
    log(`Notification error: ${e.message}`);
  }
}

// ─── Status Reporting (Phase 3c) ─────────────────────────────────────────────

function getStatus() {
  const entries = [];
  let allHealthy = true;

  for (const [accel, entry] of registry) {
    const healthy = entry.registered && globalShortcut.isRegistered(accel);
    if (!healthy) allHealthy = false;
    entries.push({
      accel,
      label: entry.label,
      healthy,
      error: entry.error,
      lastCheck: entry.lastCheck
    });
  }

  return { allHealthy, entries };
}

function isAllHealthy() {
  return getStatus().allHealthy;
}

// ─── Module Exports ──────────────────────────────────────────────────────────

module.exports = {
  SNIPPET_KEYS,
  DEFAULT_FEATURE_HOTKEYS,

  init,
  loadConfig,
  saveConfig,
  getAccelerator,
  setAccelerator,
  getFeatureHotkeys,
  getDefaultHotkeys,

  // Registration — these wrap the internal functions to cache args
  registerFeatureHotkeys(handlers) {
    _cachedFeatureHandlers = handlers;
    return _origRegFeature(handlers);
  },
  registerSnippetHotkeys(snippets, onTrigger, isEnabled) {
    _cachedSnippets       = snippets;
    _cachedSnippetTrigger = onTrigger;
    _cachedIsEnabled      = isEnabled;
    return _origRegSnippet(snippets, onTrigger, isEnabled);
  },
  unregisterAll,
  reregisterAll,

  setupSystemListeners,
  startHealthCheck,
  stopHealthCheck,
  checkHealth,

  getStatus,
  isAllHealthy,
  log
};
