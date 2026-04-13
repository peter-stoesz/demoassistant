'use strict';

// ─── Floating Panel Factory (Sprint 3 — Task 3.1) ───────────────────────────
//
// Provides a reusable factory for small always-on-top BrowserWindow instances
// used by both the Zoom Lens and Cue Card features.  Each panel is:
//   • Always on top (screen-saver level on macOS)
//   • Visible on all workspaces (including fullscreen)
//   • Skips the taskbar / dock
//   • Optionally draggable by a CSS region
//   • Corner-pinned or cursor-following
//
// Usage:
//   const { createFloatingPanel } = require('./floatingPanel');
//   const panel = createFloatingPanel({ ... });
//   panel.show();

const { BrowserWindow, screen } = require('electron');
const path = require('path');

/**
 * @param {Object} opts
 * @param {number}  opts.width          — panel width in px (default 280)
 * @param {number}  opts.height         — panel height in px (default 180)
 * @param {string}  opts.htmlFile       — absolute path to the HTML file to load
 * @param {string}  [opts.preloadFile]  — absolute path to a preload script (optional)
 * @param {number}  [opts.x]            — initial x position
 * @param {number}  [opts.y]            — initial y position
 * @param {string}  [opts.anchor]       — 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'cursor'
 * @param {number}  [opts.opacity]      — window opacity 0–1 (default 1)
 * @param {boolean} [opts.roundedCorners] — enable rounded corners (default true)
 * @param {boolean} [opts.resizable]    — allow resizing (default false)
 * @param {boolean} [opts.focusable]    — allow focus (default true)
 * @param {boolean} [opts.clickThrough] — ignore mouse events (default false)
 * @returns {BrowserWindow}
 */
function createFloatingPanel(opts = {}) {
  const width  = opts.width  || 280;
  const height = opts.height || 180;

  // Compute initial position from anchor
  let { x, y } = computeAnchorPosition(opts.anchor, width, height, opts.x, opts.y);

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    transparent:    true,
    frame:          false,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    resizable:      opts.resizable !== undefined ? opts.resizable : false,
    movable:        true,
    focusable:      opts.focusable !== undefined ? opts.focusable : true,
    hasShadow:      true,
    roundedCorners: opts.roundedCorners !== undefined ? opts.roundedCorners : true,
    type:           process.platform === 'linux' ? 'dock' : undefined,
    webPreferences: {
      nodeIntegration:      false,
      contextIsolation:     true,
      preload:              opts.preloadFile || undefined,
      backgroundThrottling: false,
      devTools:             process.env.NODE_ENV === 'development'
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (opts.opacity !== undefined && opts.opacity < 1) {
    win.setOpacity(opts.opacity);
  }

  if (opts.clickThrough) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  win.loadFile(opts.htmlFile);

  // Store the anchor for re-positioning later
  win._panelAnchor = opts.anchor || null;

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

/**
 * Compute an initial window position based on a named screen corner.
 */
function computeAnchorPosition(anchor, width, height, explicitX, explicitY) {
  if (explicitX !== undefined && explicitY !== undefined) {
    return { x: explicitX, y: explicitY };
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x: sx, y: sy, width: sw, height: sh } = primaryDisplay.workArea;
  const margin = 20;

  switch (anchor) {
    case 'top-left':
      return { x: sx + margin, y: sy + margin };
    case 'top-right':
      return { x: sx + sw - width - margin, y: sy + margin };
    case 'bottom-left':
      return { x: sx + margin, y: sy + sh - height - margin };
    case 'bottom-right':
    default:
      return { x: sx + sw - width - margin, y: sy + sh - height - margin };
  }
}

/**
 * Reposition a panel so it stays fully within the nearest display.
 * Used when the cursor or a display change moves the panel offscreen.
 */
function clampToScreen(win) {
  if (win.isDestroyed()) return;

  const bounds  = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const wa      = display.workArea;

  let nx = bounds.x;
  let ny = bounds.y;

  if (nx + bounds.width > wa.x + wa.width)   nx = wa.x + wa.width - bounds.width;
  if (ny + bounds.height > wa.y + wa.height) ny = wa.y + wa.height - bounds.height;
  if (nx < wa.x) nx = wa.x;
  if (ny < wa.y) ny = wa.y;

  if (nx !== bounds.x || ny !== bounds.y) {
    win.setPosition(nx, ny);
  }
}

module.exports = { createFloatingPanel, computeAnchorPosition, clampToScreen };
