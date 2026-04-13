'use strict';

/**
 * memoryMonitor.js
 * ----------------
 * S1-5: Memory-pressure monitor.
 * Polls process.memoryUsage() every 30 seconds during recording.
 * Logs a warning at 70% of available system memory and notifies
 * the user via a UI toast (Electron Notification).
 */

const os = require('os');

// ─── State ──────────────────────────────────────────────────────────────────

let pollTimer = null;
let warningShown = false;
const POLL_INTERVAL_MS = 30000;   // 30 seconds
const WARNING_THRESHOLD = 0.70;   // 70% of total system memory

// ─── Callbacks ──────────────────────────────────────────────────────────────

let _onWarning = null;   // (memoryInfo) => void

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * start({ onWarning })
 * Begin polling memory usage. Call when recording starts.
 * @param {Object} opts
 * @param {Function} opts.onWarning - called once when threshold is exceeded
 */
function start(opts = {}) {
  if (pollTimer) return; // already running
  _onWarning = opts.onWarning || null;
  warningShown = false;

  pollTimer = setInterval(() => {
    const memInfo = getMemoryInfo();
    const usageRatio = memInfo.processRss / memInfo.totalSystem;

    if (usageRatio >= WARNING_THRESHOLD && !warningShown) {
      warningShown = true;
      const msg = `Memory warning: process is using ${memInfo.processRssMB} MB ` +
                  `(${(usageRatio * 100).toFixed(0)}% of ${memInfo.totalSystemMB} MB system RAM)`;
      console.warn('[memoryMonitor]', msg);
      if (_onWarning) {
        _onWarning(memInfo);
      }
    }

    // Always log at debug level
    console.log(
      `[memoryMonitor] RSS=${memInfo.processRssMB} MB | ` +
      `Heap=${memInfo.heapUsedMB}/${memInfo.heapTotalMB} MB | ` +
      `System=${memInfo.totalSystemMB} MB`
    );
  }, POLL_INTERVAL_MS);

  console.log('[memoryMonitor] Started polling every', POLL_INTERVAL_MS / 1000, 's');
}

/**
 * stop()
 * Stop polling. Call when recording stops.
 */
function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  warningShown = false;
  _onWarning = null;
  console.log('[memoryMonitor] Stopped');
}

/**
 * getMemoryInfo()
 * Returns a snapshot of current memory usage.
 */
function getMemoryInfo() {
  const mem = process.memoryUsage();
  const totalSystem = os.totalmem();

  return {
    processRss:       mem.rss,
    processRssMB:     +(mem.rss / (1024 * 1024)).toFixed(1),
    heapUsed:         mem.heapUsed,
    heapUsedMB:       +(mem.heapUsed / (1024 * 1024)).toFixed(1),
    heapTotal:        mem.heapTotal,
    heapTotalMB:      +(mem.heapTotal / (1024 * 1024)).toFixed(1),
    external:         mem.external,
    externalMB:       +(mem.external / (1024 * 1024)).toFixed(1),
    totalSystem,
    totalSystemMB:    +(totalSystem / (1024 * 1024)).toFixed(0),
    usagePercent:     +((mem.rss / totalSystem) * 100).toFixed(1)
  };
}

/**
 * isRunning()
 * Returns true if the monitor is currently polling.
 */
function isRunning() {
  return pollTimer !== null;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { start, stop, getMemoryInfo, isRunning };
