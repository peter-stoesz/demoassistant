'use strict';

/**
 * beforeBuild.js
 * ──────────────
 * electron-builder hook that runs BEFORE the build/pack step.
 *
 * Purpose: replace the real `sharp` native module with a lightweight pure-JS
 * stub so that @xenova/transformers can import it without crashing.
 *
 * Why this is needed:
 *   - transformers/src/utils/image.js has a top-level `import sharp from 'sharp'`
 *   - The real sharp bundles libvips native binaries that break in Electron asar
 *   - If sharp is missing entirely, the ESM import throws and takes down all of
 *     transformers (even though we only use Whisper for audio, not images)
 *   - The stub exports a truthy callable so transformers initialises, but the
 *     image code paths (which we never hit) are no-ops
 */

const fs   = require('fs');
const path = require('path');

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[beforeBuild] Removed: ${dir}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = async function beforeBuild(context) {
  const projectDir = context.appDir || context.projectDir || process.cwd();
  const stubSrc    = path.join(projectDir, 'scripts', 'sharp-stub');

  // Locations where sharp could live (hoisted or nested)
  const sharpDirs = [
    path.join(projectDir, 'node_modules', 'sharp'),
    path.join(projectDir, 'node_modules', '@xenova', 'transformers', 'node_modules', 'sharp'),
  ];

  for (const sharpDir of sharpDirs) {
    if (fs.existsSync(sharpDir)) {
      rmrf(sharpDir);
    }
  }

  // Install the stub in the top-level location
  const targetDir = sharpDirs[0];
  console.log(`[beforeBuild] Installing sharp stub → ${targetDir}`);
  copyDirSync(stubSrc, targetDir);

  // Verify the stub is in place
  const stubPkg = path.join(targetDir, 'package.json');
  if (fs.existsSync(stubPkg)) {
    const pkg = JSON.parse(fs.readFileSync(stubPkg, 'utf8'));
    console.log(`[beforeBuild] ✓ sharp stub v${pkg.version} installed — native binaries eliminated.`);
  } else {
    console.error('[beforeBuild] ✗ Failed to install sharp stub!');
    process.exit(1);
  }
};
