'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, screen, Menu, desktopCapturer, systemPreferences, dialog } = require('electron');
const opportunityStore  = require('./opportunityStore');
const csvImporter       = require('./csvImporter');
const recordingManager  = require('./recordingManager');
const audioCapture      = require('./audioCapture');
const transcriptStore   = require('./transcriptStore');
const TranscriptionQueue = require('./transcription/queue');
const WhisperProvider      = require('./transcription/whisperProvider');
const transcriptionConfig  = require('./transcriptionConfig');
const memoryMonitor        = require('./memoryMonitor');
const appLogger            = require('./appLogger');
const path = require('path');
const fs   = require('fs');

// ─── Window references ────────────────────────────────────────────────────────

let overlayWindows       = [];
let snippetManagerWindow = null;
let recordingModalWindow = null;
let tray                 = null;
let transcriptionQueue   = null;

// ─── Feature toggle state ─────────────────────────────────────────────────────

const featureState = {
  sonarEnabled:            true,
  selectionBoxEnabled:     true,
  autofillEnabled:         true,
  cursorHighlightEnabled:  false,
  spotlightEnabled:        false,
  freezeFrameEnabled:      false,
  annotationEnabled:       true,
  zoomLensEnabled:         true,
  cueCardEnabled:          true,
  recordingEnabled:        true
};

// ─── Paths ────────────────────────────────────────────────────────────────────

const userDataPath = app.getPath('userData');
const snippetsFile = path.join(userDataPath, 'snippets.json');

// ─── Hotkey Manager (Phases 1–3, 5a) ─────────────────────────────────────────

const hotkeyManager = require('./hotkeyManager');

// ─── Default snippets ─────────────────────────────────────────────────────────

const DEFAULT_SNIPPETS = [
  { id: 1, name: 'greeting',   text: "Hi, my name is Peter and I'm here to help." },
  { id: 2, name: 'closing',    text: 'Thank you for your time today. Let me know if you have any questions.' },
  { id: 3, name: 'demo_intro', text: 'Let me walk you through this feature step by step.' },
  { id: 4, name: 'follow_up',  text: "I'll send you a follow-up email with all the details we discussed." },
  { id: 5, name: 'support',    text: 'Our support team is available 24/7 at support@example.com.' }
];

// ─── Snippets I/O ─────────────────────────────────────────────────────────────

function loadSnippets() {
  try {
    if (fs.existsSync(snippetsFile)) {
      const raw = fs.readFileSync(snippetsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.error('[main] Failed to load snippets:', e.message);
  }
  saveSnippets(DEFAULT_SNIPPETS);
  return DEFAULT_SNIPPETS;
}

function saveSnippets(snippets) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(snippetsFile, JSON.stringify(snippets, null, 2), 'utf8');
  } catch (e) {
    console.error('[main] Failed to save snippets:', e.message);
  }
}

// ─── Overlay Windows (one per display) ────────────────────────────────────────

function createOverlayForDisplay(display) {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x, y, width, height,
    transparent:    true,
    frame:          false,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    resizable:      false,
    movable:        false,
    focusable:      false,
    hasShadow:      false,
    roundedCorners: false,
    type:           process.platform === 'linux' ? 'dock' : undefined,
    webPreferences: {
      nodeIntegration:      false,
      contextIsolation:     true,
      preload:              path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      devTools:             process.env.NODE_ENV === 'development'
    }
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'overlay.html'));
  win._displayId = display.id;

  win.on('closed', () => {
    overlayWindows = overlayWindows.filter(w => w !== win);
  });

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

function createAllOverlays() {
  overlayWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  overlayWindows = [];

  const displays = screen.getAllDisplays();
  for (const display of displays) {
    overlayWindows.push(createOverlayForDisplay(display));
  }
}

function repositionOverlays() {
  createAllOverlays();

  // Phase 2b: re-register hotkeys on display changes
  hotkeyManager.log('Display configuration changed — re-registering hotkeys');
  hotkeyManager.reregisterAll();
}

// ─── Overlay communication helpers ────────────────────────────────────────────

function broadcastToOverlays(channel, data) {
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

function setOverlaysInteractive(interactive) {
  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    if (interactive) {
      win.setIgnoreMouseEvents(false);
      win.setFocusable(true);
      win.show();
      win.focus();
      if (process.platform === 'darwin') {
        win.moveTop();
      }
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setFocusable(false);
    }
  }
}

// ─── Sonar Blip (hotkey-triggered) ────────────────────────────────────────────

function fireSonarAtCursor() {
  if (!featureState.sonarEnabled) return;

  const pos = screen.getCursorScreenPoint();

  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    const bounds = win.getBounds();
    if (pos.x >= bounds.x && pos.x < bounds.x + bounds.width &&
        pos.y >= bounds.y && pos.y < bounds.y + bounds.height) {
      win.webContents.send('sonar-blip', {
        x: pos.x - bounds.x,
        y: pos.y - bounds.y
      });
      break;
    }
  }
}

// ─── Selection Box (hotkey-triggered) ─────────────────────────────────────────
//
// Flow:
//   1. User presses Ctrl+Shift+D → enterSelectionMode()
//   2. Overlays become interactive, renderer gets 'selection-mode-enter'
//   3. User drags a rectangle, releases mouse
//   4. Renderer sends 'selection-complete' IPC → main calls returnToClickThrough()
//   5. Overlays go back to click-through, ready for next use
//
// The renderer handles its own cleanup. The main process just toggles
// the window interactivity. No 'selection-mode-exit' broadcast is sent
// on normal completion to avoid a feedback loop.

let selectionModeActive = false;

function enterSelectionMode() {
  if (!featureState.selectionBoxEnabled) return;

  // If already active, cancel it
  if (selectionModeActive) {
    forceExitSelectionMode();
    return;
  }

  // Cancel annotation mode if active (mutually exclusive)
  if (annotationModeActive) {
    exitAnnotationMode();
  }

  selectionModeActive = true;
  setOverlaysInteractive(true);

  // Delay to let macOS fully activate the window
  setTimeout(() => {
    broadcastToOverlays('selection-mode-enter', {});
  }, 100);
}

// Called when the renderer finishes a drag (normal completion)
function returnToClickThrough() {
  selectionModeActive = false;
  setOverlaysInteractive(false);
  // Do NOT broadcast 'selection-mode-exit' here — the renderer
  // already cleaned up on its own before sending 'selection-complete'
}

// Called when user presses the hotkey again to cancel, or from tray
function forceExitSelectionMode() {
  selectionModeActive = false;
  setOverlaysInteractive(false);
  broadcastToOverlays('selection-mode-exit', {});
}

// ─── Spotlight Toggle (Sprint 1 — Task 1.3) ──────────────────────────────────

function toggleSpotlight() {
  featureState.spotlightEnabled = !featureState.spotlightEnabled;
  broadcastFeatureToggle('spotlightEnabled');
  rebuildTrayMenu();
}

// ─── Freeze Frame (Sprint 1 — Tasks 1.5 + 1.6) ─────────────────────────────

let freezeFrameActive = false;

async function toggleFreezeFrame() {
  if (freezeFrameActive) {
    // Release freeze
    freezeFrameActive = false;
    featureState.freezeFrameEnabled = false;
    broadcastFeatureToggle('freezeFrameEnabled');
    broadcastToOverlays('freeze-frame-release', {});
    rebuildTrayMenu();
    return;
  }

  // Capture the screen for each display
  try {
    // Get the largest display dimension to request adequate thumbnail size
    const displays = screen.getAllDisplays();
    const maxWidth  = Math.max(...displays.map(d => d.size.width * (d.scaleFactor || 1)));
    const maxHeight = Math.max(...displays.map(d => d.size.height * (d.scaleFactor || 1)));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxWidth, height: maxHeight }
    });

    // Match each source to an overlay window by display_id
    for (const win of overlayWindows) {
      if (win.isDestroyed()) continue;

      // Try to find a matching source for this overlay's display
      const displayId = win._displayId;
      let matchedSource = sources.find(s => s.display_id === String(displayId));

      // Fallback: if only one source (single monitor), use it
      if (!matchedSource && sources.length === 1) {
        matchedSource = sources[0];
      }

      if (matchedSource && !matchedSource.thumbnail.isEmpty()) {
        const imageDataURL = matchedSource.thumbnail.toDataURL();
        win.webContents.send('freeze-frame-capture', { imageDataURL });
      } else {
        console.warn(`[main] No capture source found for display ${displayId}`);
      }
    }

    freezeFrameActive = true;
    featureState.freezeFrameEnabled = true;
    broadcastFeatureToggle('freezeFrameEnabled');
    rebuildTrayMenu();

  } catch (e) {
    console.error('[main] Freeze frame capture failed:', e.message);
    // If screen capture fails (e.g. no permission), notify user
    try {
      const { Notification } = require('electron');
      const n = new Notification({
        title: 'Demo Assistant — Freeze Frame Error',
        body: 'Screen capture failed. On macOS, grant Screen Recording permission in System Settings > Privacy & Security.',
        silent: true
      });
      n.show();
    } catch (_) {}
  }
}

// ─── Annotation Mode (Sprint 2) ──────────────────────────────────────────────
//
// Flow is similar to selection mode but the overlay stays interactive until
// the user presses the hotkey again or Escape.  Annotation mode and selection
// mode are mutually exclusive — entering one cancels the other.

let annotationModeActive = false;

function toggleAnnotationMode() {
  if (!featureState.annotationEnabled) return;

  if (annotationModeActive) {
    exitAnnotationMode();
  } else {
    enterAnnotationMode();
  }
}

function enterAnnotationMode() {
  // Cancel selection mode if active (mutually exclusive)
  if (selectionModeActive) {
    forceExitSelectionMode();
  }

  annotationModeActive = true;
  setOverlaysInteractive(true);

  setTimeout(() => {
    broadcastToOverlays('annotation-mode-enter', {});
  }, 100);
}

function exitAnnotationMode() {
  annotationModeActive = false;
  setOverlaysInteractive(false);
  broadcastToOverlays('annotation-mode-exit', {});
}

function clearAllAnnotations() {
  broadcastToOverlays('annotation-clear', {});
}

function undoLastAnnotation() {
  broadcastToOverlays('annotation-undo', {});
}

// ─── Recording Toggle (Transcription Sprint 2) ──────────────────────────────
//
// Flow:
//   1. User presses record hotkey → toggleRecording()
//   2. If IDLE → show recording modal (opportunity picker)
//   3. User selects opportunity → confirmAndRecord → startCapture
//   4. User presses hotkey again → stopRecording → stopCapture → save → enqueue transcription
//
// The recording modal is a separate small BrowserWindow.

function toggleRecording() {
  if (!featureState.recordingEnabled) return;

  const state = recordingManager.getState();

  if (state.state === 'RECORDING') {
    // Stop recording
    stopRecordingFlow();
  } else if (state.state === 'IDLE') {
    // Start recording flow — show opportunity picker
    if (recordingManager.startRecordingFlow()) {
      showRecordingModal();
    }
  } else if (state.state === 'PROMPTING') {
    // Cancel the modal
    recordingManager.cancelRecording();
    closeRecordingModal();
  }
}

function showRecordingModal() {
  if (recordingModalWindow && !recordingModalWindow.isDestroyed()) {
    recordingModalWindow.focus();
    return;
  }

  recordingModalWindow = new BrowserWindow({
    width: 500,
    height: 340,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'recordingModalPreload.js')
    }
  });

  recordingModalWindow.loadFile(path.join(__dirname, 'recordingModal.html'));

  recordingModalWindow.on('closed', () => {
    recordingModalWindow = null;
    // If still in PROMPTING state, cancel
    if (recordingManager.getState().state === 'PROMPTING') {
      recordingManager.cancelRecording();
    }
  });
}

function closeRecordingModal() {
  if (recordingModalWindow && !recordingModalWindow.isDestroyed()) {
    recordingModalWindow.close();
    recordingModalWindow = null;
  }
}

async function startRecordingWithOpportunity(opportunityId) {
  closeRecordingModal();

  // Normalise quick-record sentinel to null
  if (opportunityId === '__quick__') opportunityId = null;

  // Sprint 6 — disk space check before recording
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const output = execSync(`df -k "${userDataPath}"`).toString();
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const availableKB = parseInt(lines[1].split(/\s+/)[3], 10);
        if (availableKB < 512000) { // < 500 MB
          const { Notification: N } = require('electron');
          const n = new N({
            title: 'Demo Assistant — Low Disk Space',
            body: `Only ${Math.round(availableKB / 1024)} MB available. Recording may fail if disk fills up.`,
            silent: false
          });
          n.show();
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  // macOS: check screen recording permission before attempting capture
  if (process.platform === 'darwin') {
    try {
      const { systemPreferences } = require('electron');
      const screenAccess = systemPreferences.getMediaAccessStatus('screen');
      console.log('[main] Screen recording permission:', screenAccess);
      if (screenAccess !== 'granted') {
        const { Notification: N, shell } = require('electron');
        const n = new N({
          title: 'Demo Assistant — Screen Permission Required',
          body: 'Please grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording, then restart the app.',
          silent: false
        });
        n.on('click', () => {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        });
        n.show();
        // Also send error to snippet manager
        if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
          snippetManagerWindow.webContents.send('recording-error', {
            message: 'Screen Recording permission not granted. Open System Settings → Privacy & Security → Screen Recording.'
          });
        }
        recordingManager.cancelRecording();
        broadcastRecordingState();
        return;
      }
    } catch (permErr) {
      console.warn('[main] Could not check screen permission:', permErr.message);
    }
  }

  const result = recordingManager.confirmAndRecord(opportunityId);
  if (!result) return;

  const filePath = path.join(recordingManager.getRecordingsDir(), result.filename);
  audioCapture.setTargetFile(filePath);

  try {
    await audioCapture.startCapture();
    console.log('[main] Audio capture started for:', result.recordingId);
    appLogger.success('recording', 'Recording started', { recordingId: result.recordingId, opportunityId });

    // S1-5: Start memory-pressure monitor during recording
    memoryMonitor.start({
      onWarning: (memInfo) => {
        try {
          const { Notification } = require('electron');
          const n = new Notification({
            title: 'Demo Assistant — High Memory Usage',
            body: `Process is using ${memInfo.processRssMB} MB (${memInfo.usagePercent}% of system RAM). Consider stopping the recording soon.`,
            silent: false
          });
          n.show();
        } catch (_) {}
        // Also notify snippet manager UI via IPC for toast display
        if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
          snippetManagerWindow.webContents.send('memory-warning', memInfo);
        }
      }
    });

    // Broadcast recording state to overlays for REC badge
    broadcastRecordingState();
    rebuildTrayMenu();

    // Start a timer to broadcast duration updates
    recordingManager._broadcastInterval = setInterval(() => {
      broadcastRecordingState();
    }, 1000);
  } catch (err) {
    console.error('[main] Failed to start audio capture:', err.message);
    appLogger.error('recording', 'Failed to start capture', { error: err.message });
    recordingManager.cancelRecording();
    broadcastRecordingState();

    // Send error to snippet manager UI
    if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
      snippetManagerWindow.webContents.send('recording-error', {
        message: `Failed to start recording: ${err.message}`
      });
    }

    try {
      const { Notification } = require('electron');
      const n = new Notification({
        title: 'Demo Assistant — Recording Error',
        body: `Failed to start recording: ${err.message}`,
        silent: true
      });
      n.show();
    } catch (_) {}
  }
}

async function stopRecordingFlow() {
  const stopResult = recordingManager.stopRecording();
  if (!stopResult) return;

  appLogger.info('recording', 'Recording stopped', {
    recordingId: stopResult.recordingId,
    duration: stopResult.duration,
    filename: stopResult.filename
  });

  // S1-5: Stop memory-pressure monitor
  memoryMonitor.stop();

  // Clear broadcast interval
  if (recordingManager._broadcastInterval) {
    clearInterval(recordingManager._broadcastInterval);
    recordingManager._broadcastInterval = null;
  }

  try {
    const captureResult = await audioCapture.stopCapture();
    console.log('[main] Capture stopped, WebM file:', captureResult.filePath);

    recordingManager.onRecordingFileSaved(captureResult.filePath);

    // Broadcast state change
    broadcastRecordingState();
    rebuildTrayMenu();

    // Post-processing: convert WebM → MP4 (video) + WAV (audio for Whisper)
    let wavFilePath = null;
    try {
      const converted = await audioCapture.convertToOutputFormats(captureResult.filePath);
      if (converted.mp4Path) {
        console.log('[main] MP4 output ready:', converted.mp4Path);
      }
      if (converted.wavPath) {
        console.log('[main] WAV output ready:', converted.wavPath);
        wavFilePath = converted.wavPath;
      }
      appLogger.success('recording', 'Post-processing complete', {
        mp4: !!converted.mp4Path,
        wav: !!converted.wavPath
      });
    } catch (convErr) {
      console.error('[main] Post-processing failed:', convErr.message);
      appLogger.error('recording', 'Post-processing failed', { error: convErr.message });
    }

    // Create transcript entry and enqueue transcription if auto-transcribe is on
    const entry = transcriptStore.createTranscriptEntry({
      opportunityId: stopResult.opportunityId,
      audioFilename: stopResult.filename
    });

    const shouldTranscribe = transcriptionConfig.get('autoTranscribe') !== false;
    if (shouldTranscribe && transcriptionQueue) {
      // Check if the audio file actually exists before enqueuing
      const transcriptionFile = wavFilePath || captureResult.filePath;
      if (!fs.existsSync(transcriptionFile)) {
        console.error('[main] Transcription file does not exist:', transcriptionFile);
        appLogger.error('transcription', 'Audio file missing for transcription', { path: transcriptionFile });
        if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
          snippetManagerWindow.webContents.send('recording-error', {
            message: 'Recording file not found for transcription. Check disk space and permissions.'
          });
        }
      } else {
        transcriptionQueue.enqueue({
          transcriptId: entry.id,
          audioFilePath: transcriptionFile,
          opportunityId: stopResult.opportunityId,
          options: {}
        });
        console.log('[main] Transcription enqueued using:', transcriptionFile);
      }
    } else {
      console.log('[main] Auto-transcribe disabled — audio saved but not queued');
    }

    // Transition to IDLE
    recordingManager.onProcessingComplete();
    broadcastRecordingState();
    rebuildTrayMenu();

    try {
      const { Notification } = require('electron');
      const parts = [];
      parts.push(`Recording saved (${stopResult.duration}s)`);
      if (wavFilePath) parts.push('WAV + MP4 exported');
      parts.push('Transcription queued');
      const n = new Notification({
        title: 'Demo Assistant — Recording Saved',
        body: parts.join('. ') + '.',
        silent: true
      });
      n.show();
    } catch (_) {}
  } catch (err) {
    console.error('[main] Failed to stop recording:', err.message);
    recordingManager.onProcessingComplete();
    broadcastRecordingState();
    rebuildTrayMenu();
  }
}

function broadcastRecordingState() {
  const state = recordingManager.getState();
  broadcastToOverlays('recording-state-changed', state);
  // Also notify snippet manager if open
  if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
    snippetManagerWindow.webContents.send('recording-state-changed', state);
  }
}

// ─── Zoom Lens (Sprint 3 — Tasks 3.2 + 3.3) ─────────────────────────────────
//
// A floating panel that magnifies a region around the cursor.
// Uses desktopCapturer to grab frames at ~10 FPS.  The panel follows
// the cursor with an 80px offset and flips sides near screen edges.

const { createFloatingPanel, clampToScreen } = require('./floatingPanel');

let zoomLensWindow   = null;
let zoomLensActive   = false;
let zoomLensInterval = null;
let zoomMagnification = 2.0;

const ZOOM_CAPTURE_FPS     = 10;
const ZOOM_CAPTURE_REGION  = 200;    // px around cursor to capture (at 1x)
const ZOOM_PANEL_WIDTH     = 300;
const ZOOM_PANEL_HEIGHT    = 220;
const ZOOM_CURSOR_OFFSET   = 80;     // px offset from cursor
const ZOOM_MIN_MAG         = 1.5;
const ZOOM_MAX_MAG         = 4.0;
const ZOOM_MAG_STEP        = 0.25;

function toggleZoomLens() {
  if (!featureState.zoomLensEnabled) return;

  if (zoomLensActive) {
    deactivateZoomLens();
  } else {
    activateZoomLens();
  }
}

function activateZoomLens() {
  if (zoomLensWindow && !zoomLensWindow.isDestroyed()) {
    zoomLensWindow.show();
  } else {
    zoomLensWindow = createFloatingPanel({
      width:       ZOOM_PANEL_WIDTH,
      height:      ZOOM_PANEL_HEIGHT,
      htmlFile:    path.join(__dirname, 'zoomLens.html'),
      preloadFile: path.join(__dirname, 'zoomLensPreload.js'),
      anchor:      'cursor',
      focusable:   false
    });

    zoomLensWindow.on('closed', () => {
      zoomLensWindow = null;
      deactivateZoomLens();
    });
  }

  zoomLensActive = true;

  // Start capture loop
  if (zoomLensInterval) clearInterval(zoomLensInterval);
  zoomLensInterval = setInterval(captureZoomFrame, 1000 / ZOOM_CAPTURE_FPS);

  // Send initial magnification
  if (zoomLensWindow && !zoomLensWindow.isDestroyed()) {
    zoomLensWindow.webContents.send('zoom-lens-magnification', { magnification: zoomMagnification });
  }
}

function deactivateZoomLens() {
  zoomLensActive = false;

  if (zoomLensInterval) {
    clearInterval(zoomLensInterval);
    zoomLensInterval = null;
  }

  if (zoomLensWindow && !zoomLensWindow.isDestroyed()) {
    zoomLensWindow.hide();
  }
}

async function captureZoomFrame() {
  if (!zoomLensActive || !zoomLensWindow || zoomLensWindow.isDestroyed()) return;

  const cursorPos = screen.getCursorScreenPoint();
  const display   = screen.getDisplayNearestPoint(cursorPos);
  const scaleFactor = display.scaleFactor || 1;

  // Position the lens panel near the cursor with edge-flip
  positionZoomLensNearCursor(cursorPos, display);

  try {
    // Capture the screen (use 1x resolution for performance on HiDPI)
    const captureWidth  = Math.round(display.size.width);
    const captureHeight = Math.round(display.size.height);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: captureWidth, height: captureHeight }
    });

    // Find the source for this display, exclude the zoom lens window itself
    let source = sources.find(s => s.display_id === String(display.id));
    if (!source && sources.length === 1) {
      source = sources[0];
    }

    if (!source || source.thumbnail.isEmpty()) return;

    // Crop the region around the cursor
    const thumbnail = source.thumbnail;
    const thumbSize = thumbnail.getSize();

    // Map cursor position to thumbnail coordinates
    const relX = cursorPos.x - display.bounds.x;
    const relY = cursorPos.y - display.bounds.y;
    const tScale = thumbSize.width / display.size.width;

    const halfRegion = Math.round((ZOOM_CAPTURE_REGION / zoomMagnification) * tScale);
    const cx = Math.round(relX * tScale);
    const cy = Math.round(relY * tScale);

    const cropX = Math.max(0, cx - halfRegion);
    const cropY = Math.max(0, cy - halfRegion);
    const cropW = Math.min(halfRegion * 2, thumbSize.width - cropX);
    const cropH = Math.min(halfRegion * 2, thumbSize.height - cropY);

    if (cropW < 4 || cropH < 4) return;

    const cropped = thumbnail.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
    const dataURL = cropped.toDataURL();

    if (zoomLensWindow && !zoomLensWindow.isDestroyed()) {
      zoomLensWindow.webContents.send('zoom-lens-frame', { imageDataURL: dataURL });
    }
  } catch (e) {
    // Silently fail — screen capture can be flaky
  }
}

function positionZoomLensNearCursor(cursorPos, display) {
  if (!zoomLensWindow || zoomLensWindow.isDestroyed()) return;

  const wa = display.workArea;

  // Default: offset to the right and below
  let x = cursorPos.x + ZOOM_CURSOR_OFFSET;
  let y = cursorPos.y + ZOOM_CURSOR_OFFSET;

  // Flip horizontally if near right edge
  if (x + ZOOM_PANEL_WIDTH > wa.x + wa.width) {
    x = cursorPos.x - ZOOM_CURSOR_OFFSET - ZOOM_PANEL_WIDTH;
  }

  // Flip vertically if near bottom edge
  if (y + ZOOM_PANEL_HEIGHT > wa.y + wa.height) {
    y = cursorPos.y - ZOOM_CURSOR_OFFSET - ZOOM_PANEL_HEIGHT;
  }

  // Clamp to work area
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - ZOOM_PANEL_WIDTH));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - ZOOM_PANEL_HEIGHT));

  zoomLensWindow.setPosition(Math.round(x), Math.round(y));
}

function adjustZoomMagnification(delta) {
  if (!zoomLensActive) return;

  zoomMagnification = Math.max(ZOOM_MIN_MAG, Math.min(ZOOM_MAX_MAG, zoomMagnification + delta));

  if (zoomLensWindow && !zoomLensWindow.isDestroyed()) {
    zoomLensWindow.webContents.send('zoom-lens-magnification', { magnification: zoomMagnification });
  }
}

// ─── Cue Card Overlay (Sprint 3 — Tasks 3.4–3.7) ────────────────────────────
//
// A small floating panel that shows presenter-only talking points.
// Cards are stored in cuecards.json with named sets.

let cueCardWindow  = null;
let cueCardActive  = false;
let cueCardData    = null;   // full { activeSet, sets } object
let cueCardIndex   = 0;

const CUE_CARD_WIDTH  = 280;
const CUE_CARD_HEIGHT = 200;

const cueCardsFile = path.join(userDataPath, 'cuecards.json');

function loadCueCards() {
  try {
    if (fs.existsSync(cueCardsFile)) {
      const raw    = fs.readFileSync(cueCardsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sets && typeof parsed.sets === 'object') {
        return parsed;
      }
    }
  } catch (e) {
    console.error('[main] Failed to load cue cards:', e.message);
  }

  // Load defaults from bundled file
  const defaultPath = path.join(__dirname, 'cueCards.json');
  try {
    const raw = fs.readFileSync(defaultPath, 'utf8');
    const defaults = JSON.parse(raw);
    saveCueCards(defaults);
    return defaults;
  } catch (e) {
    const fallback = { activeSet: 'Default', sets: { Default: [] } };
    saveCueCards(fallback);
    return fallback;
  }
}

function saveCueCards(data) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(cueCardsFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[main] Failed to save cue cards:', e.message);
  }
}

function getActiveCueCards() {
  if (!cueCardData) cueCardData = loadCueCards();
  const setName = cueCardData.activeSet || Object.keys(cueCardData.sets)[0] || 'Default';
  return { cards: cueCardData.sets[setName] || [], setName };
}

function toggleCueCards() {
  if (!featureState.cueCardEnabled) return;

  if (cueCardActive) {
    deactivateCueCards();
  } else {
    activateCueCards();
  }
}

function activateCueCards() {
  if (!cueCardData) cueCardData = loadCueCards();

  if (cueCardWindow && !cueCardWindow.isDestroyed()) {
    cueCardWindow.show();
  } else {
    cueCardWindow = createFloatingPanel({
      width:       CUE_CARD_WIDTH,
      height:      CUE_CARD_HEIGHT,
      htmlFile:    path.join(__dirname, 'cueCard.html'),
      preloadFile: path.join(__dirname, 'cueCardPreload.js'),
      anchor:      'bottom-right',
      focusable:   true
    });

    cueCardWindow.on('closed', () => {
      cueCardWindow = null;
      cueCardActive = false;
    });
  }

  cueCardActive = true;
  cueCardIndex  = 0;

  // Send initial cards once the renderer is ready
  cueCardWindow.webContents.once('did-finish-load', () => {
    sendCueCardsToRenderer();
  });

  // Also send immediately in case already loaded
  if (cueCardWindow.webContents.isLoading()) {
    // wait for did-finish-load above
  } else {
    sendCueCardsToRenderer();
  }
}

function deactivateCueCards() {
  cueCardActive = false;
  if (cueCardWindow && !cueCardWindow.isDestroyed()) {
    cueCardWindow.hide();
  }
}

function sendCueCardsToRenderer() {
  if (!cueCardWindow || cueCardWindow.isDestroyed()) return;
  const { cards, setName } = getActiveCueCards();
  cueCardWindow.webContents.send('cue-cards-loaded', { cards, setName, index: cueCardIndex });
}

function navigateCueCard(direction) {
  if (!cueCardActive || !cueCardWindow || cueCardWindow.isDestroyed()) return;
  cueCardWindow.webContents.send('cue-card-navigate', { direction });

  // Track index locally
  const { cards } = getActiveCueCards();
  if (direction === 'next' && cueCardIndex < cards.length - 1) cueCardIndex++;
  if (direction === 'prev' && cueCardIndex > 0) cueCardIndex--;
}

function switchCueCardSet(setName) {
  if (!cueCardData) cueCardData = loadCueCards();
  if (!cueCardData.sets[setName]) return;

  cueCardData.activeSet = setName;
  saveCueCards(cueCardData);
  cueCardIndex = 0;

  if (cueCardWindow && !cueCardWindow.isDestroyed()) {
    const cards = cueCardData.sets[setName] || [];
    cueCardWindow.webContents.send('cue-card-set-changed', { cards, setName });
  }
}

// ─── Snippet Manager Window ───────────────────────────────────────────────────

function createSnippetManagerWindow() {
  if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
    snippetManagerWindow.focus();
    return;
  }

  snippetManagerWindow = new BrowserWindow({
    width:      700,
    height:     580,
    minWidth:   520,
    minHeight:  420,
    title:      'Demo Assistant — Snippet Manager',
    center:     true,
    resizable:  true,
    frame:      true,
    show:       false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
      devTools:         true
    }
  });

  Menu.setApplicationMenu(null);
  snippetManagerWindow.loadFile(path.join(__dirname, 'snippetManager.html'));

  snippetManagerWindow.once('ready-to-show', () => {
    snippetManagerWindow.show();
    snippetManagerWindow.focus();
  });

  snippetManagerWindow.on('closed', () => { snippetManagerWindow = null; });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-feature-state', () => ({ ...featureState }));
ipcMain.handle('get-snippets', () => loadSnippets());

ipcMain.handle('save-snippets', (_event, snippets) => {
  saveSnippets(snippets);
  const { enqueueTyping } = require('./autofill');
  hotkeyManager.registerSnippetHotkeys(
    snippets,
    (text) => {
      broadcastToOverlays('feature-toggled', { feature: 'autofillEnabled', enabled: true });
      enqueueTyping(text);
    },
    () => featureState.autofillEnabled
  );
  return { success: true };
});

ipcMain.on('selection-complete', () => {
  returnToClickThrough();
});

ipcMain.on('annotation-complete', () => {
  exitAnnotationMode();
});

// ── Cue Cards IPC ──────────────────────────────────────────────────────────
ipcMain.handle('get-cue-cards', () => {
  if (!cueCardData) cueCardData = loadCueCards();
  return cueCardData;
});

ipcMain.handle('save-cue-cards', (_event, data) => {
  cueCardData = data;
  saveCueCards(data);
  // Refresh the floating panel if open
  if (cueCardActive) sendCueCardsToRenderer();
  return { success: true };
});

ipcMain.handle('get-cue-card-sets', () => {
  if (!cueCardData) cueCardData = loadCueCards();
  return Object.keys(cueCardData.sets);
});

ipcMain.handle('switch-cue-card-set', (_event, setName) => {
  switchCueCardSet(setName);
  return { success: true };
});

// ── Opportunities IPC (Sprint 1) ──────────────────────────────────────────
ipcMain.handle('get-opportunities', () => {
  return opportunityStore.loadOpportunities();
});

ipcMain.handle('add-opportunity', (_event, data) => {
  try {
    const opp = opportunityStore.addOpportunity(data);
    return { success: true, opportunity: opp };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('update-opportunity', (_event, { id, fields }) => {
  try {
    const opp = opportunityStore.updateOpportunity(id, fields);
    return { success: true, opportunity: opp };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-opportunity', (_event, id) => {
  try {
    opportunityStore.deleteOpportunity(id);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('search-opportunities', (_event, query) => {
  return opportunityStore.searchOpportunities(query);
});

ipcMain.handle('import-opportunities-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import Opportunities from CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    properties: ['openFile']
  });

  if (canceled || filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  try {
    const csvText  = fs.readFileSync(filePaths[0], 'utf8');
    const existing = opportunityStore.loadOpportunities();
    const { toImport, summary } = csvImporter.parseAndPrepare(csvText, existing);

    // Add each imported opportunity to the store
    for (const opp of toImport) {
      opportunityStore.addOpportunity(opp);
    }

    return { success: true, summary };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Recording Modal IPC ───────────────────────────────────────────────────
ipcMain.handle('recording-modal-get-opportunities', () => {
  return opportunityStore.loadOpportunities();
});

ipcMain.on('recording-modal-selected', (_event, opportunityId) => {
  startRecordingWithOpportunity(opportunityId);
});

ipcMain.on('recording-modal-cancel', () => {
  recordingManager.cancelRecording();
  closeRecordingModal();
  broadcastRecordingState();
  rebuildTrayMenu();
});

ipcMain.on('recording-modal-close', () => {
  closeRecordingModal();
});

// ── Recording State IPC ──────────────────────────────────────────────────
ipcMain.handle('get-recording-state', () => {
  return recordingManager.getState();
});

// ── Transcript IPC (Sprint 3 + Sprint 4) ─────────────────────────────────
ipcMain.handle('get-transcripts', () => {
  return transcriptStore.loadTranscriptIndex();
});

ipcMain.handle('get-transcript-content', (_event, id) => {
  return transcriptStore.getTranscriptContent(id);
});

ipcMain.handle('delete-transcript', (_event, id) => {
  return transcriptStore.deleteTranscript(id);
});

ipcMain.handle('search-transcripts', (_event, query) => {
  return transcriptStore.searchTranscripts(query);
});

ipcMain.handle('get-transcription-status', () => {
  if (!transcriptionQueue) return { pending: 0, processing: null, completed: 0, failed: 0 };
  return transcriptionQueue.getStatus();
});

ipcMain.handle('retry-transcription', (_event, transcriptId) => {
  if (transcriptionQueue) {
    transcriptionQueue.retry(transcriptId);
    return { success: true };
  }
  return { success: false, error: 'Transcription queue not initialized' };
});

ipcMain.handle('get-transcripts-for-opportunity', (_event, opportunityId) => {
  return transcriptStore.getTranscriptsByOpportunity(opportunityId);
});

// ── Transcription Config IPC (Sprint 6) ──────────────────────────────────
ipcMain.handle('get-transcription-config', () => {
  return transcriptionConfig.getAll();
});

ipcMain.handle('set-transcription-config', (_event, partial) => {
  transcriptionConfig.update(partial);
  return { success: true };
});

// ── Disk Space Check (Sprint 6) ──────────────────────────────────────────
ipcMain.handle('check-disk-space', async () => {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const output = execSync(`df -k "${userDataPath}"`).toString();
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const availableKB = parseInt(parts[3], 10);
        return { availableMB: Math.round(availableKB / 1024), ok: availableKB > 512000 };
      }
    } else if (process.platform === 'win32') {
      const drive = path.parse(userDataPath).root || 'C:\\';
      const output = execSync(`wmic logicaldisk where "DeviceID='${drive.replace('\\', '')}''" get FreeSpace /format:value`).toString();
      const match = output.match(/FreeSpace=(\d+)/);
      if (match) {
        const freeBytes = parseInt(match[1], 10);
        const freeMB = Math.round(freeBytes / (1024 * 1024));
        return { availableMB: freeMB, ok: freeMB > 512 };
      }
    }
    return { availableMB: -1, ok: true }; // Unknown — assume ok
  } catch (e) {
    console.error('[main] Disk space check failed:', e.message);
    return { availableMB: -1, ok: true };
  }
});

// ── Storage Management (Sprint 6) ────────────────────────────────────────
ipcMain.handle('cleanup-old-recordings', (_event, maxAgeDays) => {
  const days = maxAgeDays || transcriptionConfig.get('cleanupDays') || 90;
  return recordingManager.cleanupOldRecordings(days);
});

ipcMain.handle('get-storage-usage', () => {
  let recordingSize = 0;
  let transcriptSize = 0;

  const recDir = recordingManager.getRecordingsDir();
  const transDir = transcriptStore.getTranscriptsDir();

  try {
    if (recDir && fs.existsSync(recDir)) {
      const files = fs.readdirSync(recDir);
      for (const f of files) {
        try {
          recordingSize += fs.statSync(path.join(recDir, f)).size;
        } catch (_) {}
      }
    }
  } catch (_) {}

  try {
    if (transDir && fs.existsSync(transDir)) {
      const files = fs.readdirSync(transDir);
      for (const f of files) {
        try {
          transcriptSize += fs.statSync(path.join(transDir, f)).size;
        } catch (_) {}
      }
    }
  } catch (_) {}

  return {
    recordingsMB: +(recordingSize / (1024 * 1024)).toFixed(1),
    transcriptsMB: +(transcriptSize / (1024 * 1024)).toFixed(1),
    totalMB: +((recordingSize + transcriptSize) / (1024 * 1024)).toFixed(1)
  };
});

// ── Zoom Lens scroll adjustment IPC (from overlay) ────────────────────────
ipcMain.on('zoom-lens-scroll', (_event, { delta }) => {
  adjustZoomMagnification(delta > 0 ? -ZOOM_MAG_STEP : ZOOM_MAG_STEP);
});

ipcMain.on('close-snippet-manager', () => {
  if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
    snippetManagerWindow.close();
  }
});

ipcMain.on('open-snippet-manager', () => createSnippetManagerWindow());

ipcMain.on('toggle-feature', (_event, feature) => {
  if (Object.prototype.hasOwnProperty.call(featureState, feature)) {
    featureState[feature] = !featureState[feature];
    broadcastFeatureToggle(feature);
    rebuildTrayMenu();
  }
});

// Phase 3c + 5a/5b: hotkey status and config IPC
ipcMain.handle('get-hotkey-status', () => hotkeyManager.getStatus());
ipcMain.handle('get-hotkey-config', () => hotkeyManager.getFeatureHotkeys());
ipcMain.handle('get-default-hotkeys', () => hotkeyManager.getDefaultHotkeys());

ipcMain.handle('set-hotkey-config', (_event, { action, accelerator }) => {
  hotkeyManager.setAccelerator(action, accelerator);
  // Re-register everything with the new config
  hotkeyManager.reregisterAll();
  rebuildTrayMenu();
  return { success: true };
});

ipcMain.on('reregister-hotkeys', () => {
  hotkeyManager.reregisterAll();
});

// ── Recording Controls IPC (from Snippet Manager) ───────────────────────
ipcMain.handle('start-recording', () => {
  try {
    const state = recordingManager.getState();
    if (state.state !== 'IDLE') {
      return { success: false, error: 'Already recording or not idle' };
    }
    // Start the recording flow — show opportunity picker modal
    if (recordingManager.startRecordingFlow()) {
      showRecordingModal();
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stop-recording', async () => {
  try {
    const state = recordingManager.getState();
    if (state.state !== 'RECORDING' && state.state !== 'PAUSED') {
      return { success: false, error: 'Not currently recording' };
    }
    await stopRecordingFlow();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pause-recording', () => {
  try {
    recordingManager.pauseRecording();
    audioCapture.pauseCapture();
    broadcastRecordingState();
    rebuildTrayMenu();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('resume-recording', () => {
  try {
    recordingManager.resumeRecording();
    audioCapture.resumeCapture();
    broadcastRecordingState();
    rebuildTrayMenu();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── App Logger IPC ──────────────────────────────────────────────────────
ipcMain.handle('get-log-entries', (_event, filters) => {
  return appLogger.getEntries(filters);
});

ipcMain.handle('get-log-categories', () => {
  return appLogger.getCategories();
});

ipcMain.handle('clear-logs', () => {
  appLogger.clearLogs();
  return { success: true };
});

// ── Model Download IPC ──────────────────────────────────────────────────
ipcMain.handle('download-model', async (_event, modelId) => {
  try {
    const resolvedId = modelId || transcriptionConfig.get('modelId') || 'Xenova/whisper-base.en';
    appLogger.info('transcription', 'Model download started', { modelId: resolvedId });
    const provider = new WhisperProvider({
      modelId: resolvedId,
      modelsDir: path.join(userDataPath, 'models')
    });

    await provider.setup((progress) => {
      // Forward download progress to the renderer
      if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
        snippetManagerWindow.webContents.send('model-download-progress', progress);
      }
    });

    appLogger.success('transcription', 'Model download complete', { modelId: resolvedId });
    return { success: true };
  } catch (e) {
    console.error('[main] Model download failed:', e.message);
    appLogger.error('transcription', 'Model download failed', { error: e.message });
    return { success: false, error: e.message };
  }
});

ipcMain.handle('check-model-status', async (_event, requestedModelId) => {
  try {
    const modelId = requestedModelId || transcriptionConfig.get('modelId') || 'Xenova/whisper-base.en';
    const modelsDir = path.join(userDataPath, 'models');

    // Check if model files exist in the cache directory
    // @xenova/transformers uses various directory patterns
    const modelDirName = modelId.replace('/', '--');
    const searchDirs = [
      path.join(modelsDir, modelDirName),
      path.join(modelsDir, modelId),
      path.join(modelsDir, modelDirName, 'onnx'),
    ];

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        if (files.length > 0) {
          // Calculate total cached size
          let totalSize = 0;
          const walkDir = (d) => {
            try {
              for (const f of fs.readdirSync(d)) {
                const fp = path.join(d, f);
                const stat = fs.statSync(fp);
                if (stat.isDirectory()) walkDir(fp);
                else totalSize += stat.size;
              }
            } catch (_) {}
          };
          walkDir(dir);
          const cachedSizeMB = +(totalSize / (1024 * 1024)).toFixed(1);
          return { ready: true, cachedSizeMB, modelId, path: dir };
        }
      }
    }

    return { ready: false, modelId };
  } catch (e) {
    return { ready: false, error: e.message };
  }
});

// ── Export Transcript IPC ───────────────────────────────────────────────
ipcMain.handle('export-transcript', async (_event, { transcriptId, format }) => {
  try {
    const content = transcriptStore.getTranscriptContent(transcriptId);
    if (!content) return { success: false, error: 'Transcript not found' };

    const defaultExt = format === 'vtt' ? 'vtt' : format === 'json' ? 'json' : 'txt';
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Transcript',
      defaultPath: `transcript_${transcriptId}.${defaultExt}`,
      filters: [
        { name: 'Text Files', extensions: ['txt'] },
        { name: 'WebVTT', extensions: ['vtt'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) return { success: false, canceled: true };

    let exportContent;
    if (format === 'json') {
      exportContent = JSON.stringify(content, null, 2);
    } else if (format === 'vtt' && content.vtt) {
      exportContent = content.vtt;
    } else {
      exportContent = content.fullText || content.text || JSON.stringify(content, null, 2);
    }

    fs.writeFileSync(filePath, exportContent, 'utf8');
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Output Folder IPC ───────────────────────────────────────────────────
ipcMain.handle('select-output-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Output Folder',
    properties: ['openDirectory', 'createDirectory']
  });

  if (canceled || filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  transcriptionConfig.update({ outputDir: filePaths[0] });
  return { success: true, path: filePaths[0] };
});

ipcMain.handle('clear-output-folder', () => {
  transcriptionConfig.update({ outputDir: '' });
  return { success: true };
});

// ── Architecture Info IPC ───────────────────────────────────────────────
ipcMain.handle('get-arch-info', () => {
  // Detect Rosetta: process.arch reports 'x64' on Apple Silicon when running under Rosetta
  const isAppleSilicon = process.platform === 'darwin';
  const isRosetta = isAppleSilicon && process.arch === 'x64';
  let recommendation = '';
  if (isRosetta) {
    recommendation = 'This app is running under Rosetta (x64 emulation on Apple Silicon). ' +
      'For best performance, use the native arm64 build.';
  }
  return {
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    isRosetta,
    recommendation
  };
});

function broadcastFeatureToggle(feature) {
  broadcastToOverlays('feature-toggled', {
    feature,
    enabled: featureState[feature]
  });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

let trayMenuOpts = null;

function rebuildTrayMenu() {
  if (trayMenuOpts) {
    const { rebuildMenu } = require('./tray');
    rebuildMenu(trayMenuOpts);
  }
}

// ─── Single Instance Lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createSnippetManagerWindow();
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.on('window-all-closed', () => {});

app.on('activate', () => {
  if (!snippetManagerWindow) createSnippetManagerWindow();
});

app.on('will-quit', () => {
  // Sprint 6 — graceful shutdown: save any active recording before quitting
  const state = recordingManager.getState();
  if (state.state === 'RECORDING') {
    console.log('[main] App quitting during recording — stopping and saving');
    try {
      // Clear broadcast interval
      if (recordingManager._broadcastInterval) {
        clearInterval(recordingManager._broadcastInterval);
        recordingManager._broadcastInterval = null;
      }
      // Synchronous cancel of capture window (best effort)
      audioCapture.cancelCapture();
      recordingManager.cancelRecording();
    } catch (e) {
      console.error('[main] Error during recording cleanup on quit:', e.message);
    }
  } else if (state.state === 'PROMPTING') {
    recordingManager.cancelRecording();
    closeRecordingModal();
  }

  hotkeyManager.stopHealthCheck();
  hotkeyManager.unregisterAll();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // Initialise the application logger
  appLogger.init({ userDataPath });

  // Forward log entries to snippet manager UI in real-time
  appLogger.on('log', (entry) => {
    if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
      snippetManagerWindow.webContents.send('log-entry', entry);
    }
  });

  // Initialise the opportunity store (Sprint 1)
  opportunityStore.init(userDataPath);

  // Initialise recording manager and audio capture (Sprint 2)
  recordingManager.init({
    userDataPath,
    onStateChange: (state) => {
      console.log('[main] Recording state:', state.state);
    }
  });
  audioCapture.init({ userDataPath });
  audioCapture.setupIpcHandlers();

  // S1-4: Crash recovery — check for temp files from interrupted recordings
  const tempFiles = audioCapture.getTempFiles();
  if (tempFiles.length > 0) {
    console.log(`[main] Found ${tempFiles.length} unfinished recording(s) from a previous session`);
    for (const tmp of tempFiles) {
      const sizeMB = (tmp.size / (1024 * 1024)).toFixed(1);
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        title: 'Demo Assistant — Recover Recording?',
        message: `An unfinished recording was found (${sizeMB} MB).\n\nFile: ${tmp.finalName}`,
        detail: 'This recording was in progress when the app last closed. Would you like to recover it for transcription or discard it?',
        buttons: ['Recover', 'Discard'],
        defaultId: 0,
        cancelId: 1
      });

      if (choice === 0) {
        // Recover: rename temp to final and create a transcript entry
        try {
          audioCapture.recoverTempFile(tmp.tempPath, tmp.finalPath);
          console.log('[main] Recovered recording:', tmp.finalPath);
          // Transcript entry will be created after transcriptStore is initialized (below)
          // We store the info to enqueue after init
          if (!global._recoveredRecordings) global._recoveredRecordings = [];
          global._recoveredRecordings.push({
            audioFilename: tmp.finalName,
            filePath: tmp.finalPath
          });
        } catch (err) {
          console.error('[main] Failed to recover recording:', err.message);
        }
      } else {
        audioCapture.deleteTempFile(tmp.tempPath);
      }
    }
  }

  // ── Pre-flight dependency checks ──────────────────────────────────────────
  {
    // Check ffmpeg
    const ffmpegCheck = audioCapture._resolveFfmpegPath
      ? audioCapture._resolveFfmpegPath()
      : null;
    if (ffmpegCheck) {
      console.log('[startup] ffmpeg found:', ffmpegCheck);
      appLogger.info('startup', 'ffmpeg found', { path: ffmpegCheck });
    } else {
      console.warn('[startup] WARNING: ffmpeg not found. Recording post-processing and transcription will not work.');
      appLogger.warn('startup', 'ffmpeg not found — install with: brew install ffmpeg');
    }

    // Check @xenova/transformers
    try {
      require('@xenova/transformers');
      console.log('[startup] @xenova/transformers available');
      appLogger.info('startup', '@xenova/transformers available');
    } catch (_) {
      console.warn('[startup] WARNING: @xenova/transformers not found. Transcription will not work.');
      appLogger.warn('startup', '@xenova/transformers not found — install with: npm install @xenova/transformers');
    }
  }

  // Initialise transcription config (Sprint 6)
  transcriptionConfig.init(userDataPath);

  // Initialise transcript store and transcription queue (Sprint 3)
  transcriptStore.init(userDataPath);

  const whisperProvider = new WhisperProvider({
    modelId: transcriptionConfig.get('modelId') || 'Xenova/whisper-base.en',
    modelsDir: path.join(userDataPath, 'models')
  });

  transcriptionQueue = new TranscriptionQueue({
    provider: whisperProvider,
    transcriptStore,
    userDataPath
  });

  transcriptionQueue.on('job-completed', ({ transcriptId }) => {
    console.log('[main] Transcription completed:', transcriptId);
    appLogger.success('transcription', 'Transcription completed', { transcriptId });
    // Notify snippet manager if open
    if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
      snippetManagerWindow.webContents.send('transcription-progress', {
        transcriptId,
        status: 'completed'
      });
    }
  });

  // S2-3: Forward per-chunk progress to the UI
  transcriptionQueue.on('transcription-progress', (progress) => {
    if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
      snippetManagerWindow.webContents.send('transcription-progress', progress);
    }
  });

  transcriptionQueue.on('job-failed', ({ transcriptId, error }) => {
    console.log('[main] Transcription failed:', transcriptId, error);
    appLogger.error('transcription', 'Transcription failed', { transcriptId, error });
    if (snippetManagerWindow && !snippetManagerWindow.isDestroyed()) {
      snippetManagerWindow.webContents.send('transcription-progress', {
        transcriptId,
        status: 'failed',
        error
      });
    }
  });

  transcriptionQueue.init().catch(err => {
    console.error('[main] Failed to init transcription queue:', err.message);
  });

  // S1-4: Enqueue any recovered recordings for transcription
  if (global._recoveredRecordings && global._recoveredRecordings.length > 0) {
    for (const rec of global._recoveredRecordings) {
      try {
        const entry = transcriptStore.createTranscriptEntry({
          opportunityId: null,  // unknown — recovered from crash
          audioFilename: rec.audioFilename
        });
        const shouldTranscribe = transcriptionConfig.get('autoTranscribe') !== false;
        if (shouldTranscribe) {
          transcriptionQueue.enqueue({
            transcriptId: entry.id,
            audioFilePath: rec.filePath,
            opportunityId: null,
            options: {}
          });
          console.log('[main] Recovered recording enqueued for transcription:', entry.id);
        }
      } catch (err) {
        console.error('[main] Failed to enqueue recovered recording:', err.message);
      }
    }
    delete global._recoveredRecordings;
  }

  // Initialise the hotkey manager (Phases 1–3, 5a)
  hotkeyManager.init({
    userDataDir:    userDataPath,
    statusCallback: (_status) => rebuildTrayMenu()
  });

  createAllOverlays();

  screen.on('display-added',           repositionOverlays);
  screen.on('display-removed',         repositionOverlays);
  screen.on('display-metrics-changed', repositionOverlays);

  const { setupTray } = require('./tray');

  trayMenuOpts = {
    featureState,
    hotkeyManager,
    onOpenSnippetManager: createSnippetManagerWindow,
    onToggleFeature: (feature) => {
      if (Object.prototype.hasOwnProperty.call(featureState, feature)) {
        featureState[feature] = !featureState[feature];
        broadcastFeatureToggle(feature);
      }
    },
    onReregisterHotkeys: () => {
      hotkeyManager.reregisterAll();
    },
    onQuit: () => {
      hotkeyManager.stopHealthCheck();
      hotkeyManager.unregisterAll();
      app.exit(0);
    },
    getRecentTranscripts: () => {
      try {
        const index = transcriptStore.loadTranscriptIndex();
        const opps  = opportunityStore.loadOpportunities();
        return index
          .filter(t => t.status === 'completed')
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 5)
          .map(t => {
            const opp = opps.find(o => o.id === t.opportunityId);
            return {
              id: t.id,
              oppLabel: opp ? `${opp.opportunityNumber} — ${opp.accountName}` : 'Recording',
              createdAt: t.createdAt,
              duration: t.duration || 0
            };
          });
      } catch (e) {
        return [];
      }
    },
    onOpenTranscript: (transcriptId) => {
      createSnippetManagerWindow();
      // The snippet manager will need to switch to transcript tab — we send an IPC after load
      if (snippetManagerWindow) {
        const sendWhenReady = () => {
          snippetManagerWindow.webContents.send('open-transcript', { transcriptId });
        };
        if (snippetManagerWindow.webContents.isLoading()) {
          snippetManagerWindow.webContents.once('did-finish-load', sendWhenReady);
        } else {
          sendWhenReady();
        }
      }
    }
  };

  tray = setupTray(trayMenuOpts);

  // ── macOS Accessibility + Screen Recording + Microphone permission checks ──
  if (process.platform === 'darwin') {
    // Accessibility — needed for robotjs typing and clipboard paste
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    if (!trusted) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Demo Assistant — Accessibility Permission Required',
        message: 'Snippet typing requires Accessibility access.',
        detail: 'Go to System Settings → Privacy & Security → Accessibility and enable Demo Assistant.\n\nAfter enabling, restart the app.',
        buttons: ['OK']
      });
    }

    // Sprint 6 — Microphone permission check
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').then(granted => {
        if (!granted) {
          console.warn('[main] Microphone access not granted — recordings will use system audio only');
        }
      });
    }

    // Sprint 6 — Screen Recording note: already checked for freeze frame.
    // The desktopCapturer.getSources call implicitly triggers the macOS
    // Screen Recording permission prompt. We log a reminder on first launch.
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    if (screenStatus !== 'granted') {
      console.warn('[main] Screen Recording access not granted — system audio capture and freeze frame may not work');
    }
  }

  // Register all hotkeys through the manager
  const { enqueueTyping } = require('./autofill');
  const snippets = loadSnippets();

  hotkeyManager.registerFeatureHotkeys({
    sonar:           fireSonarAtCursor,
    selection:       enterSelectionMode,
    cursorHighlight: () => {
      featureState.cursorHighlightEnabled = !featureState.cursorHighlightEnabled;
      broadcastFeatureToggle('cursorHighlightEnabled');
      rebuildTrayMenu();
    },
    snippetManager:  createSnippetManagerWindow,
    spotlight:       toggleSpotlight,
    freezeFrame:     toggleFreezeFrame,
    annotation:      toggleAnnotationMode,
    annotationClear: clearAllAnnotations,
    zoomLens:        toggleZoomLens,
    cueCard:         toggleCueCards,
    cueCardNext:     () => navigateCueCard('next'),
    cueCardPrev:     () => navigateCueCard('prev'),
    recordToggle:    toggleRecording
  });

  hotkeyManager.registerSnippetHotkeys(
    snippets,
    (text) => {
      broadcastToOverlays('feature-toggled', { feature: 'autofillEnabled', enabled: true });
      enqueueTyping(text);
    },
    () => featureState.autofillEnabled
  );

  // Phase 2a: listen for sleep/wake and screen unlock
  hotkeyManager.setupSystemListeners();

  // Phase 2c: periodic health check
  hotkeyManager.startHealthCheck();

  console.log('[main] Demo Assistant started.');
  console.log('[main] Hotkeys managed by hotkeyManager with health monitoring.');
});
