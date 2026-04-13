'use strict';

/**
 * audioCapture.js
 * ---------------
 * Main process module that manages the hidden audio capture BrowserWindow.
 * Handles system audio + microphone recording via Chromium's desktopCapturer.
 *
 * Sprint: Long-Recording Hardening
 *   S1-1  IPC channel for audio chunks
 *   S1-2  Main-process disk writer (fs.createWriteStream with backpressure)
 *   S1-3  In-memory chunk array removed from renderer
 *   S1-4  Crash recovery helpers (getTempFiles / deleteTempFile)
 */

const { BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Prefix for temp files that are being actively written.
 * A file named `_rec_{uuid}_{timestamp}.webm` is in-flight;
 * when recording stops it is renamed to drop the `_rec_` prefix.
 */
const TEMP_PREFIX = '_rec_';

// ─── State ────────────────────────────────────────────────────────────────────

let captureWindow = null;
let recordingsDir = null;
let targetFilePath = null;      // final resting path (without _rec_ prefix)
let tempFilePath = null;        // in-flight path (with _rec_ prefix)
let writeStream = null;         // fs.WriteStream for appending chunks
let isReady = false;
let chunkCount = 0;             // Count of audio chunks received this session
let totalBytesWritten = 0;      // Total bytes written to disk this session

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * init({ userDataPath })
 * Store the recordings directory path
 */
function init({ userDataPath }) {
  recordingsDir = path.join(userDataPath, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  console.log('[audioCapture] Initialized with recordings dir:', recordingsDir);
}

// ─── IPC Handlers (one-time setup) ────────────────────────────────────────────

function setupIpcHandlers() {
  // NOTE: 'audio-capture-ready' is handled via ipcMain.once() inside
  // startCapture() to avoid a race condition. Do NOT add a persistent
  // listener for it here.

  // S1-1 / S1-2: Receive streaming audio chunks and append to disk
  ipcMain.on('audio-chunk', (_event, arrayBuffer) => {
    if (!writeStream) {
      console.error('[audioCapture] Received chunk but no write stream is open');
      return;
    }
    const buffer = Buffer.from(arrayBuffer);
    chunkCount++;
    totalBytesWritten += buffer.length;

    // Log first chunk and then every 10th chunk for diagnostics
    if (chunkCount === 1) {
      console.log(`[audioCapture] First audio chunk received: ${buffer.length} bytes`);
    } else if (chunkCount % 10 === 0) {
      console.log(`[audioCapture] Chunk #${chunkCount}: total ${(totalBytesWritten / 1024).toFixed(1)} KB written`);
    }

    const canContinue = writeStream.write(buffer);
    if (!canContinue) {
      // Backpressure: renderer is outpacing disk I/O.
      // The write stream will buffer internally and drain automatically.
      // In practice this is rare at audio bitrates (~40 KB/s for Opus).
      console.warn('[audioCapture] Disk write backpressure — stream will drain');
    }
  });

  // Legacy: full-buffer data handler (kept for backward-compat / tests)
  ipcMain.on('audio-capture-data', (_event, arrayBuffer) => {
    if (!targetFilePath) {
      console.error('[audioCapture] No target file path set');
      return;
    }
    try {
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(targetFilePath, buffer);
      console.log('[audioCapture] Audio saved (legacy) to:', targetFilePath);
    } catch (err) {
      console.error('[audioCapture] Failed to save audio:', err.message);
    }
  });

  // Error from capture renderer
  ipcMain.on('audio-capture-error', (_event, message) => {
    console.error('[audioCapture] Capture error:', message);
  });
}

// ─── Capture Management ────────────────────────────────────────────────────────

/**
 * _createCaptureWindow()
 * Creates the hidden BrowserWindow for audio/video capture.
 * Separated from startCapture() so it can be re-created on retry.
 */
function _createCaptureWindow() {
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'audioCapturePreload.js'),
      backgroundThrottling: false
    }
  });

  // Forward renderer console to main process terminal.
  // The hidden capture window's logs are invisible otherwise, making
  // it impossible to diagnose why recording produces 0-byte files.
  win.webContents.on('console-message', (_event, level, message) => {
    const levelStr = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    console.log(`[capture-renderer] [${levelStr}] ${message}`);
  });

  return win;
}

/**
 * _launchCapture(mode)
 * Internal: creates a capture window, loads the HTML, waits for it to
 * become ready, sends the start command, then waits for RECORDING
 * confirmation (MediaRecorder.start() succeeded).
 *
 * Two-phase wait:
 *   Phase 1: HTML loaded → renderer sends 'audio-capture-ready'
 *   Phase 2: MediaRecorder started → renderer sends 'audio-capture-recording'
 *
 * If the renderer crashes between phase 1 and phase 2 (e.g., Chromium kills
 * it due to a bad desktop-capture IPC), the promise rejects so the caller
 * can retry in a different mode.
 *
 * @param {'full'|'audio-only'} mode
 *   - 'full': attempts screen video + system audio + mic
 *   - 'audio-only': mic only (no chromeMediaSource: 'desktop' calls)
 *
 * @returns {Promise<void>} resolves when renderer is actively recording
 * @throws if the renderer crashes or times out
 */
async function _launchCapture(mode) {
  // Get screen source ID (needed for 'full' mode)
  let sourceId = null;
  if (mode === 'full') {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length === 0) {
      console.warn('[audioCapture] No screen sources — falling back to audio-only');
      mode = 'audio-only';
    } else {
      sourceId = sources[0].id;
      console.log('[audioCapture] Using screen source:', sourceId);
    }
  }

  console.log(`[audioCapture] Launching capture in "${mode}" mode`);

  captureWindow = _createCaptureWindow();

  // ── Phase 1: Wait for HTML to load (audio-capture-ready) ──────────────
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Capture window ready timeout (15s) in ${mode} mode`));
    }, 15000);

    const onReady = () => {
      clearTimeout(timeout);
      console.log(`[audioCapture] Phase 1 complete: HTML loaded (${mode} mode)`);
      resolve();
    };

    ipcMain.once('audio-capture-ready', onReady);

    // If renderer crashes during load, reject
    captureWindow.webContents.once('render-process-gone', (_event, details) => {
      clearTimeout(timeout);
      ipcMain.removeListener('audio-capture-ready', onReady);
      reject(new Error(`Renderer crashed during HTML load (${mode}): ${details.reason}`));
    });

    // Load the capture HTML
    const htmlPath = path.join(__dirname, 'audioCapture.html');
    captureWindow.loadFile(htmlPath).catch(reject);
  });

  // ── Phase 2: Send start command and wait for recording confirmation ───
  // Reset chunk counter
  chunkCount = 0;
  totalBytesWritten = 0;
  isReady = true;

  await new Promise((resolve, reject) => {
    // Timeout: if the renderer doesn't confirm recording within 10s,
    // something went wrong (permissions, getUserMedia failure, etc.)
    const timeout = setTimeout(() => {
      reject(new Error(`Recording start timeout (10s) in ${mode} mode — renderer may have failed silently`));
    }, 10000);

    // Success: renderer confirms MediaRecorder.start() succeeded
    const onRecording = () => {
      clearTimeout(timeout);
      console.log(`[audioCapture] Phase 2 complete: MediaRecorder running (${mode} mode)`);
      // Clean up crash listener
      if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.webContents.removeListener('render-process-gone', onCrash);
      }
      resolve();
    };

    // Failure: renderer crashes during getUserMedia/MediaRecorder setup
    // This is the critical path for the "bad IPC message" crash in full mode.
    const onCrash = (_event, details) => {
      clearTimeout(timeout);
      ipcMain.removeListener('audio-capture-recording', onRecording);
      console.error(`[audioCapture] Renderer crashed during "${mode}" capture setup:`, details.reason);
      reject(new Error(`Renderer crashed during ${mode} capture: ${details.reason}`));
    };

    ipcMain.once('audio-capture-recording', onRecording);
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.webContents.once('render-process-gone', onCrash);
    }

    // Send start command to renderer
    console.log(`[audioCapture] Sending start command (${mode}, sourceId: ${sourceId || 'none'})`);
    captureWindow.webContents.send('audio-capture-start', { sourceId, mode });
  });

  // ── Recording is now active ───────────────────────────────────────────
  // Set up ongoing chunk monitoring
  setTimeout(() => {
    if (chunkCount === 0 && captureWindow && !captureWindow.isDestroyed()) {
      console.error('[audioCapture] WARNING: No audio chunks received after 5 seconds!');
      console.error('[audioCapture] MediaRecorder started but ondataavailable never fired.');
    }
  }, 5000);
}

/**
 * startCapture()
 * Creates hidden BrowserWindow, loads audioCapture.html, starts recording.
 *
 * First attempts "full" mode (screen video + system audio + mic).
 * If the renderer crashes (common when screen recording permission is denied
 * in macOS — Chromium terminates the renderer with "bad IPC message"),
 * automatically retries in "audio-only" mode (mic only).
 *
 * Returns: Promise that resolves when capture is actively recording
 */
async function startCapture() {
  isReady = false;

  // S1-2: Open a writable stream to a temp file
  if (targetFilePath) {
    const dir = path.dirname(targetFilePath);
    const base = path.basename(targetFilePath);
    tempFilePath = path.join(dir, TEMP_PREFIX + base);
    writeStream = fs.createWriteStream(tempFilePath, { flags: 'a' });
    writeStream.on('error', (err) => {
      console.error('[audioCapture] Write stream error:', err.message);
    });
    console.log('[audioCapture] Write stream opened:', tempFilePath);
  }

  // Attempt 1: full mode (video + system audio + mic)
  try {
    await _launchCapture('full');
    console.log('[audioCapture] Full capture started successfully');
    return;
  } catch (err) {
    console.warn('[audioCapture] Full capture failed:', err.message);

    // Clean up the crashed/failed window
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
    captureWindow = null;
    isReady = false;
  }

  // Attempt 2: audio-only mode (mic only — no desktop capture)
  console.log('[audioCapture] Retrying in audio-only mode (mic only)...');
  try {
    await _launchCapture('audio-only');
    console.log('[audioCapture] Audio-only capture started successfully');
    return;
  } catch (err) {
    console.error('[audioCapture] Audio-only capture also failed:', err.message);
    _closeWriteStream();
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
    captureWindow = null;
    throw err;
  }
}

/**
 * stopCapture()
 * Sends stop signal, waits for renderer to confirm all chunks sent,
 * closes write stream, renames temp file to final path, destroys window.
 * Returns: Promise<{ filePath, duration }>
 */
async function stopCapture() {
  if (!captureWindow) {
    throw new Error('Capture window not active');
  }

  // ── Guard: if the capture window or its renderer is already dead,
  //    skip the IPC handshake and finalise immediately.
  if (captureWindow.isDestroyed() || captureWindow.webContents.isDestroyed()) {
    console.warn('[audioCapture] Capture window already destroyed — finalising without renderer signal');
    await _finaliseFile().catch(() => {});
    captureWindow = null;
    isReady = false;
    return { filePath: targetFilePath, duration: 0 };
  }

  // ── Strategy: use webContents.executeJavaScript() to directly invoke
  //    the renderer's stop sequence.  This is far more reliable than the
  //    IPC event pattern (webContents.send → ipcRenderer.on → ipcRenderer.send)
  //    because it's a direct JS call that returns a promise.
  //
  //    We still listen for the IPC 'audio-capture-stopped' as a belt-and-
  //    suspenders confirmation, but executeJavaScript is the primary signal.
  console.log('[audioCapture] Sending stop via executeJavaScript');

  let settled = false;

  const destroyWindow = () => {
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.destroy();
    }
    captureWindow = null;
    isReady = false;
  };

  // Also listen for the renderer crash
  const crashPromise = new Promise((_, reject) => {
    if (!captureWindow || captureWindow.isDestroyed()) return;
    captureWindow.webContents.once('render-process-gone', (_event, details) => {
      console.error('[audioCapture] Renderer crashed during stop:', details.reason);
      reject(new Error('Capture renderer crashed: ' + details.reason));
    });
  });

  // Directly invoke stopCapture() in the renderer via executeJavaScript.
  // This bypasses the IPC event listener chain which has proven unreliable.
  // The renderer's stopCapture() function:
  //   1. Calls mediaRecorder.stop()
  //   2. Waits up to 5s for MediaRecorder to go inactive
  //   3. Sends audio-capture-stopped via IPC
  //   4. Cleans up streams
  // We don't need to wait for the IPC signal — executeJavaScript resolves
  // after the async function completes.
  const execPromise = captureWindow.webContents.executeJavaScript(`
    (async () => {
      try {
        // Stop MediaRecorder
        if (typeof mediaRecorder !== 'undefined' && mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
          // Wait for MediaRecorder to go inactive (max 5s)
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 5000);
            const i = setInterval(() => {
              if (!mediaRecorder || mediaRecorder.state === 'inactive') {
                clearInterval(i);
                clearTimeout(t);
                resolve();
              }
            }, 50);
          });
        }
        // Signal main that we're done (belt-and-suspenders)
        if (window.audioCaptureAPI && window.audioCaptureAPI.sendCaptureStop) {
          window.audioCaptureAPI.sendCaptureStop();
        }
        // Clean up streams
        if (typeof videoStream !== 'undefined' && videoStream) {
          videoStream.getTracks().forEach(t => t.stop());
        }
        if (typeof systemStream !== 'undefined' && systemStream) {
          systemStream.getTracks().forEach(t => t.stop());
        }
        if (typeof micStream !== 'undefined' && micStream) {
          micStream.getTracks().forEach(t => t.stop());
        }
        if (typeof mediaStream !== 'undefined' && mediaStream) {
          mediaStream.getTracks().forEach(t => t.stop());
        }
        if (typeof audioContext !== 'undefined' && audioContext) {
          try { audioContext.close(); } catch(_) {}
        }
        return 'stopped';
      } catch (err) {
        return 'error:' + err.message;
      }
    })()
  `).then((result) => {
    console.log('[audioCapture] executeJavaScript result:', result);
  }).catch((err) => {
    console.warn('[audioCapture] executeJavaScript failed:', err.message);
  });

  // Hard timeout: 8 seconds total (covers the 5s MediaRecorder timeout + margin)
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Audio capture timeout')), 8000);
  });

  // Wait for either: (1) exec completes, (2) renderer crashes, or (3) timeout
  try {
    await Promise.race([execPromise, crashPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[audioCapture] Stop race completed with error:', err.message);
    // Fall through to finalise — we'll save whatever was written to disk
  }

  // ── Regardless of how we got here, finalise the file.
  //    _finaliseFile() closes the write stream AND renames temp → final.
  //    Do NOT call _closeWriteStream() first — it nulls the stream reference
  //    which makes _finaliseFile() skip the rename.
  console.log(`[audioCapture] Stop complete. Chunks received: ${chunkCount}, bytes written: ${totalBytesWritten}`);
  if (chunkCount === 0) {
    console.error('[audioCapture] CRITICAL: Zero chunks received during recording session!');
    console.error('[audioCapture] The renderer never sent any audio data via IPC.');
  }
  try {
    await _finaliseFile();
    console.log('[audioCapture] File finalised:', targetFilePath);
  } catch (finalErr) {
    console.error('[audioCapture] Finalise failed:', finalErr.message);
    // Last resort: if _finaliseFile failed, try manual rename
    _closeWriteStream();
    if (tempFilePath && targetFilePath) {
      try {
        fs.renameSync(tempFilePath, targetFilePath);
        console.log('[audioCapture] Manual rename succeeded:', targetFilePath);
        tempFilePath = null;
      } catch (_) {}
    }
  }

  destroyWindow();
  return { filePath: targetFilePath, duration: 0 };
}

/**
 * cancelCapture()
 * Destroys window without saving. Cleans up temp file.
 */
function cancelCapture() {
  _closeWriteStream();
  // Remove temp file if it exists
  if (tempFilePath && fs.existsSync(tempFilePath)) {
    try { fs.unlinkSync(tempFilePath); } catch (_) {}
  }
  if (captureWindow) {
    captureWindow.destroy();
    captureWindow = null;
    isReady = false;
  }
  tempFilePath = null;
  console.log('[audioCapture] Capture cancelled');
}

/**
 * setTargetFile(filePath)
 * Sets where to save the audio (final path; temp file uses _rec_ prefix)
 */
function setTargetFile(filePath) {
  targetFilePath = filePath;
  console.log('[audioCapture] Target file set:', filePath);
}

// ─── Crash Recovery Helpers (S1-4) ────────────────────────────────────────────

/**
 * getTempFiles()
 * Returns an array of temp file paths (prefixed with _rec_) from the
 * recordings directory. These represent recordings that were in-flight
 * when the app crashed or was killed.
 */
function getTempFiles() {
  if (!recordingsDir || !fs.existsSync(recordingsDir)) return [];
  try {
    return fs.readdirSync(recordingsDir)
      .filter(f => f.startsWith(TEMP_PREFIX))
      .map(f => ({
        tempPath: path.join(recordingsDir, f),
        finalName: f.slice(TEMP_PREFIX.length),
        finalPath: path.join(recordingsDir, f.slice(TEMP_PREFIX.length)),
        size: fs.statSync(path.join(recordingsDir, f)).size
      }));
  } catch (err) {
    console.error('[audioCapture] Error scanning for temp files:', err.message);
    return [];
  }
}

/**
 * recoverTempFile(tempPath, finalPath)
 * Renames a temp file to its final path, making it available for transcription.
 */
function recoverTempFile(tempPath, finalPath) {
  fs.renameSync(tempPath, finalPath);
  console.log('[audioCapture] Recovered temp file:', finalPath);
}

/**
 * deleteTempFile(tempPath)
 * Removes a temp file the user chose to discard.
 */
function deleteTempFile(tempPath) {
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
    console.log('[audioCapture] Discarded temp file:', tempPath);
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function isCapturing() {
  return captureWindow !== null && !captureWindow.isDestroyed();
}

function getRecordingsDir() {
  return recordingsDir;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * _closeWriteStream()
 * Safely closes the write stream if open.
 */
function _closeWriteStream() {
  if (writeStream) {
    try { writeStream.end(); } catch (_) {}
    writeStream = null;
  }
}

/**
 * _finaliseFile()
 * Closes the write stream, waits for it to fully flush to disk,
 * validates the output, and renames temp → final.
 *
 * Hardened against:
 *   - Write stream not fully drained before close
 *   - OS file-system cache not flushed (uses fsync via fd)
 *   - Empty/truncated files (logs warning with size)
 */
function _finaliseFile() {
  return new Promise((resolve, reject) => {
    if (!writeStream) {
      // No stream open — check if temp file exists and needs renaming
      // (can happen if _closeWriteStream was called prematurely)
      if (tempFilePath && targetFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.renameSync(tempFilePath, targetFilePath);
          console.log('[audioCapture] Finalised file (no stream):', targetFilePath);
          tempFilePath = null;
        } catch (err) {
          console.error('[audioCapture] Failed to rename temp file:', err.message);
        }
      }
      resolve();
      return;
    }

    const stream = writeStream;
    const streamPath = stream.path || tempFilePath;

    // Step 1: End the stream and wait for the 'finish' event
    // The 'finish' event fires after all data has been flushed to the
    // underlying resource (the OS write buffer).
    stream.end(() => {
      writeStream = null;

      // Step 2: fsync to force OS to flush to disk
      // This is critical for large files where the OS may still be
      // caching writes when 'finish' fires.
      const doFsync = (cb) => {
        if (!streamPath || !fs.existsSync(streamPath)) {
          cb();
          return;
        }
        try {
          const fd = fs.openSync(streamPath, 'r');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          console.log('[audioCapture] fsync completed for:', streamPath);
        } catch (syncErr) {
          console.warn('[audioCapture] fsync failed (non-fatal):', syncErr.message);
        }
        cb();
      };

      doFsync(() => {
        // Step 3: Validate the output file before renaming
        if (tempFilePath && targetFilePath) {
          try {
            const stat = fs.statSync(tempFilePath);
            console.log(`[audioCapture] Temp file size: ${stat.size} bytes (${(stat.size / 1024).toFixed(1)} KB)`);

            if (stat.size === 0) {
              console.error('[audioCapture] WARNING: Temp file is empty (0 bytes) — recording may have failed');
            } else if (stat.size < 100) {
              console.warn(`[audioCapture] WARNING: Temp file is very small (${stat.size} bytes) — recording may be truncated`);
            }
          } catch (statErr) {
            console.warn('[audioCapture] Cannot stat temp file:', statErr.message);
          }

          try {
            fs.renameSync(tempFilePath, targetFilePath);
            console.log('[audioCapture] Finalised file:', targetFilePath);
            tempFilePath = null;
            resolve();
          } catch (err) {
            console.error('[audioCapture] Failed to rename temp file:', err.message);
            reject(err);
          }
        } else {
          resolve();
        }
      });
    });

    // Safety timeout: if the stream never fires 'finish', force cleanup
    // after 10 seconds. This prevents the app from hanging indefinitely.
    setTimeout(() => {
      if (writeStream === stream) {
        console.error('[audioCapture] Write stream finish timeout (10s) — forcing close');
        try { stream.destroy(); } catch (_) {}
        writeStream = null;

        // Still try to rename whatever was written
        if (tempFilePath && targetFilePath && fs.existsSync(tempFilePath)) {
          try {
            fs.renameSync(tempFilePath, targetFilePath);
            console.log('[audioCapture] Finalised file (after timeout):', targetFilePath);
            tempFilePath = null;
          } catch (_) {}
        }
        resolve();
      }
    }, 10000);
  });
}

// ─── Pause / Resume ──────────────────────────────────────────────────────────

function pauseCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.webContents.send('audio-capture-pause');
    console.log('[audioCapture] Pause signal sent');
  }
}

function resumeCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.webContents.send('audio-capture-resume');
    console.log('[audioCapture] Resume signal sent');
  }
}

// ─── ffmpeg Post-Processing ──────────────────────────────────────────────────

const ffmpegHelper = require('./ffmpegHelper');

/**
 * convertToOutputFormats(webmPath)
 * Produces an MP4 (screen+audio) and a WAV (16kHz mono for Whisper).
 *
 * WAV conversion is CRITICAL — it's required for the transcription pipeline.
 * If WAV conversion fails, this function logs detailed diagnostics so the
 * root cause can be identified (empty WebM, missing ffmpeg, codec issues, etc.)
 *
 * Returns: Promise<{ mp4Path, wavPath }>
 */
async function convertToOutputFormats(webmPath) {
  // ── Pre-flight: validate ffmpeg availability ──────────────────────────
  const diag = ffmpegHelper.diagnose();
  if (!diag.available) {
    console.error('[audioCapture] ffmpeg not available — cannot convert');
    console.error('[audioCapture] ffmpeg diagnosis:', JSON.stringify(diag));
    return { mp4Path: null, wavPath: null };
  }
  console.log(`[audioCapture] ffmpeg available: ${diag.path} (v${diag.version}, bundled: ${diag.isBundled})`);

  // ── Pre-flight: validate input WebM file ──────────────────────────────
  const inputCheck = ffmpegHelper.validateMediaFile(webmPath, { minBytes: 100 });
  if (!inputCheck.valid) {
    console.error(`[audioCapture] WebM file invalid: ${inputCheck.error}`);
    console.error(`[audioCapture] WebM path: ${webmPath}, size: ${inputCheck.size}`);
    return { mp4Path: null, wavPath: null };
  }
  console.log(`[audioCapture] WebM input valid: ${(inputCheck.size / 1024).toFixed(1)} KB, format: ${inputCheck.format || 'unknown'}`);

  const ffmpeg = ffmpegHelper.getFfmpegPath();
  const basePath = webmPath.replace(/\.webm$/i, '');
  const mp4Path = basePath + '.mp4';
  const wavPath = basePath + '.wav';

  // ── WAV conversion (CRITICAL for transcription) ───────────────────────
  // Do WAV first since it's the one that matters for the pipeline.
  let wavSuccess = false;

  console.log('[audioCapture] Extracting WAV for transcription...');
  const wavResult = await ffmpegHelper.convertToWav(webmPath, wavPath);

  if (wavResult.success) {
    console.log(`[audioCapture] WAV saved: ${wavPath} (${(wavResult.size / 1024).toFixed(1)} KB)`);
    wavSuccess = true;
  } else {
    console.error(`[audioCapture] WAV extraction FAILED: ${wavResult.error}`);
    // Run detailed ffmpeg diagnostic to capture exact error
    await new Promise((resolve) => {
      execFile(ffmpeg, ['-i', webmPath], { timeout: 10000 }, (_err, _stdout, stderr) => {
        console.error('[audioCapture] ffmpeg -i diagnostic output:', stderr ? stderr.slice(0, 1000) : '(no output)');
        resolve();
      });
    });
  }

  // ── MP4 conversion (nice-to-have, not critical) ───────────────────────
  let mp4Success = false;

  console.log('[audioCapture] Converting to MP4...');
  await new Promise((resolve) => {
    const mp4Args = [
      '-y', '-i', webmPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      mp4Path
    ];

    execFile(ffmpeg, mp4Args, { timeout: 600000 }, (mp4Err, _stdout, stderr) => {
      if (mp4Err) {
        console.error('[audioCapture] MP4 conversion failed:', mp4Err.message);
        if (stderr) console.error('[audioCapture] MP4 stderr:', stderr.slice(0, 500));
      } else {
        const mp4Check = ffmpegHelper.validateMediaFile(mp4Path);
        if (mp4Check.valid) {
          console.log(`[audioCapture] MP4 saved: ${mp4Path} (${(mp4Check.size / 1024).toFixed(1)} KB)`);
          mp4Success = true;
        } else {
          console.error('[audioCapture] MP4 output invalid:', mp4Check.error);
        }
      }
      resolve();
    });
  });

  console.log(`[audioCapture] Conversion summary: WAV=${wavSuccess ? 'OK' : 'FAILED'}, MP4=${mp4Success ? 'OK' : 'FAILED'}`);

  return {
    mp4Path: mp4Success ? mp4Path : null,
    wavPath: wavSuccess ? wavPath : null
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  setupIpcHandlers,
  startCapture,
  stopCapture,
  cancelCapture,
  pauseCapture,
  resumeCapture,
  setTargetFile,
  isCapturing,
  getRecordingsDir,
  convertToOutputFormats,
  // S1-4: Crash recovery
  getTempFiles,
  recoverTempFile,
  deleteTempFile,
  TEMP_PREFIX,
  // Exposed for startup pre-flight check
  _resolveFfmpegPath: ffmpegHelper.getFfmpegPath
};
