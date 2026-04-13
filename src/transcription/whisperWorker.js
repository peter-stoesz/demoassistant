'use strict';

/**
 * whisperWorker.js
 * ----------------
 * Child process that runs Whisper transcription in a SEPARATE OS PROCESS.
 *
 * Using child_process.fork() instead of worker_threads because ONNX Runtime
 * native crashes (SIGTRAP/breakpoint) kill the entire process.  With a
 * forked child, the crash only kills this child — the parent Electron
 * process stays alive and can show an error to the user.
 *
 * Communication is via Node.js IPC (process.send / process.on('message')).
 *
 * Messages FROM parent:
 *   { type: 'setup',      modelId, modelsDir }
 *   { type: 'transcribe', audioFilePath, options, jobId }
 *   { type: 'dispose' }
 *
 * Messages TO parent:
 *   { type: 'setup-progress', data }
 *   { type: 'setup-done' }
 *   { type: 'setup-error',      error }
 *   { type: 'transcribe-chunk', jobId, segments, fullText, chunkIndex }
 *   { type: 'transcribe-done',  jobId, result }
 *   { type: 'transcribe-error', jobId, error }
 *   { type: 'disposed' }
 *   { type: 'ready' }          — sent on startup to confirm IPC works
 */

// ── Block onnxruntime-node BEFORE anything else loads ───────────────────────
// onnxruntime-node 1.14.0's native 'cpu' execution provider crashes with
// SIGTRAP on macOS ARM64 (and sometimes x64).  The crash is a native signal
// that kills this child process before JavaScript try/catch can intercept it.
//
// @xenova/transformers' internal onnx.js backend does a STATIC ESM import:
//   import * as ONNX_NODE from 'onnxruntime-node';
//   import * as ONNX_WEB  from 'onnxruntime-web';
//
// Static imports can't be intercepted by Module._resolveFilename.  Instead
// we create a SHIM package at a path that ESM resolution finds FIRST:
//
//   @xenova/transformers/node_modules/onnxruntime-node/
//
// ESM bare-specifier resolution walks up from the importing file
// (backends/onnx.js) and hits this shim before reaching the real
// onnxruntime-node in the project root's node_modules/.  The shim simply
// re-exports onnxruntime-web — so onnx.js gets the WASM runtime instead
// of the native one.  No native addon loads, no SIGTRAP.
//
// After shimming, the onnx.js code still adds 'cpu' to executionProviders
// (because it detects a Node.js environment).  whisperProvider's
// _forceWasmExecution() safely removes 'cpu' by importing onnx.js —
// which is now safe because the native addon was never loaded.
const fs = require('fs');
const path = require('path');

function _installOnnxShim() {
  // Find the @xenova/transformers package directory
  const candidates = [
    // Dev layout: relative to this worker file (src/transcription/whisperWorker.js)
    path.resolve(__dirname, '..', '..', 'node_modules', '@xenova', 'transformers'),
  ];

  // Packaged Electron app: look in asar.unpacked
  try {
    const resourcesPath = process.resourcesPath || '';
    if (resourcesPath) {
      candidates.push(
        path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@xenova', 'transformers'),
        path.join(resourcesPath, 'app', 'node_modules', '@xenova', 'transformers')
      );
    }
  } catch (_) {}

  for (const transformersDir of candidates) {
    // Verify this is actually the transformers package
    const pkgJson = path.join(transformersDir, 'package.json');
    try {
      if (!fs.existsSync(pkgJson)) continue;
    } catch (_) { continue; }

    const shimDir = path.join(transformersDir, 'node_modules', 'onnxruntime-node');
    try {
      fs.mkdirSync(shimDir, { recursive: true });

      // package.json — CommonJS so the static import gets our shim via ESM interop
      fs.writeFileSync(
        path.join(shimDir, 'package.json'),
        JSON.stringify({ name: 'onnxruntime-node', version: '0.0.0-wasm-shim', main: 'index.js' }),
        'utf8'
      );

      // index.js — re-export onnxruntime-web (pure JS/WASM, no native addon)
      fs.writeFileSync(
        path.join(shimDir, 'index.js'),
        '// WASM-only shim: re-export onnxruntime-web instead of native onnxruntime-node\n' +
        'module.exports = require("onnxruntime-web");\n',
        'utf8'
      );

      console.log(`[whisperWorker] Installed onnxruntime-node → onnxruntime-web shim at: ${shimDir}`);
      return true;
    } catch (e) {
      console.warn(`[whisperWorker] Failed to create shim at ${shimDir}: ${e.message}`);
    }
  }

  console.warn('[whisperWorker] Could not install onnxruntime-node shim — native provider may still load');
  return false;
}

_installOnnxShim();

// Lazy-loaded WhisperProvider — only created on first 'setup' message
let provider = null;

function send(msg) {
  try {
    if (process.send) process.send(msg);
  } catch (_) {
    // Parent may have disconnected — ignore
  }
}

// Signal to parent that the child is alive
send({ type: 'ready' });

process.on('message', async (msg) => {
  switch (msg.type) {

    // ── Setup / model download ─────────────────────────────────────────
    case 'setup': {
      try {
        const WhisperProvider = require('./whisperProvider');
        provider = new WhisperProvider({
          modelId:   msg.modelId,
          modelsDir: msg.modelsDir,
          quantized: msg.quantized !== undefined ? msg.quantized : true
        });

        await provider.setup((progress) => {
          send({ type: 'setup-progress', data: progress });
        });

        send({ type: 'setup-done' });
      } catch (err) {
        send({ type: 'setup-error', error: err.message });
      }
      break;
    }

    // ── Transcribe an audio file ───────────────────────────────────────
    case 'transcribe': {
      const { audioFilePath, options, jobId } = msg;
      try {
        // Lazy setup if not already ready
        if (!provider || !await provider.isReady()) {
          send({
            type: 'transcribe-error',
            jobId,
            error: 'Provider not ready. Send a "setup" message first.'
          });
          break;
        }

        const transcribeOptions = {
          ...options,
          onChunk: (segments, fullText, chunkIndex) => {
            send({
              type: 'transcribe-chunk',
              jobId,
              segments,
              fullText,
              chunkIndex
            });
          }
        };

        const result = await provider.transcribe(audioFilePath, transcribeOptions);
        send({ type: 'transcribe-done', jobId, result });
      } catch (err) {
        send({
          type: 'transcribe-error',
          jobId,
          error: err.message
        });
      }
      break;
    }

    // ── Dispose ────────────────────────────────────────────────────────
    case 'dispose': {
      try {
        if (provider) await provider.dispose();
      } catch (_) {}
      provider = null;
      send({ type: 'disposed' });
      break;
    }
  }
});

// Keep the process alive while waiting for messages
process.on('disconnect', () => {
  // Parent disconnected — clean exit
  process.exit(0);
});

// Catch unhandled errors so they become messages rather than silent crashes
process.on('uncaughtException', (err) => {
  console.error('[whisperWorker] Uncaught exception:', err.message);
  send({ type: 'fatal-error', error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[whisperWorker] Unhandled rejection:', msg);
  send({ type: 'fatal-error', error: msg });
});
