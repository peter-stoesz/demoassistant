'use strict';

/**
 * ffmpegHelper.js
 * ---------------
 * Shared ffmpeg/ffprobe resolution and diagnostic utilities.
 * Consolidates the duplicate path resolution that was scattered across
 * audioCapture.js, audioSplitter.js, and whisperProvider.js.
 */

const fs = require('fs');
const { execFileSync, execFile } = require('child_process');

// ─── Cached paths ──────────────────────────────────────────────────────────

let _cachedFfmpegPath = undefined;  // undefined = not yet resolved
let _cachedFfprobePath = undefined;

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the ffmpeg binary path.
 * Checks, in order:
 *   1. Bundled ffmpeg-static (npm dependency)
 *   2. Homebrew on Apple Silicon (/opt/homebrew/bin/ffmpeg)
 *   3. Homebrew on Intel Mac (/usr/local/bin/ffmpeg)
 *   4. Linux system path (/usr/bin/ffmpeg)
 *   5. Bare 'ffmpeg' (hope it's on PATH)
 *
 * @returns {string} Path to ffmpeg binary
 */
function getFfmpegPath() {
  if (_cachedFfmpegPath !== undefined) return _cachedFfmpegPath;

  // 1. Bundled ffmpeg-static
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) {
      _cachedFfmpegPath = staticPath;
      return staticPath;
    }
  } catch (_) {}

  // 2–4. Common system install locations
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _cachedFfmpegPath = p;
      return p;
    }
  }

  // 5. Last resort — bare name, relies on PATH
  _cachedFfmpegPath = 'ffmpeg';
  return 'ffmpeg';
}

/**
 * Resolve the ffprobe binary path.
 * Derives from ffmpeg path (replaces ffmpeg → ffprobe in the resolved path).
 * Falls back to bare 'ffprobe' if the derived path doesn't exist.
 *
 * Note: ffmpeg-static does NOT include ffprobe. If using the bundled binary,
 * this will fall back to system ffprobe or bare 'ffprobe'.
 *
 * @returns {string} Path to ffprobe binary
 */
function getFfprobePath() {
  if (_cachedFfprobePath !== undefined) return _cachedFfprobePath;

  const ffmpegPath = getFfmpegPath();
  const derived = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

  if (derived !== ffmpegPath && fs.existsSync(derived)) {
    _cachedFfprobePath = derived;
    return derived;
  }

  // Check system locations for ffprobe specifically
  const candidates = [
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _cachedFfprobePath = p;
      return p;
    }
  }

  _cachedFfprobePath = 'ffprobe';
  return 'ffprobe';
}

// ─── Diagnostics ───────────────────────────────────────────────────────────

/**
 * Run a diagnostic check on ffmpeg availability and capabilities.
 * Returns a structured object with version info and supported codecs.
 *
 * @returns {{ available: boolean, path: string, version: string|null, error: string|null }}
 */
function diagnose() {
  const ffmpegPath = getFfmpegPath();
  const result = {
    available: false,
    path: ffmpegPath,
    version: null,
    error: null,
    isBundled: false
  };

  try {
    const staticPath = require('ffmpeg-static');
    result.isBundled = ffmpegPath === staticPath;
  } catch (_) {}

  try {
    const versionOutput = execFileSync(ffmpegPath, ['-version'], { timeout: 10000 }).toString();
    const versionMatch = versionOutput.match(/ffmpeg version (\S+)/);
    result.version = versionMatch ? versionMatch[1] : 'unknown';
    result.available = true;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Check whether a file looks like a valid audio/video container.
 * Performs basic validation:
 *   1. File exists
 *   2. File size > 0 (and > minBytes if specified)
 *   3. Optionally checks magic bytes for known formats
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {number} [options.minBytes=100] - Minimum file size to consider valid
 * @returns {{ valid: boolean, size: number, error: string|null, format: string|null }}
 */
function validateMediaFile(filePath, options = {}) {
  const minBytes = options.minBytes != null ? options.minBytes : 100;

  if (!filePath) {
    return { valid: false, size: 0, error: 'No file path provided', format: null };
  }

  if (!fs.existsSync(filePath)) {
    return { valid: false, size: 0, error: 'File does not exist', format: null };
  }

  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    return { valid: false, size: 0, error: `Cannot stat file: ${err.message}`, format: null };
  }

  if (size === 0) {
    return { valid: false, size: 0, error: 'File is empty (0 bytes)', format: null };
  }

  if (size < minBytes) {
    return { valid: false, size, error: `File too small (${size} bytes, minimum ${minBytes})`, format: null };
  }

  // Check magic bytes
  let format = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);

    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') {
      format = 'wav';
    } else if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
      format = 'webm/mkv';  // EBML header (WebM or Matroska)
    } else if (header.toString('ascii', 4, 8) === 'ftyp') {
      format = 'mp4';
    } else if (header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) {
      format = 'mp3';
    }
  } catch (_) {}

  return { valid: true, size, error: null, format };
}

/**
 * Convert an audio file to 16 kHz mono 16-bit WAV using ffmpeg.
 * This is the canonical conversion function used throughout the app.
 *
 * @param {string} inputPath - Source audio file
 * @param {string} outputPath - Destination WAV path
 * @param {Object} [options]
 * @param {number} [options.timeout=300000] - Timeout in ms (default 5 min)
 * @returns {Promise<{ success: boolean, path: string|null, error: string|null, size: number }>}
 */
function convertToWav(inputPath, outputPath, options = {}) {
  const timeout = options.timeout || 300000;

  return new Promise((resolve) => {
    const ffmpeg = getFfmpegPath();

    // Pre-flight: validate input file
    const inputCheck = validateMediaFile(inputPath);
    if (!inputCheck.valid) {
      resolve({
        success: false,
        path: null,
        error: `Input file invalid: ${inputCheck.error}`,
        size: 0
      });
      return;
    }

    console.log(`[ffmpegHelper] Converting to WAV: ${inputPath} (${(inputCheck.size / 1024).toFixed(1)} KB, format: ${inputCheck.format || 'unknown'})`);

    const args = [
      '-y',
      '-i', inputPath,
      '-vn',               // strip video
      '-ar', '16000',      // 16 kHz sample rate (Whisper expects this)
      '-ac', '1',          // mono
      '-c:a', 'pcm_s16le', // 16-bit PCM WAV
      outputPath
    ];

    execFile(ffmpeg, args, { timeout }, (err, _stdout, stderr) => {
      if (err) {
        console.error('[ffmpegHelper] WAV conversion failed:', err.message);
        if (stderr) console.error('[ffmpegHelper] ffmpeg stderr:', stderr.slice(0, 500));
        resolve({
          success: false,
          path: null,
          error: `ffmpeg failed: ${err.message}`,
          size: 0
        });
        return;
      }

      // Validate output
      const outputCheck = validateMediaFile(outputPath, { minBytes: 44 }); // WAV header is 44 bytes
      if (!outputCheck.valid) {
        console.error('[ffmpegHelper] WAV output invalid:', outputCheck.error);
        resolve({
          success: false,
          path: null,
          error: `Output invalid: ${outputCheck.error}`,
          size: 0
        });
        return;
      }

      console.log(`[ffmpegHelper] WAV conversion successful: ${outputPath} (${(outputCheck.size / 1024).toFixed(1)} KB)`);
      resolve({
        success: true,
        path: outputPath,
        error: null,
        size: outputCheck.size
      });
    });
  });
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  getFfmpegPath,
  getFfprobePath,
  diagnose,
  validateMediaFile,
  convertToWav
};
