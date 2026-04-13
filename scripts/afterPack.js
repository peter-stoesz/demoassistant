'use strict';

const { execSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');

module.exports = async function afterPack(context) {
  // Only needed on macOS
  if (process.platform !== 'darwin') return;

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    console.log(`[afterPack] .app not found at ${appPath}, skipping xattr strip`);
    return;
  }

  console.log(`[afterPack] Stripping extended attributes from: ${appPath}`);

  try {
    execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });
    console.log('[afterPack] Extended attributes stripped successfully');
  } catch (err) {
    // Non-fatal
    console.warn('[afterPack] xattr command failed:', err.message);
  }
};
