'use strict';

/**
 * workerProvider.js
 * -----------------
 * Transcription provider that delegates all heavy work to a CHILD PROCESS.
 *
 * This is a drop-in replacement for WhisperProvider — it implements the same
 * TranscriptionProvider interface.  Internally it spawns whisperWorker.js via
 * child_process.fork(), so:
 *
 *   1. ONNX Runtime native crashes (SIGTRAP, segfault) only kill the child
 *      process — the main Electron process stays alive.
 *   2. Long-running inference doesn't block the main/Electron UI thread.
 *   3. The child can be killed and restarted if it hangs or crashes.
 *
 * Why fork() instead of worker_threads?
 * ------------------------------------
 * worker_threads share the same OS process. A native SIGTRAP (like the one
 * ONNX Runtime's BFCArena triggers on allocation failure) kills every thread
 * in the process — including the Electron main thread. child_process.fork()
 * creates a separate OS process, so native crashes are fully contained.
 *
 * Architecture detection
 * ---------------------
 * On macOS Apple Silicon, if the Electron app is running under Rosetta
 * (x86_64 translated), ONNX Runtime's x64 binary is used and may crash
 * on certain models.  This provider detects that situation and emits a
 * warning so the UI can inform the user to run the native arm64 build.
 */

const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const TranscriptionProvider = require('./provider');

// ─── Architecture helpers ────────────────────────────────────────────────────

/**
 * Detect if the current process is running under Apple Rosetta 2.
 * Returns true when an arm64 Mac is running an x86_64-translated process.
 */
function isRunningUnderRosetta() {
  if (process.platform !== 'darwin') return false;

  // process.arch reports the *binary* architecture, not the CPU.
  // On an arm64 Mac running an x86_64 binary, process.arch === 'x64'.
  if (process.arch !== 'x64') return false;

  try {
    // sysctl.proc_translated is 1 when running under Rosetta
    const result = execSync('sysctl -n sysctl.proc_translated', {
      encoding: 'utf8',
      timeout: 3000
    }).trim();
    return result === '1';
  } catch (_) {
    // If the sysctl key doesn't exist, we're on a genuine Intel Mac
    return false;
  }
}

/**
 * Get a human-readable architecture description for logging and warnings.
 */
function getArchInfo() {
  const cpuArch = os.arch();       // CPU architecture (arm64 / x64)
  const procArch = process.arch;   // Binary architecture the process was built for
  const rosetta = isRunningUnderRosetta();
  return { cpuArch, procArch, rosetta };
}

// ─── WorkerProvider ──────────────────────────────────────────────────────────

class WorkerProvider extends TranscriptionProvider {
  /**
   * @param {Object} options
   * @param {string} options.modelId   - Whisper model identifier
   * @param {string} options.modelsDir - Path to model cache directory
   */
  constructor(options = {}) {
    super();
    this.modelId = options.modelId || 'Xenova/whisper-base.en';
    this.modelsDir = options.modelsDir || '';
    this._child = null;
    this._ready = false;
    this._quantized = true;          // start with quantized; fall back if crash
    this._triedNonQuantized = false;  // track fallback attempts
    this._archInfo = getArchInfo();
    this._workerPath = path.join(__dirname, 'whisperWorker.js');

    // Log architecture info once at construction
    const ai = this._archInfo;
    const tag = ai.rosetta
      ? `CPU=${ai.cpuArch}, Binary=${ai.procArch} (ROSETTA — x64 on arm64)`
      : `CPU=${ai.cpuArch}, Binary=${ai.procArch}`;
    console.log(`[WorkerProvider] Architecture: ${tag}`);

    if (ai.rosetta) {
      console.warn(
        '[WorkerProvider] \u26A0 Running under Rosetta 2 translation. ' +
        'ONNX Runtime may crash with larger Whisper models. ' +
        'For best results, run the native arm64 build of Demo Assistant.'
      );
    }
  }

  get engineVersion() {
    const modelName = this.modelId.split('/').pop();
    return `${modelName}-v1`;
  }

  /**
   * Whether we're running under Rosetta (x64 on arm64 Mac).
   * UI can use this to show a warning banner.
   */
  get isRosetta() {
    return this._archInfo.rosetta;
  }

  /**
   * Architecture info for diagnostics.
   */
  get archInfo() {
    return { ...this._archInfo };
  }

  async isReady() {
    return this._ready && this._child !== null && this._child.connected;
  }

  /**
   * Spawn the child process and run model setup (download + pipeline init).
   *
   * If the child crashes during setup (typically due to ONNX Runtime's
   * quantized MatMul PrePack allocating too much memory), automatically
   * retries once with quantized=false (non-quantized float32 model).
   */
  async setup(onProgress) {
    try {
      await this._setupOnce(onProgress, this._quantized);
    } catch (setupError) {
      // If the crash looks like a native crash and we haven't tried non-quantized yet
      if (this._quantized && !this._triedNonQuantized) {
        console.warn(
          '[WorkerProvider] Setup with quantized model crashed. ' +
          'Retrying with non-quantized (float32) model...'
        );
        this._quantized = false;
        this._triedNonQuantized = true;

        if (onProgress) {
          onProgress({
            status: 'retrying',
            progress: 0,
            file: this.modelId,
            message: 'Quantized model crashed. Retrying with float32 model (larger download)...'
          });
        }

        // Retry with non-quantized
        await this._setupOnce(onProgress, false);
        return;
      }
      throw setupError;
    }
  }

  /**
   * Internal: spawn child and run setup with given quantization setting.
   */
  async _setupOnce(onProgress, quantized) {
    // Kill previous child if any
    await this._killChild();

    return new Promise((resolve, reject) => {
      let settled = false;

      // Setup timeout: 5 minutes. Covers model download + WASM compilation.
      // Progress resets the timer so active downloads don't time out.
      const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
      let setupTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._ready = false;
          console.error('[WorkerProvider] Setup timed out after 5 minutes');
          this._killChild();
          reject(new Error(
            'Transcription engine setup timed out (5 minutes). ' +
            'The model may be too large for the WASM backend. ' +
            'Try a smaller model (e.g., Xenova/whisper-base.en) in Settings.'
          ));
        }
      }, SETUP_TIMEOUT_MS);

      // Reset timeout on progress — active downloads/loading shouldn't time out
      const resetSetupTimer = () => {
        if (setupTimer) {
          clearTimeout(setupTimer);
          setupTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              this._ready = false;
              console.error('[WorkerProvider] Setup timed out (no progress for 5 minutes)');
              this._killChild();
              reject(new Error(
                'Transcription engine setup stalled (no progress for 5 minutes). ' +
                'Try a smaller model (e.g., Xenova/whisper-base.en) in Settings.'
              ));
            }
          }, SETUP_TIMEOUT_MS);
        }
      };

      const settle = () => {
        if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
      };

      // Fork a new child process running whisperWorker.js.
      // ELECTRON_RUN_AS_NODE=1 is critical — without it, fork() creates
      // another Electron app instance (which exits immediately with code 0
      // because there's no BrowserWindow). With this flag, the child runs
      // as a plain Node.js process.
      const child = fork(this._workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      this._child = child;

      // Pipe child stdout/stderr to console for debugging
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          console.log(`[whisperWorker:stdout] ${data.toString().trim()}`);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          console.error(`[whisperWorker:stderr] ${data.toString().trim()}`);
        });
      }

      const onMessage = (msg) => {
        switch (msg.type) {
          case 'setup-progress':
            resetSetupTimer();
            if (onProgress) onProgress(msg.data);
            break;

          case 'setup-done':
            this._ready = true;
            child.removeListener('message', onMessage);
            if (!settled) {
              settled = true;
              settle();
              console.log(`[WorkerProvider] Setup complete (quantized=${quantized})`);
              resolve();
            }
            break;

          case 'setup-error':
            this._ready = false;
            child.removeListener('message', onMessage);
            if (!settled) {
              settled = true;
              settle();
              this._killChild();
              reject(new Error(msg.error));
            }
            break;

          case 'fatal-error':
            if (!settled) {
              settled = true;
              settle();
              this._ready = false;
              reject(new Error(`Transcription engine fatal error: ${msg.error}`));
            }
            break;
        }
      };

      child.on('message', onMessage);

      child.on('error', (err) => {
        this._ready = false;
        this._child = null;
        if (!settled) {
          settled = true;
          settle();
          reject(new Error(`Failed to start transcription process: ${err.message}`));
        }
      });

      child.on('exit', (code, signal) => {
        const wasReady = this._ready;
        this._child = null;
        this._ready = false;

        if (!settled) {
          settled = true;
          settle();
          const sigInfo = signal ? ` (signal: ${signal})` : '';
          const rosettaHint = this._archInfo.rosetta
            ? ' This may be caused by running the x86_64 build on Apple Silicon via Rosetta. ' +
              'Try the native arm64 build instead.'
            : '';

          reject(new Error(
            `Transcription engine crashed during setup (exit code ${code}${sigInfo}).${rosettaHint} ` +
            'This is usually caused by the ONNX Runtime failing to allocate memory for the model. ' +
            'Try a smaller model (e.g., whisper-base.en) or close other applications to free memory.'
          ));
        } else if (wasReady && code !== 0) {
          console.error(
            `[WorkerProvider] Child process exited unexpectedly (code=${code}, signal=${signal})`
          );
        }
      });

      // Send setup command with quantized flag
      child.send({
        type: 'setup',
        modelId: this.modelId,
        modelsDir: this.modelsDir,
        quantized: quantized
      });
    });
  }

  /**
   * Transcribe an audio file via the child process.
   *
   * If the child crashes during inference (SIGTRAP from quantized MatMul)
   * and we haven't tried float32 yet, automatically re-setup with
   * quantized=false and retry the transcription once.
   */
  async transcribe(audioFilePath, options = {}) {
    try {
      return await this._transcribeOnce(audioFilePath, options);
    } catch (err) {
      // Check if this looks like a native crash during quantized inference
      const isNativeCrash = err.message.includes('crashed') ||
                            err.message.includes('SIGTRAP') ||
                            err.message.includes('exit code');

      if (isNativeCrash && this._quantized && !this._triedNonQuantized) {
        console.warn(
          '[WorkerProvider] Transcription crashed with quantized model. ' +
          'Re-initializing with float32 model and retrying...'
        );

        this._quantized = false;
        this._triedNonQuantized = true;

        // Re-setup with float32 model
        await this.setup((progress) => {
          console.log(`[WorkerProvider] Float32 re-setup progress: ${progress.status}`);
        });

        // Retry the transcription
        return await this._transcribeOnce(audioFilePath, options);
      }

      throw err;
    }
  }

  /**
   * Internal: single-attempt transcription via the child process.
   */
  async _transcribeOnce(audioFilePath, options = {}) {
    if (!this._child || !this._ready || !this._child.connected) {
      throw new Error('Transcription process not ready. Call setup() first.');
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const onChunk = options.onChunk || null;
      let settled = false;

      // Transcription timeout: 10 minutes per attempt.
      // Chunk progress resets the timer so long files don't time out
      // as long as they're making forward progress.
      const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;
      let transcribeTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.error('[WorkerProvider] Transcription timed out after 10 minutes');
          this._child.removeListener('message', messageHandler);
          this._killChild();
          reject(new Error(
            'Transcription timed out (10 minutes with no progress). ' +
            'The model may be too large for the WASM backend. ' +
            'Try a smaller model (e.g., Xenova/whisper-base.en) in Settings.'
          ));
        }
      }, TRANSCRIBE_TIMEOUT_MS);

      const resetTranscribeTimer = () => {
        if (transcribeTimer) {
          clearTimeout(transcribeTimer);
          transcribeTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              console.error('[WorkerProvider] Transcription stalled (no progress for 10 minutes)');
              this._child.removeListener('message', messageHandler);
              this._killChild();
              reject(new Error(
                'Transcription stalled (no progress for 10 minutes). ' +
                'Try a smaller model (e.g., Xenova/whisper-base.en) in Settings.'
              ));
            }
          }, TRANSCRIBE_TIMEOUT_MS);
        }
      };

      const clearTimer = () => {
        if (transcribeTimer) { clearTimeout(transcribeTimer); transcribeTimer = null; }
      };

      const messageHandler = (msg) => {
        if (msg.jobId && msg.jobId !== jobId) return;

        switch (msg.type) {
          case 'transcribe-chunk':
            resetTranscribeTimer();
            if (onChunk) {
              onChunk(msg.segments, msg.fullText, msg.chunkIndex);
            }
            break;

          case 'transcribe-done':
            settled = true;
            clearTimer();
            this._child.removeListener('message', messageHandler);
            resolve(msg.result);
            break;

          case 'transcribe-error':
            settled = true;
            clearTimer();
            this._child.removeListener('message', messageHandler);
            reject(new Error(msg.error));
            break;

          case 'fatal-error':
            if (!settled) {
              settled = true;
              clearTimer();
              this._child.removeListener('message', messageHandler);
              reject(new Error(`Transcription engine crashed: ${msg.error}`));
            }
            break;
        }
      };

      // If the child crashes mid-transcription, reject with a helpful message
      const exitHandler = (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimer();
          this._child = null;
          this._ready = false;

          const sigInfo = signal ? ` (signal: ${signal})` : '';
          const rosettaHint = this._archInfo.rosetta
            ? ' This is likely caused by running the x86_64 build on Apple Silicon (Rosetta). ' +
              'Please download and run the native arm64 (Apple Silicon) build instead.'
            : '';

          reject(new Error(
            `Transcription engine crashed (exit code ${code}${sigInfo}).${rosettaHint} ` +
            'This may be caused by the model being too large for available memory. ' +
            'Try a smaller model (whisper-base.en) or close other applications. ' +
            'The engine will be restarted on the next attempt.'
          ));
        }
      };

      this._child.on('message', messageHandler);
      this._child.once('exit', exitHandler);

      // Send the transcription command
      this._child.send({
        type: 'transcribe',
        audioFilePath,
        options: { language: options.language }, // only serializable fields
        jobId
      });
    });
  }

  async dispose() {
    await this._killChild();
    this._ready = false;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Kill the current child process, if any.
   */
  async _killChild() {
    if (this._child) {
      try {
        // Try graceful shutdown first
        if (this._child.connected) {
          this._child.send({ type: 'dispose' });
          // Give it 3 seconds to clean up
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              resolve();
            }, 3000);
            this._child.once('exit', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }
        // Force kill if still alive
        if (this._child && !this._child.killed) {
          this._child.kill('SIGKILL');
        }
      } catch (_) {}
      this._child = null;
    }
  }
}

// Export the class and the architecture helpers (for use in main.js)
module.exports = WorkerProvider;
module.exports.isRunningUnderRosetta = isRunningUnderRosetta;
module.exports.getArchInfo = getArchInfo;
