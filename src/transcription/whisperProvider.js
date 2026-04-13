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
const ffmpegHelper = require('../ffmpegHelper');

// ─── ffmpeg resolution (delegates to shared helper) ─────────────────────────

function _resolveFfmpegPath() {
  return ffmpegHelper.getFfmpegPath();
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

/**
 * Decode a 16-bit PCM WAV buffer into a Float32Array of normalised samples.
 *
 * WAV files have a RIFF header followed by one or more chunks. The audio
 * samples live inside the "data" chunk.  We search for it rather than
 * assuming a fixed 44-byte header, because some encoders insert extra
 * chunks (e.g. LIST/INFO metadata) between "fmt " and "data".
 *
 * The samples are converted from signed 16-bit integers (range -32768..32767)
 * to floating point (range -1.0..1.0), which is what Whisper expects.
 */
function _decodeWavToFloat32(wavBuffer) {
  // Validate minimum WAV size (RIFF header = 12 bytes + fmt chunk ≥ 24 + data header ≥ 8)
  if (wavBuffer.length < 44) {
    throw new Error('WAV buffer too small (' + wavBuffer.length + ' bytes)');
  }

  // Verify RIFF/WAVE magic
  const riff = wavBuffer.toString('ascii', 0, 4);
  const wave = wavBuffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Not a valid WAV file (magic: ' + riff + '/' + wave + ')');
  }

  // Find the "data" chunk by scanning sub-chunks after the 12-byte RIFF header
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    // Move to next chunk (8-byte header + chunk payload, padded to even)
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1; // RIFF chunks are word-aligned
  }

  if (dataOffset === -1) {
    throw new Error('WAV "data" chunk not found');
  }

  // Clamp dataSize to what's actually available in the buffer
  const availableBytes = wavBuffer.length - dataOffset;
  if (dataSize > availableBytes) {
    console.warn('[WhisperProvider] WAV data chunk claims ' + dataSize +
      ' bytes but only ' + availableBytes + ' available — clamping');
    dataSize = availableBytes;
  }

  // 16-bit samples = 2 bytes each
  const numSamples = Math.floor(dataSize / 2);
  const float32 = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    // readInt16LE gives signed 16-bit value (-32768..32767)
    const sample = wavBuffer.readInt16LE(dataOffset + i * 2);
    // Normalise to -1.0..1.0
    float32[i] = sample / 32768.0;
  }

  return float32;
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
        this.transformers = await import('@xenova/transformers');
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
      console.log('[WhisperProvider] setup() starting — modelId:', this.modelId);

      // Import transformers library (ESM-only package — must use dynamic import)
      console.log('[WhisperProvider] Importing @xenova/transformers...');
      this.transformers = await import('@xenova/transformers');
      const { pipeline, env } = this.transformers;
      console.log('[WhisperProvider] @xenova/transformers imported successfully');

      // Force WASM-only execution.  The onnxruntime-node → onnxruntime-web shim
      // prevents the native ONNX addon from loading, but onnx.js still adds 'cpu'
      // to executionProviders when it detects Node.js.  onnxruntime-web doesn't
      // have a 'cpu' provider, so we must remove it to avoid runtime errors.
      try {
        const onnxBackend = await import('@xenova/transformers/src/backends/onnx.js');
        if (onnxBackend && onnxBackend.executionProviders) {
          const idx = onnxBackend.executionProviders.indexOf('cpu');
          if (idx !== -1) {
            onnxBackend.executionProviders.splice(idx, 1);
          }
          console.log('[WhisperProvider] Execution providers:', JSON.stringify(onnxBackend.executionProviders));
        }

        // Configure ONNX WASM environment for Node.js child process.
        // onnxruntime-web needs explicit settings when running outside a browser:
        //   - numThreads=1: avoid Web Worker threading issues in Node.js
        //   - wasmPaths: point to the actual .wasm files on disk
        if (onnxBackend.ONNX && onnxBackend.ONNX.env && onnxBackend.ONNX.env.wasm) {
          onnxBackend.ONNX.env.wasm.numThreads = 1;
          console.log('[WhisperProvider] Set WASM numThreads=1');

          // Resolve the path to onnxruntime-web's dist directory where .wasm files live
          try {
            const ortWebPkg = require.resolve('onnxruntime-web');
            const ortWebDir = path.dirname(ortWebPkg) + '/';
            onnxBackend.ONNX.env.wasm.wasmPaths = ortWebDir;
            console.log('[WhisperProvider] Set WASM paths:', ortWebDir);
          } catch (pathErr) {
            console.warn('[WhisperProvider] Could not resolve onnxruntime-web path:', pathErr.message);
          }
        } else {
          console.warn('[WhisperProvider] ONNX.env.wasm not found — WASM config skipped');
        }
      } catch (onnxErr) {
        console.warn('[WhisperProvider] Could not configure ONNX backend:', onnxErr.message);
      }

      // Set cache directory if provided
      if (this.modelsDir) {
        env.localModelPath = this.modelsDir;
        env.cacheDir = this.modelsDir;          // v2.x cache dir
        fs.mkdirSync(this.modelsDir, { recursive: true });
        console.log('[WhisperProvider] Models dir:', this.modelsDir);
      }

      // Set up progress callback
      if (onProgress) {
        env.allowRemoteModels = true;
        env.allowLocalModels = true;
      }

      // Create the ASR pipeline with download progress forwarding
      if (onProgress) {
        onProgress({
          status: 'initializing',
          progress: 0,
          file: this.modelId
        });
      }

      console.log('[WhisperProvider] Creating pipeline for:', this.modelId);

      const pipelineOpts = {};
      if (onProgress) {
        pipelineOpts.progress_callback = (progressData) => {
          // @xenova/transformers emits { status, name, file, progress, loaded, total }
          if (progressData && progressData.status === 'progress') {
            onProgress({
              status: 'downloading',
              progress: Math.round(progressData.progress || 0),
              file: progressData.file || this.modelId
            });
          } else if (progressData && progressData.status === 'done') {
            console.log('[WhisperProvider] Model file loaded:', progressData.file);
            onProgress({
              status: 'loading',
              progress: 90,
              file: progressData.file || this.modelId
            });
          } else if (progressData) {
            console.log('[WhisperProvider] Pipeline progress:', progressData.status, progressData.file || '');
          }
        };
      }

      this.pipeline = await pipeline('automatic-speech-recognition', this.modelId, pipelineOpts);
      console.log('[WhisperProvider] Pipeline created successfully');

      if (onProgress) {
        onProgress({
          status: 'ready',
          progress: 100,
          file: this.modelId
        });
      }
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM' || error.message.includes('@xenova/transformers')) {
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
    console.log('[WhisperProvider] transcribe() called for:', audioFilePath);
    if (!this.pipeline) {
      throw new Error('Pipeline not initialized. Call setup() first.');
    }

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    const fileSize = fs.statSync(audioFilePath).size;
    console.log('[WhisperProvider] Audio file size:', (fileSize / (1024 * 1024)).toFixed(1), 'MB');

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
      // ── Decode WAV PCM into Float32Array ──────────────────────────────
      // @xenova/transformers WhisperFeatureExtractor expects Float32Array of
      // normalised PCM samples (range -1.0 to 1.0), NOT a Node.js Buffer.
      // Since we pre-convert to 16 kHz mono 16-bit PCM WAV above, we can
      // parse the WAV header to find the data chunk and convert directly.
      const rawBuf = fs.readFileSync(fileToRead);
      let audioData;

      if (_isWavFile(fileToRead)) {
        audioData = _decodeWavToFloat32(rawBuf);
        console.log('[WhisperProvider] Decoded WAV to Float32Array:', audioData.length, 'samples');
      } else {
        // Non-WAV fallback — pass raw buffer and hope transformers can handle it
        console.warn('[WhisperProvider] Non-WAV input — passing raw buffer (may fail)');
        audioData = rawBuf;
      }

      // Call the pipeline with transcription options
      const result = await this.pipeline(audioData, {
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
