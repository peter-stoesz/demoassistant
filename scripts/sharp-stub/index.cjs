/**
 * sharp stub (CJS fallback)
 */
const noopChain = () => proxy;

const handler = {
  get(_target, prop) {
    if (prop === 'metadata') return () => Promise.resolve({ channels: 4, width: 0, height: 0 });
    if (prop === 'toBuffer') return () => Promise.resolve({ data: Buffer.alloc(0), info: { width: 0, height: 0, channels: 4 } });
    return noopChain;
  }
};

const proxy = new Proxy(function () {}, handler);

function sharp(input, options) {
  return proxy;
}

module.exports = sharp;
module.exports.default = sharp;
