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
 * startCapture()
 * Creates hidden BrowserWindow, loads audioCapture.html, gets screen source.
 * Opens a writable stream to a temp file for streaming writes.
 * Returns: Promise that resolves when window is ready
 */
async function startCapture() {
  isReady = false;  // Reset for fresh ready-check
  try {
    // Get screen source ID from desktopCapturer
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length === 0) {
      throw new Error('No screen sources available');
    }

    const sourceId = sources[0].id;
    console.log('[audioCapture] Using screen source:', sourceId);

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

    // Create hidden window
    captureWindow = new BrowserWindow({
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

    // Set up the ready listener BEFORE loading the file to avoid a race
    // where the renderer fires 'audio-capture-ready' during loadFile()
    // before the polling promise is created.
    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Capture window ready timeout (15s)'));
      }, 15000);

      const onReady = () => {
        isReady = true;
        clearTimeout(timeout);
        console.log('[audioCapture] Capture window ready');
        // Send screen source to renderer
        captureWindow.webContents.send('audio-capture-start', { sourceId });
        resolve();
      };

      // Listen for the ready signal (once — replaces the module-level handler)
      ipcMain.once('audio-capture-ready', onReady);
    });

    // Load audioCapture.html — renderer will fire audio-capture-ready when loaded
    const filePath = path.join(__dirname, 'audioCapture.html');
    await captureWindow.loadFile(filePath);

    // Now wait for the ready signal (may already have resolved)
    return readyPromise;
  } catch (err) {
    console.error('[audioCapture] Failed to start capture:', err.message);
    _closeWriteStream();
    if (captureWindow) {
      captureWindow.destroy();
      captureWindow = null;
    }
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
  return new Promise((resolve, reject) => {
    if (!captureWindow) {
      reject(new Error('Capture window not active'));
      return;
    }

    const timeout = setTimeout(() => {
      _closeWriteStream();
      if (captureWindow) {
        captureWindow.destroy();
        captureWindow = null;
      }
      reject(new Error('Audio capture timeout'));
    }, 10000);

    // Wait for the renderer to signal that all chunks have been sent
    const stoppedHandler = () => {
      ipcMain.removeListener('audio-capture-stopped', stoppedHandler);
      clearTimeout(timeout);

      // Close the write stream and rename temp → final
      _finaliseFile()
        .then(() => {
          if (captureWindow) {
            captureWindow.destroy();
            captureWindow = null;
            isReady = false;
          }
          resolve({ filePath: targetFilePath, duration: 0 });
        })
        .catch(reject);
    };

    ipcMain.once('audio-capture-stopped', stoppedHandler);

    // Send stop signal to renderer
    if (captureWindow && !captureWindow.isDestroyed()) {
      captureWindow.webContents.send('audio-capture-stop');
    }
  });
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
 * Closes the write stream, waits for it to finish, renames temp → final.
 */
function _finaliseFile() {
  return new Promise((resolve, reject) => {
    if (!writeStream) {
      resolve();
      return;
    }

    writeStream.end(() => {
      writeStream = null;

      // Rename temp file to final path
      if (tempFilePath && targetFilePath) {
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

function _resolveFfmpegPath() {
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch (_) {}
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * convertToOutputFormats(webmPath)
 * Produces an MP4 (screen+audio) and a WAV (16kHz mono for Whisper).
 * Returns: Promise<{ mp4Path, wavPath }>
 */
function convertToOutputFormats(webmPath) {
  const ffmpeg = _resolveFfmpegPath();
  if (!ffmpeg) {
    console.warn('[audioCapture] ffmpeg not found — skipping MP4/WAV conversion');
    return Promise.resolve({ mp4Path: null, wavPath: null });
  }

  const basePath = webmPath.replace(/\.webm$/i, '');
  const mp4Path = basePath + '.mp4';
  const wavPath = basePath + '.wav';

  return new Promise((resolve) => {
    // MP4: re-encode video to H.264, audio to AAC
    const mp4Args = [
      '-y', '-i', webmPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      mp4Path
    ];

    console.log('[audioCapture] Converting to MP4...');
    execFile(ffmpeg, mp4Args, { timeout: 600000 }, (mp4Err) => {
      if (mp4Err) {
        console.error('[audioCapture] MP4 conversion failed:', mp4Err.message);
      } else {
        console.log('[audioCapture] MP4 saved:', mp4Path);
      }

      // WAV: extract audio at 16kHz mono 16-bit PCM for Whisper
      const wavArgs = [
        '-y', '-i', webmPath,
        '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        wavPath
      ];

      console.log('[audioCapture] Extracting WAV...');
      execFile(ffmpeg, wavArgs, { timeout: 300000 }, (wavErr) => {
        if (wavErr) {
          console.error('[audioCapture] WAV extraction failed:', wavErr.message);
          resolve({ mp4Path: fs.existsSync(mp4Path) ? mp4Path : null, wavPath: null });
        } else {
          console.log('[audioCapture] WAV saved:', wavPath);
          resolve({
            mp4Path: fs.existsSync(mp4Path) ? mp4Path : null,
            wavPath
          });
        }
      });
    });
  });
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
  TEMP_PREFIX
};
