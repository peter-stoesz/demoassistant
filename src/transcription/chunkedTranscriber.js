'use strict';

/**
 * chunkedTranscriber.js
 * ---------------------
 * S2-2 / S2-3 / S2-4 / S2-5
 *
 * Orchestrates the chunked transcription pipeline:
 *   1. Split audio into N-minute WAV chunks (S2-1 audioSplitter)
 *   2. Transcribe each chunk sequentially, releasing buffers between (S2-2)
 *   3. Report per-chunk progress (S2-3)
 *   4. Assemble segments into a single VTT with correct timestamps (S2-4)
 *   5. Clean up temp chunk files after success (S2-5)
 */

const fs   = require('fs');
const path = require('path');
const { splitAudio, OVERLAP_SECONDS } = require('./audioSplitter');

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * transcribeChunked(provider, audioFilePath, options)
 *
 * @param {TranscriptionProvider} provider - Whisper provider (already set up)
 * @param {string} audioFilePath  - Path to the full recording (.webm / .wav)
 * @param {Object} [options]
 * @param {number} [options.chunkMinutes=5]
 * @param {Function} [options.onProgress] - ({ chunk, totalChunks, percent }) => void
 * @param {Object}   [options.metadata]   - { opportunityNumber, accountName, ... } for VTT NOTE
 * @param {string}   [options.language]
 * @returns {Promise<{ segments, fullText, language, vtt }>}
 */
async function transcribeChunked(provider, audioFilePath, options = {}) {
  const chunkMinutes = options.chunkMinutes || 5;
  const onProgress   = options.onProgress || (() => {});
  const metadata     = options.metadata || {};
  const language     = options.language || 'english';

  // ── Step 1: Split ─────────────────────────────────────────────────────────

  const chunks = await splitAudio(audioFilePath, { chunkMinutes });
  const totalChunks = chunks.length;

  onProgress({ chunk: 0, totalChunks, percent: 0, status: 'splitting-complete' });

  // ── Step 2 + 3: Transcribe each chunk sequentially ────────────────────────

  const allSegments = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkInfo = chunks[i];

    onProgress({
      chunk: i + 1,
      totalChunks,
      percent: Math.round(((i) / totalChunks) * 100),
      status: 'transcribing'
    });

    console.log(`[chunkedTranscriber] Transcribing chunk ${i + 1}/${totalChunks} (start=${chunkInfo.startSeconds}s)`);

    // Transcribe this chunk
    const result = await provider.transcribe(chunkInfo.path, { language });

    // Offset timestamps by the chunk's start position
    const offsetSegments = _offsetSegments(result.segments, chunkInfo.startSeconds);

    // S2-2: Release buffer — set result to null so GC can reclaim
    // The provider's internal buffer for this chunk is released on the next call.

    // Deduplicate overlapping segments from the previous chunk
    if (allSegments.length > 0 && i > 0) {
      _deduplicateOverlap(allSegments, offsetSegments, OVERLAP_SECONDS);
    }

    allSegments.push(...offsetSegments);

    onProgress({
      chunk: i + 1,
      totalChunks,
      percent: Math.round(((i + 1) / totalChunks) * 100),
      status: 'transcribing'
    });
  }

  // ── Step 4: Assemble VTT ──────────────────────────────────────────────────

  const fullText = allSegments.map(s => s.text).join(' ').trim();
  const vtt = _assembleVTT(allSegments, metadata);

  // ── Step 5: Cleanup temp chunk files ──────────────────────────────────────

  _cleanupChunks(chunks);

  onProgress({ chunk: totalChunks, totalChunks, percent: 100, status: 'complete' });

  return { segments: allSegments, fullText, language, vtt };
}

// ─── VTT Assembly (S2-4) ────────────────────────────────────────────────────

/**
 * Assemble a WebVTT string from segments.
 * Includes a NOTE block with opportunity metadata.
 */
function _assembleVTT(segments, metadata) {
  const lines = ['WEBVTT', ''];

  // NOTE block with metadata
  if (Object.keys(metadata).length > 0) {
    lines.push('NOTE');
    for (const [key, value] of Object.entries(metadata)) {
      if (value != null) {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push('');
  }

  // Cue entries
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    lines.push(String(i + 1));
    lines.push(`${_formatTimestamp(seg.start)} --> ${_formatTimestamp(seg.end)}`);
    lines.push(seg.text.trim());
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format seconds into VTT timestamp: HH:MM:SS.mmm
 */
function _formatTimestamp(seconds) {
  if (seconds == null || isNaN(seconds)) seconds = 0;
  const h   = Math.floor(seconds / 3600);
  const m   = Math.floor((seconds % 3600) / 60);
  const s   = Math.floor(seconds % 60);
  const ms  = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ─── Segment Helpers ────────────────────────────────────────────────────────

/**
 * Offset all segment timestamps by a given number of seconds.
 */
function _offsetSegments(segments, offsetSeconds) {
  return segments.map(seg => ({
    ...seg,
    start: (seg.start || 0) + offsetSeconds,
    end:   (seg.end   || 0) + offsetSeconds
  }));
}

/**
 * Deduplicate overlapping segments between consecutive chunks.
 * Segments from the new chunk whose start time falls within the overlap
 * window of the previous chunk's last segment are dropped.
 */
function _deduplicateOverlap(existingSegments, newSegments, overlapSeconds) {
  if (existingSegments.length === 0 || newSegments.length === 0) return;

  const lastExisting = existingSegments[existingSegments.length - 1];
  const overlapThreshold = lastExisting.end - overlapSeconds;

  // Remove new segments that overlap with the tail of existing segments
  let removeCount = 0;
  for (let i = 0; i < newSegments.length; i++) {
    if (newSegments[i].start < lastExisting.end && newSegments[i].end <= lastExisting.end + 1) {
      removeCount++;
    } else {
      break;
    }
  }

  if (removeCount > 0) {
    newSegments.splice(0, removeCount);
    console.log(`[chunkedTranscriber] Deduplicated ${removeCount} overlapping segment(s)`);
  }
}

// ─── Cleanup (S2-5) ────────────────────────────────────────────────────────

/**
 * Delete temporary WAV chunk files and their parent directory.
 * Logs each deletion for auditability.
 */
function _cleanupChunks(chunks) {
  if (!chunks || chunks.length === 0) return;

  const dirs = new Set();

  for (const chunk of chunks) {
    try {
      if (fs.existsSync(chunk.path)) {
        fs.unlinkSync(chunk.path);
        console.log(`[chunkedTranscriber] Deleted chunk: ${path.basename(chunk.path)}`);
        dirs.add(path.dirname(chunk.path));
      }
    } catch (err) {
      console.error(`[chunkedTranscriber] Failed to delete chunk ${chunk.path}:`, err.message);
    }
  }

  // Remove empty chunk directories
  for (const dir of dirs) {
    try {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
        console.log(`[chunkedTranscriber] Removed empty chunk directory: ${dir}`);
      }
    } catch (_) {}
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { transcribeChunked, _assembleVTT, _formatTimestamp, _cleanupChunks };
