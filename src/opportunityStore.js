'use strict';

/**
 * opportunityStore.js
 * -------------------
 * CRUD operations and search for opportunities (accounts).
 * Data is stored as a JSON flat file in Electron's userData directory.
 *
 * Each opportunity:
 *   { id, opportunityNumber, accountName, contactName, notes, createdAt, updatedAt }
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// Optional: appLogger for structured logging
let appLogger = null;
try { appLogger = require('./appLogger'); } catch (_) {}

let dataFilePath = '';

// ─── Initialisation ──────────────────────────────────────────────────────────

function init(userDataPath) {
  dataFilePath = path.join(userDataPath, 'opportunities.json');
}

// ─── File I/O ────────────────────────────────────────────────────────────────

function loadOpportunities() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const raw = fs.readFileSync(dataFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error('[opportunityStore] Failed to load opportunities:', e.message);
  }
  return [];
}

function saveOpportunities(list) {
  try {
    const dir = path.dirname(dataFilePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dataFilePath, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('[opportunityStore] Failed to save opportunities:', e.message);
    throw e;
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

function addOpportunity({ opportunityNumber, accountName, contactName, notes }) {
  if (!opportunityNumber || !opportunityNumber.trim()) {
    throw new Error('Opportunity number is required.');
  }
  if (!accountName || !accountName.trim()) {
    throw new Error('Account name is required.');
  }

  const list = loadOpportunities();

  // Check for duplicate opportunity number (case-insensitive)
  const normalised = opportunityNumber.trim().toLowerCase();
  const duplicate = list.find(
    o => o.opportunityNumber.trim().toLowerCase() === normalised
  );
  if (duplicate) {
    throw new Error(`Opportunity number "${opportunityNumber.trim()}" already exists.`);
  }

  const now = new Date().toISOString();
  const opportunity = {
    id:                crypto.randomUUID(),
    opportunityNumber: opportunityNumber.trim(),
    accountName:       accountName.trim(),
    contactName:       (contactName || '').trim(),
    notes:             (notes || '').trim(),
    createdAt:         now,
    updatedAt:         now
  };

  list.push(opportunity);
  saveOpportunities(list);
  if (appLogger) appLogger.info('data', 'Opportunity added', { id: opportunity.id, number: opportunity.opportunityNumber });
  return opportunity;
}

function updateOpportunity(id, fields) {
  const list = loadOpportunities();
  const index = list.findIndex(o => o.id === id);
  if (index === -1) {
    throw new Error(`Opportunity not found: ${id}`);
  }

  // If updating opportunityNumber, check for duplicates
  if (fields.opportunityNumber !== undefined) {
    const normalised = fields.opportunityNumber.trim().toLowerCase();
    const duplicate = list.find(
      o => o.id !== id && o.opportunityNumber.trim().toLowerCase() === normalised
    );
    if (duplicate) {
      throw new Error(`Opportunity number "${fields.opportunityNumber.trim()}" already exists.`);
    }
  }

  const allowed = ['opportunityNumber', 'accountName', 'contactName', 'notes'];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      list[index][key] = typeof fields[key] === 'string' ? fields[key].trim() : fields[key];
    }
  }

  // Validate required fields after merge
  if (!list[index].opportunityNumber) {
    throw new Error('Opportunity number is required.');
  }
  if (!list[index].accountName) {
    throw new Error('Account name is required.');
  }

  list[index].updatedAt = new Date().toISOString();
  saveOpportunities(list);
  return list[index];
}

function deleteOpportunity(id) {
  const list = loadOpportunities();
  const filtered = list.filter(o => o.id !== id);
  if (filtered.length === list.length) {
    throw new Error(`Opportunity not found: ${id}`);
  }
  saveOpportunities(filtered);
  return { success: true };
}

// ─── Query ───────────────────────────────────────────────────────────────────

function getOpportunityById(id) {
  const list = loadOpportunities();
  return list.find(o => o.id === id) || null;
}

function searchOpportunities(query) {
  if (!query || !query.trim()) return loadOpportunities();

  const terms = query.trim().toLowerCase();
  const list = loadOpportunities();

  return list.filter(o => {
    const haystack = [
      o.opportunityNumber,
      o.accountName,
      o.contactName
    ].join(' ').toLowerCase();

    return haystack.includes(terms);
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  init,
  loadOpportunities,
  saveOpportunities,
  addOpportunity,
  updateOpportunity,
  deleteOpportunity,
  getOpportunityById,
  searchOpportunities
};
