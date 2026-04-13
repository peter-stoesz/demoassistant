'use strict';

/**
 * autofill.js
 * -----------
 * Pastes snippet text into the currently focused application.
 *
 * Strategy: clipboard write → simulate Cmd+V / Ctrl+V → restore clipboard.
 *
 * CRITICAL INSIGHT (macOS Ventura+):
 * ----------------------------------
 * On modern macOS, child processes (osascript, python, swift) spawned by
 * an Electron app CANNOT send keystrokes — even if the parent app has
 * Accessibility permission.  macOS error 1002: "osascript is not allowed
 * to send keystrokes."
 *
 * The fix: the PRIMARY strategy must use an IN-PROCESS native addon that
 * calls CGEventPost from within the Electron main process.  @jitsi/robotjs
 * does exactly this — it's a NAPI v3 prebuilt universal binary that uses
 * CoreGraphics directly.  We only use it for the single Cmd+V keystroke
 * (not character-by-character typing).
 *
 * Paste strategies (priority order):
 *   macOS:
 *     1. robotjs keyTap — IN-PROCESS CGEvent via native addon (most reliable)
 *     2. Swift CGEventPost — child process, may work on some macOS versions
 *     3. osascript System Events — child process, blocked on Ventura+
 *     4. cliclick — third-party CLI tool (brew install cliclick)
 *
 *   Windows:
 *     1. robotjs keyTap — IN-PROCESS via native addon
 *     2. PowerShell SendKeys
 *     3. PowerShell keybd_event (P/Invoke)
 *
 *   Linux:
 *     1. robotjs keyTap — IN-PROCESS via native addon
 *     2. xdotool
 *     3. xte
 */

const { clipboard, systemPreferences } = require('electron');
const { exec }      = require('child_process');
const path          = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

// How long to wait before restoring the original clipboard (ms).
// Needs to be long enough for the target app to read the clipboard
// after receiving the paste event.  AppleScript menu-click approach
// involves spawning osascript which adds latency.
const CLIPBOARD_RESTORE_MS = 1000;

// How long to wait for modifier keys from the hotkey to be released (ms).
const MODIFIER_RELEASE_DELAY_MS = 400;

// ─── Logging ────────────────────────────────────────────────────────────────

let _logger = null;
function log(level, msg, detail) {
  if (!_logger) {
    try { _logger = require('./appLogger'); } catch (_) {}
  }
  const prefix = '[autofill]';
  if (level === 'error') {
    console.error(prefix, msg, detail || '');
    if (_logger) _logger.error('autofill', msg, detail);
  } else {
    console.log(prefix, msg, detail || '');
    if (_logger) _logger.info('autofill', msg, detail);
  }
}

// ─── robotjs Loader ─────────────────────────────────────────────────────────
//
// We load robotjs ONCE and cache the result.  If it fails to load, we
// log the exact error so the user (or developer) knows why.

let _robot      = undefined;  // undefined = not yet attempted
let _robotError = null;

function getRobot() {
  if (_robot !== undefined) return _robot;

  try {
    _robot = require('@jitsi/robotjs');
    log('info', '@jitsi/robotjs loaded — in-process CGEvent available');

    // Quick sanity check: verify keyTap exists (the only function we need)
    if (typeof _robot.keyTap !== 'function') {
      log('error', 'robotjs loaded but keyTap not available — disabling');
      _robotError = 'loaded but keyTap not found';
      _robot = null;
    } else {
      log('info', 'robotjs sanity check passed (keyTap available)');
    }
  } catch (e) {
    _robotError = e.message;
    _robot = null;

    // Detailed diagnostics for common failure modes
    if (e.message.includes('NODE_MODULE_VERSION')) {
      log('error', 'robotjs: ABI version mismatch — rebuild with electron-rebuild', { error: e.message });
    } else if (e.message.includes('ENOENT') || e.message.includes('Cannot find')) {
      log('error', 'robotjs: native binary not found — check asarUnpack config', { error: e.message });
    } else {
      log('error', 'robotjs: failed to load', { error: e.message });
    }
  }

  return _robot;
}

// ─── Compiled Helper Strategy: paste-helper binary ─────────────────────────
//
// A standalone Swift binary that sends Cmd+V via CGEvent.  It has its own
// code signature and Accessibility permission entry, bypassing the issue
// where macOS won't recognise the Electron dev binary's signature.
//
// The helper is built once with: bash scripts/build-paste-helper.sh

let _pasteHelperPath = null;
let _pasteHelperChecked = false;

function _findPasteHelper() {
  if (_pasteHelperChecked) return _pasteHelperPath;
  _pasteHelperChecked = true;

  const fs = require('fs');
  const os = require('os');
  const candidates = [
    // Well-known fixed location (works for both dev and packaged builds)
    path.join(os.homedir(), '.demo-assistant', 'paste-helper'),
    // Relative to source (dev mode)
    path.join(__dirname, '..', 'scripts', 'paste-helper'),
    path.join(__dirname, '..', '..', 'scripts', 'paste-helper'),
    // Common source locations on user's machine
    path.join(os.homedir(), 'desktop', 'Demo_Assistant_Source_New', 'scripts', 'paste-helper'),
    path.join(os.homedir(), 'Desktop', 'Demo_Assistant_Source_New', 'scripts', 'paste-helper'),
  ];

  // Also check resourcesPath for packaged builds
  try {
    const resourcesPath = process.resourcesPath || '';
    if (resourcesPath) {
      candidates.push(
        path.join(resourcesPath, 'scripts', 'paste-helper'),
        path.join(resourcesPath, 'app.asar.unpacked', 'scripts', 'paste-helper')
      );
    }
  } catch (_) {}

  // Check the app's userData directory
  try {
    const { app } = require('electron');
    if (app) {
      candidates.push(path.join(app.getPath('userData'), 'paste-helper'));
    }
  } catch (_) {}

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        fs.accessSync(p, fs.constants.X_OK);
        _pasteHelperPath = p;
        log('info', `paste-helper found at: ${p}`);
        return p;
      }
    } catch (_) {}
  }

  log('info', 'paste-helper binary not found — run: bash scripts/build-paste-helper.sh');
  log('info', `Searched: ${candidates.join(', ')}`);
  return null;
}

function pasteMac_helper() {
  return new Promise((resolve, reject) => {
    const helperPath = _findPasteHelper();
    if (!helperPath) {
      reject(new Error('paste-helper binary not found. Run: bash scripts/build-paste-helper.sh'));
      return;
    }

    exec(`"${helperPath}" paste`, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr ? stderr.trim() : err.message;
        reject(new Error(`paste-helper: ${detail}`));
      } else {
        resolve('paste-helper');
      }
    });
  });
}

// ─── In-Process Strategy: robotjs keyTap ────────────────────────────────────
//
// Calls CGEventPost (macOS) or SendInput (Windows) from WITHIN the Electron
// process.  Reliable when the Electron binary has Accessibility permission,
// but on dev builds macOS often won't recognise the ad-hoc signature.

function paste_robotjs() {
  return new Promise((resolve, reject) => {
    const rb = getRobot();
    if (!rb) {
      reject(new Error(`robotjs not available: ${_robotError || 'unknown error'}`));
      return;
    }

    try {
      // Ensure Alt/Option is released RIGHT before paste — this is the
      // key modifier that interferes most.  The hotkey Cmd+Alt+<key>
      // means Alt may still be flagged in the CGEvent state even after
      // waitForModifierRelease.
      rb.keyToggle('alt', 'up');

      if (process.platform === 'darwin') {
        rb.keyTap('v', 'command');
      } else {
        rb.keyTap('v', 'control');
      }
      resolve('robotjs');
    } catch (e) {
      reject(new Error(`robotjs keyTap failed: ${e.message}`));
    }
  });
}

// ─── Child-Process Strategies (macOS) ───────────────────────────────────────

/**
 * Swift CGEventPost — compiles and runs inline.
 * CGEventPost at kCGHIDEventTap may work from a child process on some
 * macOS versions even when osascript/System Events is blocked.
 * Swift is pre-installed on macOS (comes with Xcode CLT).
 */
function pasteMac_swiftCGEvent() {
  return new Promise((resolve, reject) => {
    // Swift one-liner: post Cmd+V via CoreGraphics
    const swift = [
      'import Cocoa',
      'let src = CGEventSource(stateID: .hidSystemState)',
      'let down = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true)!',
      'down.flags = .maskCommand',
      'down.post(tap: .cghidEventTap)',
      'usleep(50000)',
      'let up = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false)!',
      'up.flags = .maskCommand',
      'up.post(tap: .cghidEventTap)',
    ].join('; ');

    exec(`swift -e '${swift}'`, { timeout: 10000 }, (err) => {
      if (err) {
        reject(new Error(`Swift CGEvent: ${err.message}`));
      } else {
        resolve('swiftCGEvent');
      }
    });
  });
}

/**
 * osascript Menu Bar "Paste" — tells the frontmost app to click
 * its own Edit → Paste menu item via AXUIElement actions.
 *
 * This is fundamentally different from CGEvent-based approaches:
 * it uses the Accessibility API to interact with the app's menu bar,
 * NOT to synthesize keyboard events.  This means it is NOT subject
 * to the "Sender is prohibited from synthesizing events" restriction.
 *
 * Requires: Automation permission for System Events (macOS auto-prompts).
 */
function pasteMac_menuPaste() {
  return new Promise((resolve, reject) => {
    // Try multiple menu item names to handle localization and variations.
    // "Paste" is standard, but some apps use "Paste and Match Style",
    // "Paste Special", or localized names.
    const script = `
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set appName to name of frontProc
  tell frontProc
    -- Try standard "Paste" menu item first
    try
      click menu item "Paste" of menu "Edit" of menu bar 1
      return "ok"
    end try
    -- Try "Paste" under a menu named "Edit" (some apps vary)
    try
      set editMenu to first menu bar item of menu bar 1 whose name contains "Edit"
      click menu item "Paste" of menu of editMenu
      return "ok"
    end try
    -- Try via menu item whose keyboard shortcut is Cmd+V
    try
      set allMenus to menu bar items of menu bar 1
      repeat with menuBarItem in allMenus
        try
          set menuItems to menu items of menu of menuBarItem
          repeat with mi in menuItems
            if name of mi is "Paste" then
              click mi
              return "ok"
            end if
          end repeat
        end try
      end repeat
    end try
    return "not_found"
  end tell
end tell
`;
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(new Error(`Menu Paste: ${err.message}`));
      } else if (stdout && stdout.trim() === 'not_found') {
        reject(new Error('Menu Paste: could not find Paste menu item in frontmost app'));
      } else {
        resolve('menuPaste');
      }
    });
  });
}

/**
 * osascript System Events — the classic approach.
 * Blocked on macOS Ventura+ (error 1002) unless the specific app
 * (not osascript) has Automation permission for System Events.
 */
function pasteMac_systemEvents() {
  return new Promise((resolve, reject) => {
    exec(
      `osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`,
      { timeout: 3000 },
      (err) => {
        if (err) reject(new Error(`System Events: ${err.message}`));
        else resolve('systemEvents');
      }
    );
  });
}

/**
 * cliclick — third-party CLI tool.
 * brew install cliclick
 */
function pasteMac_cliclick() {
  return new Promise((resolve, reject) => {
    exec('cliclick kd:cmd kp:v ku:cmd', { timeout: 3000 }, (err) => {
      if (err) reject(new Error(`cliclick: ${err.message}`));
      else resolve('cliclick');
    });
  });
}

// ─── Child-Process Strategies (Windows) ─────────────────────────────────────

function pasteWin_sendKeys() {
  return new Promise((resolve, reject) => {
    exec(
      'powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"',
      { timeout: 5000 },
      (err) => {
        if (err) reject(new Error(`SendKeys: ${err.message}`));
        else resolve('sendKeys');
      }
    );
  });
}

function pasteWin_keybdEvent() {
  return new Promise((resolve, reject) => {
    const ps = [
      '$sig = @"',
      '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
      '"@',
      '$t = Add-Type -MemberDefinition $sig -Name WinAPI -Namespace KeySim -PassThru',
      '$t::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)',
      '$t::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)',
      '$t::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)',
      '$t::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)',
    ].join('; ');
    exec(
      `powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { timeout: 5000 },
      (err) => {
        if (err) reject(new Error(`keybdEvent: ${err.message}`));
        else resolve('keybdEvent');
      }
    );
  });
}

// ─── Child-Process Strategies (Linux) ───────────────────────────────────────

function pasteLinux_xdotool() {
  return new Promise((resolve, reject) => {
    exec('xdotool key --clearmodifiers ctrl+v', { timeout: 3000 }, (err) => {
      if (err) reject(new Error(`xdotool: ${err.message}`));
      else resolve('xdotool');
    });
  });
}

function pasteLinux_xte() {
  return new Promise((resolve, reject) => {
    exec('xte "keydown Control_L" "key v" "keyup Control_L"', { timeout: 3000 }, (err) => {
      if (err) reject(new Error(`xte: ${err.message}`));
      else resolve('xte');
    });
  });
}

// ─── Strategy Orchestrator ──────────────────────────────────────────────────

function getPasteStrategies() {
  const platform = process.platform;

  if (platform === 'darwin') {
    return [
      // Menu-click approach uses AXUIElement actions, NOT CGEvent synthesis.
      // This bypasses the "Sender is prohibited from synthesizing events"
      // restriction that blocks CGEvent-based approaches (robotjs, paste-helper).
      { name: 'osascript Menu Paste',            fn: pasteMac_menuPaste },
      { name: 'paste-helper (compiled Swift)',   fn: pasteMac_helper },
      { name: 'robotjs (in-process CGEvent)',    fn: paste_robotjs },
      { name: 'Swift CGEventPost',               fn: pasteMac_swiftCGEvent },
      { name: 'osascript System Events',         fn: pasteMac_systemEvents },
      { name: 'cliclick',                        fn: pasteMac_cliclick },
    ];
  }

  if (platform === 'win32') {
    return [
      { name: 'robotjs (in-process)',   fn: paste_robotjs },
      { name: 'PowerShell SendKeys',    fn: pasteWin_sendKeys },
      { name: 'PowerShell keybdEvent',  fn: pasteWin_keybdEvent },
    ];
  }

  return [
    { name: 'robotjs (in-process)',  fn: paste_robotjs },
    { name: 'xdotool',              fn: pasteLinux_xdotool },
    { name: 'xte',                  fn: pasteLinux_xte },
  ];
}

// Cache the working strategy
let _workingStrategy = null;

async function simulatePaste() {
  const strategies = getPasteStrategies();

  // Try cached strategy first
  if (_workingStrategy) {
    try {
      return await _workingStrategy.fn();
    } catch (e) {
      log('info', `Cached strategy "${_workingStrategy.name}" failed — retrying all`);
      _workingStrategy = null;
    }
  }

  // Try each strategy in order
  const errors = [];
  for (const strategy of strategies) {
    try {
      log('info', `Trying paste strategy: "${strategy.name}"...`);
      const result = await strategy.fn();
      _workingStrategy = strategy;
      log('info', `Paste via "${strategy.name}" succeeded — caching`);
      return result;
    } catch (e) {
      errors.push(`${strategy.name}: ${e.message}`);
      log('info', `"${strategy.name}" failed: ${e.message}`);
    }
  }

  log('error', 'All paste strategies failed', { errors });
  throw new Error(
    `All paste strategies failed:\n${errors.join('\n')}\n\n` +
    'On macOS:\n' +
    '  1. Build the paste helper: bash scripts/build-paste-helper.sh\n' +
    '  2. Add the paste-helper binary to System Settings → Privacy & Security → Accessibility\n' +
    '  OR add the Electron binary to Accessibility and restart.\n' +
    'If robotjs failed with ABI mismatch, run: npx electron-rebuild -f -w @jitsi/robotjs'
  );
}

// ─── Modifier Key Release ───────────────────────────────────────────────────
//
// Uses robotjs to poll modifier state if available, otherwise fixed delay.
// The hotkey (Cmd+Option+<key>) modifiers must be released before we send
// Cmd+V, or the target app receives Cmd+Option+V.

async function waitForModifierRelease() {
  // The snippet hotkey (e.g. Cmd+Alt+B) may still have modifier keys
  // physically held when this runs.  A fixed delay alone doesn't help
  // because CGEvents carry the current modifier flags at send time.
  //
  // Fix: use robotjs keyToggle to explicitly RELEASE all modifiers
  // that could interfere with the Cmd+V paste.  This sends key-up
  // CGEvents that clear the OS-level modifier state even if the
  // physical keys are still momentarily held.
  const rb = getRobot();
  if (rb) {
    try {
      // Release all modifiers that might be held from the hotkey
      rb.keyToggle('alt', 'up');
      rb.keyToggle('command', 'up');
      rb.keyToggle('control', 'up');
      rb.keyToggle('shift', 'up');
      log('info', 'Modifier keys released via robotjs keyToggle');
    } catch (e) {
      log('info', `keyToggle modifier release failed: ${e.message} — using delay fallback`);
    }
  }

  // Still add a small delay to let the OS process the key-up events
  await new Promise(resolve => setTimeout(resolve, 150));
}

// ─── Main Paste Function ────────────────────────────────────────────────────

async function typeText(text) {
  if (!text) {
    log('info', 'typeText: empty text — skipping');
    return;
  }

  log('info', `>>> typeText CALLED (${text.length} chars): "${text.substring(0, 50)}..."`);

  // On macOS, use the natural typing simulation (character-by-character
  // via menu paste with random delays).  Falls back to bulk paste if
  // the typing simulation fails.
  if (process.platform === 'darwin') {
    try {
      await _typeNaturalMac(text);
      log('info', '>>> typeText COMPLETE (natural typing)');
      return;
    } catch (e) {
      log('info', `Natural typing failed: ${e.message} — falling back to bulk paste`);
    }
  }

  // ── Fallback: bulk paste (non-macOS or if natural typing fails) ────
  await _bulkPaste(text);
  log('info', '>>> typeText COMPLETE (bulk paste)');
}

/**
 * Natural typing simulation for macOS.
 * Runs a single osascript that pastes one character at a time via the
 * Edit → Paste menu item with random delays between characters.
 * This looks like natural typing and uses AXUIElement actions (not CGEvent).
 */
async function _typeNaturalMac(text) {
  // Save clipboard
  let prev = '';
  try { prev = clipboard.readText(); } catch (_) {}

  // Wait for modifier release
  await waitForModifierRelease();

  // Escape the text for AppleScript — handle special characters
  const escapedText = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  // Build an AppleScript that types character by character with random delays.
  // Each character is set on the clipboard and pasted via the menu item.
  // Random delays between 30ms and 120ms simulate natural typing speed.
  const script = `
set theText to "${escapedText}"
set charList to every character of theText

tell application "System Events"
  set frontProc to first application process whose frontmost is true

  -- Find the Paste menu item once
  set pasteItem to missing value
  try
    set pasteItem to menu item "Paste" of menu "Edit" of menu bar 1 of frontProc
  end try

  if pasteItem is missing value then
    -- Try finding Edit menu by searching
    try
      set menuItems to menu bar items of menu bar 1 of frontProc
      repeat with mbi in menuItems
        try
          set mi to menu item "Paste" of menu of mbi
          set pasteItem to mi
          exit repeat
        end try
      end repeat
    end try
  end if

  if pasteItem is missing value then
    error "Could not find Paste menu item"
  end if

  -- Type each character
  repeat with ch in charList
    set chText to (ch as text)

    -- Handle newlines: press Return key instead of pasting
    if chText is "\\n" or chText is return then
      -- Use key code 36 for Return via menu-safe approach
      set the clipboard to return
      click pasteItem
    else
      set the clipboard to chText
      click pasteItem
    end if

    -- Random delay between 30ms and 120ms for natural feel
    delay (random number from 0.03 to 0.12)
  end repeat
end tell
`;

  return new Promise((resolve, reject) => {
    log('info', `Natural typing: ${text.length} chars via menu paste...`);
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: Math.max(15000, text.length * 200) // scale timeout with text length
    }, (err, stdout, stderr) => {
      // Restore clipboard regardless of outcome
      try { clipboard.writeText(prev); } catch (_) {}

      if (err) {
        reject(new Error(`Natural typing: ${stderr || err.message}`));
      } else {
        log('info', 'Natural typing complete');
        resolve('naturalTyping');
      }
    });
  });
}

/**
 * Bulk paste fallback — writes text to clipboard and pastes all at once.
 */
async function _bulkPaste(text) {
  // 1. Save clipboard
  let prev = '';
  try { prev = clipboard.readText(); } catch (_) {}

  // 2. Write snippet to clipboard
  try {
    clipboard.writeText(text);
  } catch (e) {
    log('error', 'Clipboard write failed', { error: e.message });
    throw e;
  }

  // 3. Wait for modifier release
  await waitForModifierRelease();

  // 4. Simulate Cmd+V / Ctrl+V
  try {
    const strategy = await simulatePaste();
    log('info', `Bulk paste via "${strategy}"`);
  } catch (e) {
    log('error', 'All paste strategies failed', { error: e.message });
  }

  // 5. Wait for target app to process
  await new Promise(resolve => setTimeout(resolve, CLIPBOARD_RESTORE_MS));

  // 6. Restore clipboard
  try { clipboard.writeText(prev); } catch (_) {}
}

// ─── Queue ──────────────────────────────────────────────────────────────────

let isTyping = false;
const typeQueue = [];
let pasteCount = 0;
let errorCount = 0;

function enqueueTyping(text) {
  typeQueue.push(text);
  if (!isTyping) processQueue();
}

async function processQueue() {
  if (typeQueue.length === 0) {
    isTyping = false;
    return;
  }
  isTyping = true;
  const text = typeQueue.shift();

  try {
    await typeText(text);
    pasteCount++;
  } catch (e) {
    errorCount++;
    log('error', 'Queue paste failed', { error: e.message });
  }

  processQueue();
}

function getTypingStats() {
  return {
    pasteCount,
    errorCount,
    queueLength: typeQueue.length,
    isTyping,
    robotLoaded: _robot !== null && _robot !== undefined,
    robotError: _robotError,
    workingStrategy: _workingStrategy ? _workingStrategy.name : 'none (untested)',
  };
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

async function testStrategies() {
  const results = [];
  const strategies = getPasteStrategies();

  for (const strategy of strategies) {
    if (strategy.name.includes('robotjs')) {
      const rb = getRobot();
      results.push({
        name: strategy.name,
        available: rb !== null,
        error: rb ? null : (_robotError || 'not loaded'),
      });
    } else {
      // Check if the external tool exists
      const toolChecks = {
        'paste-helper (compiled Swift)': _findPasteHelper() ? `test -x "${_findPasteHelper()}"` : 'false',
        'osascript Menu Paste':    'which osascript',
        'Swift CGEventPost':       'which swift',
        'osascript System Events': 'which osascript',
        'cliclick':                'which cliclick',
        'PowerShell SendKeys':     process.platform === 'win32' ? 'where powershell' : 'false',
        'PowerShell keybdEvent':   process.platform === 'win32' ? 'where powershell' : 'false',
        'xdotool':                 'which xdotool',
        'xte':                     'which xte',
      };
      const cmd = toolChecks[strategy.name] || 'false';
      try {
        await new Promise((resolve, reject) => {
          exec(cmd, { timeout: 2000 }, (err) => err ? reject(err) : resolve());
        });
        results.push({ name: strategy.name, available: true, error: null });
      } catch (e) {
        results.push({ name: strategy.name, available: false, error: e.message });
      }
    }
  }

  return results;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  typeText,
  enqueueTyping,
  getTypingStats,
  testStrategies,
  waitForModifierRelease,
};
