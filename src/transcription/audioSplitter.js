'use strict';

/**
 * audioSplitter.js
 * ----------------
 * S2-1: Split an audio file into fixed-length WAV chunks using ffmpeg.
 *
 * Usage:
 *   const { splitAudio } = require('./audioSplitter');
 *   const chunks = await splitAudio('/path/to/recording.webm', {
 *     chunkMinutes: 5,
 *     outputDir: '/tmp/chunks'
 *   });
 *   // chunks = [{ path, index, startSeconds, durationSeconds }, ...]
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_MINUTES = 5;
const OVERLAP_SECONDS = 3;  // overlap at chunk boundaries for better accuracy

// ─── ffmpeg path resolution ─────────────────────────────────────────────────

/**
 * Resolve the ffmpeg binary path.
 * Checks, in order:
 *   1. Bundled ffmpeg-static (npm dependency)
 *   2. Homebrew on Apple Silicon (/opt/homebrew/bin/ffmpeg)
 *   3. Homebrew on Intel Mac (/usr/local/bin/ffmpeg)
 *   4. Linux system path (/usr/bin/ffmpeg)
 *   5. Bare 'ffmpeg' (hope it's on PATH)
 */
function getFfmpegPath() {
  // 1. Bundled
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch (_) {}

  // 2–4. Common system install locations
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 5. Last resort — bare name, relies on PATH
  return 'ffmpeg';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the total duration of an audio file in seconds using ffprobe.
 * @param {string} filePath - Path to audio file
 * @returns {Promise<number>} Duration in seconds
 */
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = getFfmpegPath().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    // Fall back to ffprobe on PATH if the replacement didn't produce a valid path
    const probeBin = fs.existsSync(ffprobe) ? ffprobe : 'ffprobe';

    execFile(probeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], (err, stdout) => {
      if (err) {
        // If ffprobe fails, try ffmpeg -i as fallback
        execFile(getFfmpegPath(), ['-i', filePath], (err2, _stdout2, stderr2) => {
          const match = stderr2 && stderr2.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
          if (match) {
            const hours = parseInt(match[1], 10);
            const mins  = parseInt(match[2], 10);
            const secs  = parseInt(match[3], 10);
            const frac  = parseInt(match[4], 10) / 100;
            resolve(hours * 3600 + mins * 60 + secs + frac);
          } else {
            reject(new Error(`Cannot determine duration of ${filePath}`));
          }
        });
        return;
      }
      const dur = parseFloat(stdout.trim());
      if (isNaN(dur)) {
        reject(new Error(`Invalid duration output for ${filePath}: "${stdout}"`));
      } else {
        resolve(dur);
      }
    });
  });
}

/**
 * Split an audio file into fixed-length WAV chunks.
 *
 * @param {string} inputPath - Path to the source audio file (.webm, .wav, etc.)
 * @param {Object} [options]
 * @param {number} [options.chunkMinutes=5]  - Length of each chunk in minutes
 * @param {string} [options.outputDir]       - Directory for output chunks (default: sibling temp dir)
 * @param {number} [options.overlapSeconds=3] - Overlap between consecutive chunks
 * @returns {Promise<Array<{ path: string, index: number, startSeconds: number, durationSeconds: number }>>}
 */
async function splitAudio(inputPath, options = {}) {
  const chunkMinutes   = options.chunkMinutes || DEFAULT_CHUNK_MINUTES;
  const overlapSeconds = options.overlapSeconds != null ? options.overlapSeconds : OVERLAP_SECONDS;
  const chunkSeconds   = chunkMinutes * 60;

  // Determine output directory
  const outputDir = options.outputDir || path.join(
    path.dirname(inputPath),
    `_chunks_${path.basename(inputPath, path.extname(inputPath))}`
  );
  fs.mkdirSync(outputDir, { recursive: true });

  // Get total duration
  const totalDuration = await getDuration(inputPath);
  console.log(`[audioSplitter] Total duration: ${totalDuration.toFixed(1)}s, chunk length: ${chunkSeconds}s`);

  // Calculate chunk boundaries
  const chunks = [];
  let startSeconds = 0;
  let index = 0;

  while (startSeconds < totalDuration) {
    const remaining = totalDuration - startSeconds;
    const duration  = Math.min(chunkSeconds + overlapSeconds, remaining);

    const chunkPath = path.join(outputDir, `chunk_${String(index).padStart(4, '0')}.wav`);

    // Use ffmpeg to extract the chunk as WAV
    await _extractChunk(inputPath, chunkPath, startSeconds, duration);

    chunks.push({
      path: chunkPath,
      index,
      startSeconds,
      durationSeconds: duration
    });

    startSeconds += chunkSeconds; // advance by chunk length (not including overlap)
    index++;
  }

  console.log(`[audioSplitter] Split into ${chunks.length} chunks in ${outputDir}`);
  return chunks;
}

// ─── Internal ───────────────────────────────────────────────────────────────

/**
 * Extract a single chunk from the source audio.
 */
function _extractChunk(inputPath, outputPath, startSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    const args = [
      '-y',
      '-ss', String(startSeconds),
      '-t',  String(durationSeconds),
      '-i',  inputPath,
      '-ar', '16000',           // 16 kHz sample rate (Whisper expects this)
      '-ac', '1',               // mono
      '-c:a', 'pcm_s16le',     // 16-bit PCM WAV
      outputPath
    ];

    execFile(ffmpeg, args, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[audioSplitter] ffmpeg error for chunk at ${startSeconds}s:`, stderr);
        reject(new Error(`ffmpeg failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { splitAudio, getDuration, getFfmpegPath, OVERLAP_SECONDS: OVERLAP_SECONDS };
