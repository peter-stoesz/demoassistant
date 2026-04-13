'use strict';

/**
 * queue.js
 * --------
 * FIFO job queue for transcription tasks.
 * Processes jobs one at a time, emits progress events, persists queue to disk.
 *
 * Sprint: Long-Recording Hardening
 *   S2-2  Sequential chunk transcription (via chunkedTranscriber)
 *   S2-3  Per-chunk progress reporting
 *   S2-4  VTT output alongside JSON transcript
 *   S2-5  Temp file cleanup (delegated to chunkedTranscriber)
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { transcribeChunked } = require('./chunkedTranscriber');

// Optional: appLogger for structured logging (graceful if not initialised)
let appLogger = null;
try { appLogger = require('../appLogger'); } catch (_) {}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Files larger than this threshold (in bytes) use the chunked pipeline.
 * ~10 MB ≈ roughly 10–15 minutes of Opus audio.
 */
const CHUNKED_THRESHOLD_BYTES = 10 * 1024 * 1024;

// ─── TranscriptionQueue ──────────────────────────────────────────────────────

/**
 * Manages a queue of transcription jobs.
 * Processes one job at a time, persists state, emits events.
 */
class TranscriptionQueue extends EventEmitter {
  /**
   * @param {Object} options
   * @param {TranscriptionProvider} options.provider - Transcription provider
   * @param {Object} options.transcriptStore - Transcript store instance
   * @param {string} options.userDataPath - Electron userData path
   */
  constructor(options = {}) {
    super();
    this.provider = options.provider;
    this.transcriptStore = options.transcriptStore;
    this.userDataPath = options.userDataPath;
    this.jobs = [];
    this.currentJob = null;
    this.processing = false;
    this.queueFilePath = path.join(this.userDataPath, 'transcription-queue.json');
    this.transcriptsDir = path.join(this.userDataPath, 'transcripts');
  }

  /**
   * Initialize the queue: load persisted state and resume processing.
   * @returns {Promise<void>}
   */
  async init() {
    this._loadQueue();
    fs.mkdirSync(this.transcriptsDir, { recursive: true });

    // Do NOT auto-process persisted jobs on startup.
    // Loading @xenova/transformers triggers the ONNX native runtime, which
    // can crash the Electron main process with SIGTRAP if the native bindings
    // are incompatible. Transcription jobs are only processed when explicitly
    // enqueued during this session (via enqueue()), or when the user manually
    // retries from the UI.
    if (this.jobs.length > 0) {
      console.log(`[TranscriptionQueue] Found ${this.jobs.length} pending job(s) from previous session — will process when triggered, not automatically`);
    }
  }

  /**
   * Enqueue a transcription job.
   * @param {Object} job
   * @param {string} job.transcriptId - UUID of the transcript
   * @param {string} job.audioFilePath - Path to audio file
   * @param {string} job.opportunityId - Associated opportunity ID
   * @param {Object} job.options - Transcription options
   * @returns {void}
   */
  enqueue(job) {
    this.jobs.push(job);
    this._persistQueue();
    console.log(`[TranscriptionQueue] Job enqueued: ${job.transcriptId}`);
    if (appLogger) appLogger.info('transcription', 'Job enqueued', { transcriptId: job.transcriptId });
    if (!this.processing) {
      setImmediate(() => this._processNext());
    }
  }

  /**
   * Get the current queue status.
   * @returns {Object} { pending: N, processing: job|null, completed: N, failed: N }
   */
  getStatus() {
    const index = this.transcriptStore.loadTranscriptIndex();
    const completed = index.filter(t => t.status === 'completed').length;
    const failed = index.filter(t => t.status === 'failed').length;
    return {
      pending: this.jobs.length,
      processing: this.currentJob || null,
      completed,
      failed
    };
  }

  /**
   * Retry a failed transcript.
   * @param {string} transcriptId - Transcript ID to retry
   * @returns {void}
   */
  retry(transcriptId) {
    const index = this.transcriptStore.loadTranscriptIndex();
    const entry = index.find(t => t.id === transcriptId);
    if (!entry) {
      console.error(`[TranscriptionQueue] Transcript not found: ${transcriptId}`);
      return;
    }
    // Reset status to pending and re-enqueue
    this.transcriptStore.updateTranscriptStatus(transcriptId, 'pending', {});
    this.enqueue({
      transcriptId,
      audioFilePath: path.join(this.userDataPath, 'recordings', entry.audioFilename),
      opportunityId: entry.opportunityId,
      options: {}
    });
  }

  /**
   * Process the next job in the queue.
   * @private
   * @returns {Promise<void>}
   */
  async _processNext() {
    if (this.jobs.length === 0) {
      this.processing = false;
      this.currentJob = null;
      this.emit('queue-empty');
      console.log('[TranscriptionQueue] Queue is empty');
      return;
    }

    this.processing = true;
    this.currentJob = this.jobs.shift();
    const job = this.currentJob;

    console.log(`[TranscriptionQueue] Starting job: ${job.transcriptId}`);
    if (appLogger) appLogger.info('transcription', 'Job started', { transcriptId: job.transcriptId });
    this.emit('job-started', job);

    try {
      // Ensure provider is ready
      if (!await this.provider.isReady()) {
        console.log(`[TranscriptionQueue] Setting up provider for: ${job.transcriptId}`);
        await this.provider.setup((progress) => {
          this.emit('job-progress', { ...progress, transcriptId: job.transcriptId });
        });
      }

      // Determine whether to use chunked or single-pass transcription.
      //
      // The chunked pipeline splits audio into 5-minute WAV segments,
      // transcribes them sequentially, and reassembles the results.
      // This keeps ONNX Runtime memory bounded and avoids OrtRun errors
      // on large files.
      //
      // We ALWAYS use the chunked pipeline for non-WAV files (WebM, etc.)
      // because the raw compressed file size is deceptively small — a 3 MB
      // WebM file expands to ~50 MB of PCM data, which can exceed the
      // ONNX model's memory budget in a single pass. The chunked pipeline
      // handles the format conversion as part of its ffmpeg splitting step.
      const fileSize = fs.existsSync(job.audioFilePath)
        ? fs.statSync(job.audioFilePath).size
        : 0;
      const ext = path.extname(job.audioFilePath).toLowerCase();
      const isCompressedFormat = ext !== '.wav';
      const useChunked = fileSize > CHUNKED_THRESHOLD_BYTES || isCompressedFormat;

      let result;

      if (useChunked) {
        // ── S2-2/3/4/5: Chunked transcription pipeline ─────────────────
        console.log(
          `[TranscriptionQueue] Using chunked pipeline for ${(fileSize / (1024 * 1024)).toFixed(1)} MB file` +
          (isCompressedFormat ? ` (compressed format: ${ext})` : '')
        );

        result = await transcribeChunked(this.provider, job.audioFilePath, {
          chunkMinutes: 5,
          language: job.options.language,
          metadata: job.options.metadata || {},
          onProgress: (progress) => {
            // S2-3: Emit per-chunk progress
            this.emit('transcription-progress', {
              transcriptId: job.transcriptId,
              chunk: progress.chunk,
              totalChunks: progress.totalChunks,
              percent: progress.percent,
              status: progress.status
            });
          }
        });

        // S2-4: Write VTT file alongside JSON transcript
        if (result.vtt) {
          const vttPath = path.join(this.transcriptsDir, `${job.transcriptId}.vtt`);
          fs.writeFileSync(vttPath, result.vtt, 'utf8');
          console.log(`[TranscriptionQueue] VTT saved: ${vttPath}`);
        }
      } else {
        // ── Single-pass transcription (small WAV files only) ────────────
        console.log(`[TranscriptionQueue] Using single-pass for ${(fileSize / (1024 * 1024)).toFixed(1)} MB WAV file`);
        result = await this.provider.transcribe(job.audioFilePath, job.options);
      }

      // Write transcript JSON
      const transcriptContent = {
        segments: result.segments,
        fullText: result.fullText,
        language: result.language,
        timestamp: new Date().toISOString()
      };

      const transcriptPath = path.join(this.transcriptsDir, `${job.transcriptId}.json`);
      fs.writeFileSync(transcriptPath, JSON.stringify(transcriptContent, null, 2), 'utf8');
      console.log(`[TranscriptionQueue] Transcript saved: ${transcriptPath}`);

      // Update transcript status
      const metadata = {
        wordCount: result.fullText.split(/\s+/).length,
        duration: result.segments.length > 0 ? result.segments[result.segments.length - 1].end : 0,
        engineVersion: this.provider.engineVersion
      };
      this.transcriptStore.updateTranscriptStatus(job.transcriptId, 'completed', metadata);
      this.emit('job-completed', { transcriptId: job.transcriptId, result });
    } catch (error) {
      console.error(`[TranscriptionQueue] Job failed: ${job.transcriptId}`, error.message);
      this.transcriptStore.updateTranscriptStatus(job.transcriptId, 'failed', {
        error: error.message
      });
      this.emit('job-failed', { transcriptId: job.transcriptId, error: error.message });
    }

    // Remove from persisted queue
    this._persistQueue();

    // Process next job
    setImmediate(() => this._processNext());
  }

  /**
   * Persist the current queue to disk.
   * @private
   */
  _persistQueue() {
    try {
      fs.mkdirSync(path.dirname(this.queueFilePath), { recursive: true });
      fs.writeFileSync(this.queueFilePath, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch (error) {
      console.error('[TranscriptionQueue] Failed to persist queue:', error.message);
    }
  }

  /**
   * Load the persisted queue from disk.
   * @private
   */
  _loadQueue() {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const raw = fs.readFileSync(this.queueFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.jobs = parsed;
        }
      }
    } catch (error) {
      console.error('[TranscriptionQueue] Failed to load queue:', error.message);
      this.jobs = [];
    }
  }
}

module.exports = TranscriptionQueue;
