'use strict';

/**
 * whisperProvider.js
 * ------------------
 * Transcription provider using @xenova/transformers (Whisper model).
 * Optional dependency wrapped in try/catch for graceful degradation.
 *
 * Audio decoding note:
 *   @xenova/transformers shells out to ffmpeg internally to decode non-WAV
 *   formats (WebM, MP3, etc.), but it resolves the binary path at import
 *   time and often looks for a system install at /usr/local/bin/ffmpeg.
 *   To avoid depending on a system-level ffmpeg, this provider pre-converts
 *   non-WAV audio files to 16 kHz mono WAV using the bundled ffmpeg-static
 *   binary BEFORE passing the buffer to the pipeline. WAV is a raw PCM
 *   format that transformers can decode natively — no external binary needed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const TranscriptionProvider = require('./provider');

// ─── ffmpeg resolution ──────────────────────────────────────────────────────

/**
 * Resolve an ffmpeg binary that actually exists on disk.
 * Checks, in order:
 *   1. The bundled ffmpeg-static binary (npm dependency)
 *   2. Homebrew on Apple Silicon (/opt/homebrew/bin/ffmpeg)
 *   3. Homebrew on Intel Mac (/usr/local/bin/ffmpeg)
 *   4. Linux system path (/usr/bin/ffmpeg)
 * Returns the absolute path to the first one found, or null.
 */
function _resolveFfmpegPath() {
  // 1. Bundled ffmpeg-static
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch (_) {}

  // 2–4. Common system install locations
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',   // Homebrew on Apple Silicon
    '/usr/local/bin/ffmpeg',      // Homebrew on Intel Mac
    '/usr/bin/ffmpeg',            // Linux / apt
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * Returns true if the file is already a WAV based on extension or magic bytes.
 */
function _isWavFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') return true;

  // Check RIFF/WAVE magic bytes
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    return (
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WAVE'
    );
  } catch (_) {
    return false;
  }
}

/**
 * Convert any audio file to 16 kHz mono 16-bit WAV using ffmpeg-static.
 * Returns the path to the converted WAV (in a temp location).
 * If ffmpeg-static is not available, returns null (caller should try raw).
 */
function _convertToWav(inputPath) {
  const ffmpeg = _resolveFfmpegPath();
  if (!ffmpeg) {
    throw new Error(
      'ffmpeg is required for transcription but was not found.\n' +
      'Install it with:  brew install ffmpeg  (macOS)\n' +
      '              or: apt install ffmpeg   (Linux)'
    );
  }

  // Write to a temp file next to the input
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${base}_whisper_tmp.wav`);

  try {
    execFileSync(ffmpeg, [
      '-y',
      '-i', inputPath,
      '-ar', '16000',       // 16 kHz sample rate (Whisper expects this)
      '-ac', '1',           // mono
      '-c:a', 'pcm_s16le', // 16-bit PCM
      wavPath
    ], { timeout: 120000 }); // 2-minute timeout for very long files

    console.log('[WhisperProvider] Pre-converted to WAV:', wavPath);
    return wavPath;
  } catch (err) {
    console.error('[WhisperProvider] ffmpeg conversion failed:', err.message);
    return null;
  }
}

// ─── WhisperProvider ─────────────────────────────────────────────────────────

/**
 * Whisper-based transcription provider using @xenova/transformers.
 * Handles automatic speech recognition with timestamps.
 */
class WhisperProvider extends TranscriptionProvider {
  /**
   * @param {Object} options
   * @param {string} options.modelId - Model ID (default: 'Xenova/whisper-base.en')
   * @param {string} options.modelsDir - Directory for cached models
   */
  constructor(options = {}) {
    super();
    this.modelId = options.modelId || 'Xenova/whisper-base.en';
    this.modelsDir = options.modelsDir || '';
    this.pipeline = null;
    this.transformers = null;
  }

  /**
   * Get the engine version string.
   * @returns {string} Version identifier
   */
  get engineVersion() {
    const modelName = this.modelId.split('/').pop();
    return `${modelName}-v1`;
  }

  /**
   * Check if the provider is ready for transcription.
   * @returns {Promise<boolean>}
   */
  async isReady() {
    if (!this.pipeline) return false;
    if (!this.transformers) {
      try {
        require('@xenova/transformers');
        this.transformers = require('@xenova/transformers');
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Set up the transcription provider.
   * Loads @xenova/transformers, configures cache, and creates the pipeline.
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<void>}
   */
  async setup(onProgress) {
    try {
      // Import transformers library
      this.transformers = require('@xenova/transformers');
      const { pipeline, env } = this.transformers;

      // Set cache directory if provided
      if (this.modelsDir) {
        env.localModelPath = this.modelsDir;
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      // Set up progress callback
      if (onProgress) {
        env.allowRemoteModels = true;
        env.allowLocalModels = true;
      }

      // Create the ASR pipeline
      if (onProgress) {
        onProgress({
          status: 'initializing',
          progress: 0,
          file: this.modelId
        });
      }

      this.pipeline = await pipeline('automatic-speech-recognition', this.modelId);

      if (onProgress) {
        onProgress({
          status: 'ready',
          progress: 100,
          file: this.modelId
        });
      }
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.message.includes('@xenova/transformers')) {
        throw new Error(
          'Transcription engine not found. Please install @xenova/transformers:\n' +
          'npm install @xenova/transformers'
        );
      }
      throw error;
    }
  }

  /**
   * Transcribe an audio file using the Whisper model.
   *
   * If the input is not already WAV, it is pre-converted to 16 kHz mono WAV
   * using the bundled ffmpeg-static binary. This avoids depending on a
   * system-installed ffmpeg, which @xenova/transformers would otherwise
   * try to spawn at a hardcoded path like /usr/local/bin/ffmpeg.
   *
   * @param {string} audioFilePath - Path to audio file
   * @param {Object} options - { language, ... }
   * @returns {Promise<Object>} { segments, fullText, language }
   */
  async transcribe(audioFilePath, options = {}) {
    if (!this.pipeline) {
      throw new Error('Pipeline not initialized. Call setup() first.');
    }

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    // ── Pre-convert non-WAV to WAV so transformers doesn't need ffmpeg ────
    let fileToRead = audioFilePath;
    let tempWav = null;

    if (!_isWavFile(audioFilePath)) {
      console.log('[WhisperProvider] Input is not WAV — pre-converting with bundled ffmpeg');
      tempWav = _convertToWav(audioFilePath);
      if (tempWav && fs.existsSync(tempWav)) {
        fileToRead = tempWav;
      } else {
        // Fall through and let transformers try its own decoding.
        // This will only work if the user has system ffmpeg installed.
        console.warn('[WhisperProvider] Pre-conversion failed — falling back to raw buffer');
      }
    }

    try {
      const audioBuffer = fs.readFileSync(fileToRead);

      // Call the pipeline with transcription options
      const result = await this.pipeline(audioBuffer, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        language: options.language || 'english'
      });

      // Map output chunks to segments
      const segments = [];
      let fullText = '';

      if (result.chunks && Array.isArray(result.chunks)) {
        for (const chunk of result.chunks) {
          const segment = {
            start: chunk.timestamp?.[0] ?? 0,
            end: chunk.timestamp?.[1] ?? 0,
            text: chunk.text || '',
            confidence: options.confidence ?? 1.0
          };
          segments.push(segment);
          if (segment.text) {
            fullText += (fullText ? ' ' : '') + segment.text;
          }
        }
      } else if (result.text) {
        segments.push({
          start: 0,
          end: 0,
          text: result.text,
          confidence: 1.0
        });
        fullText = result.text;
      }

      return {
        segments,
        fullText: fullText.trim(),
        language: options.language || 'english'
      };
    } finally {
      // Clean up temp WAV if we created one
      if (tempWav && fs.existsSync(tempWav)) {
        try {
          fs.unlinkSync(tempWav);
          console.log('[WhisperProvider] Cleaned up temp WAV:', tempWav);
        } catch (_) {}
      }
    }
  }

  /**
   * Clean up resources.
   * @returns {Promise<void>}
   */
  async dispose() {
    this.pipeline = null;
  }
}

module.exports = WhisperProvider;
