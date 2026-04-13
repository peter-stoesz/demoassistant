'use strict';

/**
 * transcriptStore.js
 * ------------------
 * Manages the transcript index and individual transcript files.
 * Stores metadata in transcripts.json and transcript content in transcripts/ dir.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Module State ────────────────────────────────────────────────────────────

let userDataPath = '';
let indexFilePath = '';
let transcriptsDir = '';
let recordingsDir = '';

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the transcript store.
 * @param {string} userDataPathArg - Electron userData path
 */
function init(userDataPathArg) {
  userDataPath = userDataPathArg;
  indexFilePath = path.join(userDataPath, 'transcripts.json');
  transcriptsDir = path.join(userDataPath, 'transcripts');
  recordingsDir = path.join(userDataPath, 'recordings');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(recordingsDir, { recursive: true });
  console.log('[transcriptStore] Initialized at:', userDataPath);
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Load the transcript index from disk.
 * @returns {Array} Array of transcript entries
 */
function loadTranscriptIndex() {
  try {
    if (fs.existsSync(indexFilePath)) {
      const raw = fs.readFileSync(indexFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (error) {
    console.error('[transcriptStore] Failed to load index:', error.message);
  }
  return [];
}

/**
 * Save the transcript index to disk.
 * @param {Array} list - Array of transcript entries
 */
function saveTranscriptIndex(list) {
  try {
    fs.mkdirSync(path.dirname(indexFilePath), { recursive: true });
    fs.writeFileSync(indexFilePath, JSON.stringify(list, null, 2), 'utf8');
  } catch (error) {
    console.error('[transcriptStore] Failed to save index:', error.message);
    throw error;
  }
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Create a new transcript entry.
 * @param {Object} data
 * @param {string} data.opportunityId - Associated opportunity ID
 * @param {string} data.audioFilename - Name of audio file in recordings/
 * @returns {Object} Created transcript entry
 */
function createTranscriptEntry(data) {
  const id = crypto.randomUUID();
  const entry = {
    id,
    opportunityId: data.opportunityId,
    filename: `${id}.json`,
    audioFilename: data.audioFilename,
    duration: 0,
    status: 'pending',
    createdAt: new Date().toISOString(),
    engineVersion: null,
    error: null,
    wordCount: 0
  };

  const index = loadTranscriptIndex();
  index.push(entry);
  saveTranscriptIndex(index);
  console.log(`[transcriptStore] Created transcript: ${id}`);
  return entry;
}

/**
 * Update the status of a transcript.
 * @param {string} id - Transcript ID
 * @param {string} status - New status: 'pending', 'transcribing', 'completed', 'failed'
 * @param {Object} metadata - Optional metadata to merge { duration, engineVersion, error, wordCount }
 */
function updateTranscriptStatus(id, status, metadata = {}) {
  const index = loadTranscriptIndex();
  const entry = index.find(t => t.id === id);
  if (!entry) {
    console.error(`[transcriptStore] Transcript not found: ${id}`);
    return;
  }

  entry.status = status;
  if (metadata.duration !== undefined) entry.duration = metadata.duration;
  if (metadata.engineVersion !== undefined) entry.engineVersion = metadata.engineVersion;
  if (metadata.error !== undefined) entry.error = metadata.error;
  if (metadata.wordCount !== undefined) entry.wordCount = metadata.wordCount;

  saveTranscriptIndex(index);
  console.log(`[transcriptStore] Updated ${id} status: ${status}`);
}

/**
 * Get all transcripts for an opportunity.
 * @param {string} opportunityId - Opportunity ID
 * @returns {Array} Transcript entries for that opportunity
 */
function getTranscriptsByOpportunity(opportunityId) {
  const index = loadTranscriptIndex();
  return index.filter(t => t.opportunityId === opportunityId);
}

/**
 * Get the content of a transcript.
 * @param {string} id - Transcript ID
 * @returns {Object|null} { segments, fullText, language } or null if not found
 */
function getTranscriptContent(id) {
  const index = loadTranscriptIndex();
  const entry = index.find(t => t.id === id);
  if (!entry) {
    console.warn(`[transcriptStore] Transcript not found: ${id}`);
    return null;
  }

  const transcriptPath = path.join(transcriptsDir, entry.filename);
  try {
    if (fs.existsSync(transcriptPath)) {
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error(`[transcriptStore] Failed to read content: ${id}`, error.message);
  }
  return null;
}

/**
 * Delete a transcript and its associated audio file.
 * @param {string} id - Transcript ID
 * @returns {Object} { success: boolean }
 */
function deleteTranscript(id) {
  const index = loadTranscriptIndex();
  const entryIndex = index.findIndex(t => t.id === id);
  if (entryIndex === -1) {
    console.warn(`[transcriptStore] Transcript not found for deletion: ${id}`);
    return { success: false };
  }

  const entry = index[entryIndex];

  try {
    // Delete transcript file
    const transcriptPath = path.join(transcriptsDir, entry.filename);
    if (fs.existsSync(transcriptPath)) {
      fs.unlinkSync(transcriptPath);
    }

    // Delete audio file
    const audioPath = path.join(recordingsDir, entry.audioFilename);
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    // Remove from index
    index.splice(entryIndex, 1);
    saveTranscriptIndex(index);
    console.log(`[transcriptStore] Deleted transcript: ${id}`);
    return { success: true };
  } catch (error) {
    console.error(`[transcriptStore] Failed to delete transcript: ${id}`, error.message);
    return { success: false };
  }
}

/**
 * Search completed transcripts for a query string.
 * @param {string} query - Search query
 * @returns {Array} Matching transcript entries with matchSnippet field
 */
function searchTranscripts(query) {
  const index = loadTranscriptIndex();
  const completedEntries = index.filter(t => t.status === 'completed');
  const results = [];
  const queryLower = query.toLowerCase();

  for (const entry of completedEntries) {
    const content = getTranscriptContent(entry.id);
    if (!content || !content.fullText) continue;

    const fullTextLower = content.fullText.toLowerCase();
    const matchIndex = fullTextLower.indexOf(queryLower);
    if (matchIndex !== -1) {
      const start = Math.max(0, matchIndex - 50);
      const end = Math.min(content.fullText.length, matchIndex + queryLower.length + 50);
      const snippet = content.fullText.substring(start, end);
      results.push({
        ...entry,
        matchSnippet: snippet
      });
    }
  }

  return results;
}

/**
 * Get the transcripts directory path.
 * @returns {string} Path to transcripts directory
 */
function getTranscriptsDir() {
  return transcriptsDir;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  init,
  loadTranscriptIndex,
  saveTranscriptIndex,
  createTranscriptEntry,
  updateTranscriptStatus,
  getTranscriptsByOpportunity,
  getTranscriptContent,
  deleteTranscript,
  searchTranscripts,
  getTranscriptsDir
};
