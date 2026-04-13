'use strict';

/**
 * recordingManager.js
 * ------------------
 * State machine managing the recording lifecycle.
 * States: IDLE, PROMPTING, RECORDING, STOPPING, PROCESSING
 * Runs in the main Electron process.
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── State enum ──────────────────────────────────────────────────────────────

const STATES = {
  IDLE: 'IDLE',
  PROMPTING: 'PROMPTING',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  PROCESSING: 'PROCESSING'
};

// ─── Recording Manager class ─────────────────────────────────────────────────

class RecordingManager extends EventEmitter {
  constructor() {
    super();
    this.state = STATES.IDLE;
    this.recordingId = null;
    this.opportunityId = null;
    this.filename = null;
    this.durationSeconds = 0;
    this.durationTimer = null;
    this.recordingsDir = null;
    this.savedFilePath = null;
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  /**
   * init({ userDataPath, onStateChange })
   * Set up recordings directory at userDataPath/recordings/
   */
  init({ userDataPath, onStateChange }) {
    this.recordingsDir = path.join(userDataPath, 'recordings');
    fs.mkdirSync(this.recordingsDir, { recursive: true });

    if (typeof onStateChange === 'function') {
      this.on('stateChange', onStateChange);
    }
  }

  // ─── State machine transitions ─────────────────────────────────────────────

  /**
   * startRecordingFlow()
   * Transition: IDLE → PROMPTING
   * Returns: true/false
   */
  startRecordingFlow() {
    if (this.state !== STATES.IDLE) {
      console.warn('[recordingManager] Cannot start flow from state:', this.state);
      return false;
    }

    this._setState(STATES.PROMPTING);
    return true;
  }

  /**
   * confirmAndRecord(opportunityId)
   * Transition: PROMPTING → RECORDING
   * Generates UUID + timestamp filename, starts duration timer
   * Returns: { recordingId, filename }
   */
  confirmAndRecord(opportunityId) {
    if (this.state !== STATES.PROMPTING) {
      console.warn('[recordingManager] Cannot confirm from state:', this.state);
      return null;
    }

    this.recordingId = crypto.randomUUID();
    this.opportunityId = opportunityId;
    this.durationSeconds = 0;

    // Generate filename: {uuid}-{isoTimestamp}.webm
    const now = new Date().toISOString();
    const isoTimestampSafe = now.replace(/:/g, '-');
    this.filename = `${this.recordingId}-${isoTimestampSafe}.webm`;

    // Start duration timer (increments every 1s)
    this.durationTimer = setInterval(() => {
      this.durationSeconds++;
    }, 1000);

    this._setState(STATES.RECORDING);

    return {
      recordingId: this.recordingId,
      filename: this.filename
    };
  }

  /**
   * stopRecording()
   * Transition: RECORDING → STOPPING
   * Clears timer, returns { recordingId, filename, duration, opportunityId }
   */
  stopRecording() {
    if (this.state !== STATES.RECORDING && this.state !== STATES.PAUSED) {
      console.warn('[recordingManager] Cannot stop from state:', this.state);
      return null;
    }

    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    this._setState(STATES.STOPPING);

    return {
      recordingId: this.recordingId,
      filename: this.filename,
      duration: this.durationSeconds,
      opportunityId: this.opportunityId
    };
  }

  /**
   * pauseRecording()
   * Transition: RECORDING → PAUSED
   * Pauses the duration timer but keeps recording state intact
   */
  pauseRecording() {
    if (this.state !== STATES.RECORDING) {
      console.warn('[recordingManager] Cannot pause from state:', this.state);
      return false;
    }

    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    this._setState(STATES.PAUSED);
    return true;
  }

  /**
   * resumeRecording()
   * Transition: PAUSED → RECORDING
   * Restarts the duration timer
   */
  resumeRecording() {
    if (this.state !== STATES.PAUSED) {
      console.warn('[recordingManager] Cannot resume from state:', this.state);
      return false;
    }

    this.durationTimer = setInterval(() => {
      this.durationSeconds++;
    }, 1000);

    this._setState(STATES.RECORDING);
    return true;
  }

  /**
   * onRecordingFileSaved(filePath)
   * Transition: STOPPING → PROCESSING
   * Stores the saved file path
   */
  onRecordingFileSaved(filePath) {
    if (this.state !== STATES.STOPPING) {
      console.warn('[recordingManager] Cannot save file from state:', this.state);
      return;
    }

    this.savedFilePath = filePath;
    this._setState(STATES.PROCESSING);
  }

  /**
   * onProcessingComplete()
   * Transition: PROCESSING → IDLE
   */
  onProcessingComplete() {
    if (this.state !== STATES.PROCESSING) {
      console.warn('[recordingManager] Cannot complete processing from state:', this.state);
      return;
    }

    // Reset for next recording
    this.recordingId = null;
    this.opportunityId = null;
    this.filename = null;
    this.durationSeconds = 0;
    this.savedFilePath = null;

    this._setState(STATES.IDLE);
  }

  /**
   * cancelRecording()
   * From PROMPTING, RECORDING, PAUSED, or STOPPING → IDLE
   * Clears timer, resets state for error recovery
   */
  cancelRecording() {
    if (this.state === STATES.PROMPTING || this.state === STATES.RECORDING || this.state === STATES.PAUSED || this.state === STATES.STOPPING) {
      if (this.durationTimer) {
        clearInterval(this.durationTimer);
        this.durationTimer = null;
      }

      this.recordingId = null;
      this.opportunityId = null;
      this.filename = null;
      this.durationSeconds = 0;

      this._setState(STATES.IDLE);
      return true;
    }

    return false;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * getState()
   * Returns: { state, recordingId, opportunityId, filename, durationSeconds }
   */
  getState() {
    return {
      state: this.state,
      recordingId: this.recordingId,
      opportunityId: this.opportunityId,
      filename: this.filename,
      durationSeconds: this.durationSeconds
    };
  }

  /**
   * getRecordingsDir()
   * Returns the recordings directory path
   */
  getRecordingsDir() {
    return this.recordingsDir;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * cleanupOldRecordings(maxAgeDays)
   * Deletes .webm files older than N days from the recordings dir
   */
  cleanupOldRecordings(maxAgeDays) {
    if (!this.recordingsDir) {
      console.warn('[recordingManager] Recordings directory not initialized');
      return { deleted: 0, errors: [] };
    }

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const errors = [];
    let deleted = 0;

    try {
      if (!fs.existsSync(this.recordingsDir)) {
        return { deleted: 0, errors: [] };
      }

      const files = fs.readdirSync(this.recordingsDir);

      for (const file of files) {
        if (!file.endsWith('.webm') && !file.endsWith('.mp4') && !file.endsWith('.wav')) continue;

        const filePath = path.join(this.recordingsDir, file);
        try {
          const stats = fs.statSync(filePath);
          const fileAge = now - stats.mtimeMs;

          if (fileAge > maxAgeMs) {
            fs.unlinkSync(filePath);
            deleted++;
            console.log('[recordingManager] Deleted old recording:', file);
          }
        } catch (err) {
          errors.push({ file, error: err.message });
          console.error('[recordingManager] Error processing file:', file, err.message);
        }
      }
    } catch (err) {
      console.error('[recordingManager] Error during cleanup:', err.message);
      errors.push({ error: err.message });
    }

    return { deleted, errors };
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  _setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', { state: newState, ...this.getState() });
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = new RecordingManager();
