/**
 * sharp stub (ESM)
 * ────────────────
 * Drop-in replacement for the real `sharp` native module.
 * Exports a callable constructor that returns a chainable no-op object,
 * so @xenova/transformers can import it and initialise without crashing.
 *
 * Image-processing methods are never actually called in this app
 * (we only use Whisper for audio transcription), but the stub satisfies
 * the top-level `import sharp from 'sharp'` in transformers' image.js.
 */

const noopChain = () => proxy;

const handler = {
  get(_target, prop) {
    // .metadata() needs to return a promise that resolves to an object
    if (prop === 'metadata') return () => Promise.resolve({ channels: 4, width: 0, height: 0 });
    // .toBuffer() needs to return a promise
    if (prop === 'toBuffer') return () => Promise.resolve({ data: Buffer.alloc(0), info: { width: 0, height: 0, channels: 4 } });
    // Everything else returns the proxy for chaining (.rotate(), .raw(), .resize(), etc.)
    return noopChain;
  }
};

const proxy = new Proxy(function () {}, handler);

function sharp(input, options) {
  return proxy;
}

export default sharp;
