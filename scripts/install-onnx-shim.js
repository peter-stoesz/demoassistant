#!/usr/bin/env node
'use strict';

/**
 * install-onnx-shim.js
 * --------------------
 * Postinstall script that creates a shim package at:
 *   node_modules/@xenova/transformers/node_modules/onnxruntime-node/
 *
 * This shim re-exports onnxruntime-web instead of the native onnxruntime-node.
 * ESM bare-specifier resolution walks up from the importing file (onnx.js inside
 * @xenova/transformers) and hits this shim BEFORE reaching the real onnxruntime-node
 * in the project root's node_modules.  Result: no native addon loads, no SIGTRAP.
 *
 * Why?
 * ----
 * onnxruntime-node's native binary (onnxruntime_binding.node) crashes with SIGTRAP
 * on macOS when loaded inside Electron or a child process forked from Electron.
 * The crash is a native signal that kills the process before JavaScript can catch it.
 * By shimming to onnxruntime-web, we get the WASM runtime instead — slower but stable.
 */

const fs = require('fs');
const path = require('path');

const transformersDir = path.resolve(__dirname, '..', 'node_modules', '@xenova', 'transformers');
const shimDir = path.join(transformersDir, 'node_modules', 'onnxruntime-node');

// Only install if @xenova/transformers is present
if (!fs.existsSync(path.join(transformersDir, 'package.json'))) {
  console.log('[install-onnx-shim] @xenova/transformers not found — skipping shim');
  process.exit(0);
}

// Check if onnxruntime-web is available
try {
  require.resolve('onnxruntime-web');
} catch (_) {
  console.warn('[install-onnx-shim] onnxruntime-web not installed — skipping shim');
  process.exit(0);
}

try {
  fs.mkdirSync(shimDir, { recursive: true });

  fs.writeFileSync(
    path.join(shimDir, 'package.json'),
    JSON.stringify({
      name: 'onnxruntime-node',
      version: '0.0.0-wasm-shim',
      description: 'Shim: redirects to onnxruntime-web to avoid native SIGTRAP crashes',
      main: 'index.js'
    }, null, 2) + '\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(shimDir, 'index.js'),
    '// WASM-only shim: re-export onnxruntime-web instead of native onnxruntime-node.\n' +
    '// Prevents native ONNX Runtime addon from loading (crashes with SIGTRAP in Electron).\n' +
    'module.exports = require("onnxruntime-web");\n',
    'utf8'
  );

  console.log('[install-onnx-shim] Installed onnxruntime-node → onnxruntime-web shim at:', shimDir);
} catch (err) {
  console.error('[install-onnx-shim] Failed to install shim:', err.message);
  process.exit(1);
}
