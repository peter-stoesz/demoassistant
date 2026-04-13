'use strict';

/**
 * appLogger.js
 * ────────────
 * Centralised application logger for Demo Assistant.
 * Persists structured log entries to a JSON-lines file in userData/logs/.
 * Exposes helpers for success, error, warn, and info levels.
 * Keeps an in-memory ring buffer (last 2000 entries) for fast UI queries.
 *
 * Runs in the main Electron process.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Log levels ──────────────────────────────────────────────────────────────

const LEVELS = {
  SUCCESS: 'success',
  ERROR:   'error',
  WARN:    'warn',
  INFO:    'info'
};

const MAX_MEMORY = 2000;      // entries kept in RAM
const MAX_FILE_BYTES = 5e6;   // 5 MB — rotate after this

// ─── Logger class ────────────────────────────────────────────────────────────

class AppLogger extends EventEmitter {
  constructor() {
    super();
    this.entries = [];         // in-memory ring buffer
    this.logDir = null;
    this.logFilePath = null;
    this.stream = null;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  init({ userDataPath }) {
    this.logDir = path.join(userDataPath, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });

    this.logFilePath = path.join(this.logDir, 'app.log');

    // Load existing entries from disk (up to MAX_MEMORY most recent)
    this._loadFromDisk();

    // Open append stream
    this.stream = fs.createWriteStream(this.logFilePath, { flags: 'a' });

    // Log startup
    this.info('app', 'Demo Assistant logger initialised');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  success(category, message, detail = null) {
    return this._log(LEVELS.SUCCESS, category, message, detail);
  }

  error(category, message, detail = null) {
    return this._log(LEVELS.ERROR, category, message, detail);
  }

  warn(category, message, detail = null) {
    return this._log(LEVELS.WARN, category, message, detail);
  }

  info(category, message, detail = null) {
    return this._log(LEVELS.INFO, category, message, detail);
  }

  // ── Query API (used by IPC handlers) ────────────────────────────────────────

  /**
   * getEntries({ level, category, search, limit, offset })
   * Returns { entries: [...], total }
   */
  getEntries({ level, category, search, limit = 100, offset = 0 } = {}) {
    let filtered = [...this.entries];

    if (level && level !== 'all') {
      filtered = filtered.filter(e => e.level === level);
    }
    if (category && category !== 'all') {
      filtered = filtered.filter(e => e.category === category);
    }
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(e =>
        e.message.toLowerCase().includes(q) ||
        (e.detail && JSON.stringify(e.detail).toLowerCase().includes(q))
      );
    }

    // Most recent first
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return { entries: page, total };
  }

  /**
   * getCategories()
   * Returns array of unique category strings seen so far.
   */
  getCategories() {
    const cats = new Set(this.entries.map(e => e.category));
    return Array.from(cats).sort();
  }

  /**
   * clearLogs()
   * Wipes in-memory buffer and truncates the log file.
   */
  clearLogs() {
    this.entries = [];
    if (this.stream) {
      this.stream.end();
    }
    try {
      fs.writeFileSync(this.logFilePath, '');
    } catch (_) { /* ignore */ }
    this.stream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
    this.info('app', 'Logs cleared by user');
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _log(level, category, message, detail) {
    const entry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level,
      category: String(category || 'general'),
      message: String(message || ''),
      detail: detail || null
    };

    // Push to in-memory ring buffer
    this.entries.push(entry);
    if (this.entries.length > MAX_MEMORY) {
      this.entries.shift();
    }

    // Write to disk
    if (this.stream) {
      this.stream.write(JSON.stringify(entry) + '\n');
    }

    // Rotate file if too large
    this._maybeRotate();

    // Emit so main process can forward to renderer
    this.emit('log', entry);

    // Also forward to console for dev visibility
    const tag = `[${level.toUpperCase()}][${category}]`;
    if (level === LEVELS.ERROR) {
      console.error(tag, message, detail || '');
    } else if (level === LEVELS.WARN) {
      console.warn(tag, message, detail || '');
    } else {
      console.log(tag, message, detail || '');
    }

    return entry;
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(this.logFilePath)) return;

      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      // Take only the most recent MAX_MEMORY lines
      const recent = lines.slice(-MAX_MEMORY);

      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          if (entry.id && entry.timestamp && entry.level) {
            this.entries.push(entry);
          }
        } catch (_) {
          // skip malformed lines
        }
      }
    } catch (e) {
      console.warn('[appLogger] Could not load existing logs:', e.message);
    }
  }

  _maybeRotate() {
    try {
      if (!this.logFilePath) return;
      const stats = fs.statSync(this.logFilePath);
      if (stats.size > MAX_FILE_BYTES) {
        // Rename current to .old, start fresh
        const oldPath = this.logFilePath + '.old';
        if (this.stream) this.stream.end();
        try { fs.unlinkSync(oldPath); } catch (_) { /* ok */ }
        fs.renameSync(this.logFilePath, oldPath);
        this.stream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      }
    } catch (_) { /* ignore rotation errors */ }
  }
}

// ─── Singleton export ────────────────────────────────────────────────────────

module.exports = new AppLogger();
