'use strict';

/**
 * provider.js
 * -----------
 * Abstract base class for transcription providers.
 * Defines the contract that all transcription engines must implement.
 */

// ─── TranscriptionProvider ────────────────────────────────────────────────────

/**
 * Abstract base class for transcription providers.
 * Subclasses must implement setup(), transcribe(), and return engineVersion.
 */
class TranscriptionProvider {
  /**
   * Get the version/name of the transcription engine.
   * @returns {string} Engine version (e.g., 'whisper-base.en-v1')
   */
  get engineVersion() {
    throw new Error('Not implemented');
  }

  /**
   * Check if the transcription provider is ready for use.
   * @returns {Promise<boolean>} True if ready, false otherwise
   */
  async isReady() {
    throw new Error('Not implemented');
  }

  /**
   * Initialize and set up the transcription provider.
   * Downloads models, initializes pipelines, etc.
   * @param {Function} onProgress - Callback receiving { status, progress, file }
   * @returns {Promise<void>}
   */
  async setup(onProgress) {
    throw new Error('Not implemented');
  }

  /**
   * Transcribe an audio file.
   * @param {string} audioFilePath - Absolute path to audio file
   * @param {Object} options - Options { language, etc }
   * @returns {Promise<Object>} { segments, fullText, language }
   *   - segments: Array of { start, end, text, confidence }
   *   - fullText: Complete transcribed text
   *   - language: Detected or specified language
   */
  async transcribe(audioFilePath, options = {}) {
    throw new Error('Not implemented');
  }

  // ─── Streaming Interface (Sprint 5) ──────────────────────────────────────────
  //
  // Optional streaming interface for real-time transcription during recording.
  // Providers that support streaming should override supportsStreaming and
  // startStreaming. The default implementation returns false / rejects.

  /**
   * Whether this provider supports real-time streaming transcription.
   * @returns {boolean}
   */
  get supportsStreaming() {
    return false;
  }

  /**
   * Begin a streaming transcription session.
   * @param {Object} options - { language, prompt, onSegment, onPartial }
   *   - onSegment(segment): Called each time a segment is finalized
   *   - onPartial(text):    Called with interim/partial recognition results
   * @returns {Promise<StreamingSession>} Object with pushAudio(chunk) and stop()
   */
  async startStreaming(options = {}) {
    throw new Error('Streaming not supported by this provider');
  }

  /**
   * Clean up resources (pipelines, etc).
   * @returns {Promise<void>}
   */
  async dispose() {
    // Optional cleanup
  }
}

module.exports = TranscriptionProvider;
