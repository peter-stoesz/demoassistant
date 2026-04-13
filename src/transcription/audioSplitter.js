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
const ffmpegHelper = require('../ffmpegHelper');

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_MINUTES = 5;
const OVERLAP_SECONDS = 3;  // overlap at chunk boundaries for better accuracy

// ─── ffmpeg path resolution (delegates to shared helper) ────────────────────

function getFfmpegPath() {
  return ffmpegHelper.getFfmpegPath();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the total duration of an audio file in seconds.
 *
 * Tries three methods in order:
 *   1. ffprobe (fastest, most reliable for files with duration headers)
 *   2. ffmpeg -i (parse Duration from stderr — works for most container formats)
 *   3. Decode to WAV (last resort — works for headerless WebM from MediaRecorder)
 *
 * Pre-validates the input file before attempting anything.
 *
 * @param {string} filePath - Path to audio file
 * @returns {Promise<number>} Duration in seconds
 */
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    // ── Pre-flight: validate the input file ───────────────────────────────
    const fileCheck = ffmpegHelper.validateMediaFile(filePath, { minBytes: 44 });
    if (!fileCheck.valid) {
      reject(new Error(
        `Cannot determine duration: input file invalid — ${fileCheck.error}\n` +
        `  Path: ${filePath}\n` +
        `  Size: ${fileCheck.size} bytes\n` +
        `  This usually means the recording was empty or truncated.\n` +
        `  Check that stopCapture() properly flushed all audio data to disk.`
      ));
      return;
    }
    console.log(`[audioSplitter] Input file: ${(fileCheck.size / 1024).toFixed(1)} KB, format: ${fileCheck.format || 'unknown'}`);

    // ── Method 1: ffprobe ─────────────────────────────────────────────────
    const probeBin = ffmpegHelper.getFfprobePath();

    execFile(probeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 30000 }, (err, stdout) => {
      if (!err) {
        const dur = parseFloat(stdout.trim());
        if (!isNaN(dur) && dur > 0) {
          console.log(`[audioSplitter] Duration via ffprobe: ${dur.toFixed(1)}s`);
          resolve(dur);
          return;
        }
      }

      // ── Method 2: ffmpeg -i (parse Duration from stderr) ──────────────
      console.log('[audioSplitter] ffprobe failed or returned no duration, trying ffmpeg -i...');
      execFile(getFfmpegPath(), ['-i', filePath], { timeout: 30000 }, (err2, _stdout2, stderr2) => {
        const match = stderr2 && stderr2.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (match) {
          const hours = parseInt(match[1], 10);
          const mins  = parseInt(match[2], 10);
          const secs  = parseInt(match[3], 10);
          const frac  = parseInt(match[4], 10) / 100;
          const dur = hours * 3600 + mins * 60 + secs + frac;
          console.log(`[audioSplitter] Duration via ffmpeg -i: ${dur.toFixed(1)}s`);
          resolve(dur);
          return;
        }

        // ── Method 3: Decode to WAV and compute from file size ──────────
        // WebM files from MediaRecorder often have no duration header.
        // ffmpeg can still decode them. We convert to a known format (WAV)
        // and calculate duration from the output byte count.
        console.log('[audioSplitter] No duration header — decoding to measure length...');
        console.log(`[audioSplitter] ffmpeg -i stderr: ${stderr2 ? stderr2.slice(0, 300) : '(none)'}`);

        const tmpWav = filePath + '.dur_probe.wav';
        const wavResult = ffmpegHelper.convertToWav(filePath, tmpWav, { timeout: 120000 });

        wavResult.then((result) => {
          if (!result.success) {
            try { fs.unlinkSync(tmpWav); } catch (_) {}
            reject(new Error(
              `Cannot determine duration of ${filePath}: all methods failed.\n` +
              `  File size: ${fileCheck.size} bytes, format: ${fileCheck.format || 'unknown'}\n` +
              `  ffprobe: failed\n` +
              `  ffmpeg -i: no Duration header\n` +
              `  WAV decode: ${result.error}\n` +
              `  The recording file may be corrupted or empty.`
            ));
            return;
          }

          try {
            const stat = fs.statSync(tmpWav);
            // WAV header is 44 bytes; 16kHz mono 16-bit PCM = 32000 bytes/sec
            const dataBytes = stat.size - 44;
            const dur = dataBytes / 32000;
            console.log(`[audioSplitter] Duration via WAV decode: ${dur.toFixed(1)}s (${(stat.size / (1024*1024)).toFixed(1)} MB WAV)`);
            try { fs.unlinkSync(tmpWav); } catch (_) {}

            if (dur <= 0) {
              reject(new Error(`Duration computed as ${dur}s — recording appears empty`));
              return;
            }
            resolve(dur);
          } catch (statErr) {
            try { fs.unlinkSync(tmpWav); } catch (_) {}
            reject(new Error(`Cannot stat decoded WAV: ${statErr.message}`));
          }
        }).catch((promiseErr) => {
          try { fs.unlinkSync(tmpWav); } catch (_) {}
          reject(new Error(`WAV decode promise failed: ${promiseErr.message}`));
        });
      });
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
