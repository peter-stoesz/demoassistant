'use strict';

/**
 * transcriptionConfig.js
 * ----------------------
 * Manages transcription settings stored in transcription-config.json.
 * Provides defaults for model selection, auto-transcribe toggle,
 * recording format, cleanup thresholds, and max recording duration.
 */

const fs   = require('fs');
const path = require('path');

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  modelId:            'Xenova/whisper-base.en',
  autoTranscribe:     true,
  recordingFormat:    'webm',         // 'webm' or 'wav'
  cleanupDays:        90,             // delete recordings older than N days
  maxRecordingMins:   240,            // safety valve: 4 hours
  liveTranscript:     true,           // show live transcript panel (future)
  modelDownloaded:    false,          // flag set after first successful download
  outputDir:          ''              // custom output folder for transcripts (empty = internal only)
};

// ─── State ───────────────────────────────────────────────────────────────────

let configPath = '';
let config     = { ...DEFAULTS };

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * init(userDataPath)
 * Load or create the config file.
 */
function init(userDataPath) {
  configPath = path.join(userDataPath, 'transcription-config.json');
  load();
}

function load() {
  try {
    if (fs.existsSync(configPath)) {
      const raw    = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      config = { ...DEFAULTS, ...parsed };
      return;
    }
  } catch (e) {
    console.error('[transcriptionConfig] Failed to load:', e.message);
  }
  // Write defaults on first run
  config = { ...DEFAULTS };
  save();
}

function save() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[transcriptionConfig] Failed to save:', e.message);
  }
}

// ─── Getters / Setters ──────────────────────────────────────────────────────

function getAll() {
  return { ...config };
}

function get(key) {
  return config[key];
}

function set(key, value) {
  if (DEFAULTS[key] === undefined) {
    console.warn('[transcriptionConfig] Unknown key:', key);
    return;
  }
  config[key] = value;
  save();
}

function update(partial) {
  for (const [k, v] of Object.entries(partial)) {
    if (DEFAULTS[k] !== undefined) {
      config[k] = v;
    }
  }
  save();
}

function reset() {
  config = { ...DEFAULTS };
  save();
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { init, getAll, get, set, update, reset, DEFAULTS };
