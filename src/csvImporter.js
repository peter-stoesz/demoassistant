'use strict';

/**
 * csvImporter.js
 * ──────────────
 * Parses a CSV file and imports opportunities, skipping duplicates and
 * rows with missing required fields.
 *
 * Column name matching is case-insensitive and accepts common aliases:
 *   Opportunity Number: "opportunity number", "opp number", "opp #", "oppnumber", "opp_number"
 *   Account Name:       "account name", "account", "company", "accountname", "account_name"
 *   Contact Name:       "contact name", "contact", "contactname", "contact_name"
 *   Notes:              "notes", "note", "description", "comments"
 */

const Papa = require('papaparse');

// ─── Column alias maps ───────────────────────────────────────────────────────

const OPP_NUM_ALIASES  = ['opportunity number', 'opp number', 'opp #', 'oppnumber', 'opp_number', 'opportunity_number', 'opp'];
const ACCOUNT_ALIASES  = ['account name', 'account', 'company', 'accountname', 'account_name'];
const CONTACT_ALIASES  = ['contact name', 'contact', 'contactname', 'contact_name'];
const NOTES_ALIASES    = ['notes', 'note', 'description', 'comments'];

function findColumn(headers, aliases) {
  const lowerHeaders = headers.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = lowerHeaders.indexOf(alias);
    if (idx !== -1) return headers[idx]; // Return the original-case header name
  }
  return null;
}

// ─── Import function ─────────────────────────────────────────────────────────

/**
 * Parse a CSV string and return opportunity objects ready for import.
 *
 * @param {string} csvText      - Raw CSV file contents
 * @param {Array}  existingOpps - Current opportunities array (for duplicate detection)
 * @returns {{ toImport: Array, summary: { imported: number, skipped: number, duplicates: number, errors: string[] } }}
 */
function parseAndPrepare(csvText, existingOpps = []) {
  const result = Papa.parse(csvText, {
    header:         true,
    skipEmptyLines: true,
    trimHeaders:    true
  });

  if (result.errors.length > 0 && result.data.length === 0) {
    return {
      toImport: [],
      summary: {
        imported:   0,
        skipped:    0,
        duplicates: 0,
        errors: result.errors.map(e => `Row ${e.row}: ${e.message}`)
      }
    };
  }

  const headers = result.meta.fields || [];

  // Map columns
  const oppNumCol  = findColumn(headers, OPP_NUM_ALIASES);
  const accountCol = findColumn(headers, ACCOUNT_ALIASES);
  const contactCol = findColumn(headers, CONTACT_ALIASES);
  const notesCol   = findColumn(headers, NOTES_ALIASES);

  const errors = [];

  if (!oppNumCol) {
    errors.push('Could not find an "Opportunity Number" column. Expected one of: ' + OPP_NUM_ALIASES.join(', '));
  }
  if (!accountCol) {
    errors.push('Could not find an "Account Name" column. Expected one of: ' + ACCOUNT_ALIASES.join(', '));
  }

  if (errors.length > 0) {
    return { toImport: [], summary: { imported: 0, skipped: 0, duplicates: 0, errors } };
  }

  // Build a set of existing opportunity numbers for fast duplicate detection
  const existingNums = new Set(
    existingOpps.map(o => o.opportunityNumber.trim().toLowerCase())
  );

  const toImport   = [];
  const seenInFile = new Set();  // Track duplicates within the CSV itself
  let skipped    = 0;
  let duplicates = 0;

  for (let i = 0; i < result.data.length; i++) {
    const row = result.data[i];
    const oppNum  = (row[oppNumCol]  || '').trim();
    const account = (row[accountCol] || '').trim();

    // Skip rows with missing required fields
    if (!oppNum) {
      skipped++;
      continue;
    }
    if (!account) {
      skipped++;
      errors.push(`Row ${i + 2}: Missing account name for "${oppNum}" — skipped.`);
      continue;
    }

    const normalised = oppNum.toLowerCase();

    // Skip duplicates against existing data
    if (existingNums.has(normalised)) {
      duplicates++;
      continue;
    }

    // Skip duplicates within this CSV
    if (seenInFile.has(normalised)) {
      duplicates++;
      continue;
    }

    seenInFile.add(normalised);

    toImport.push({
      opportunityNumber: oppNum,
      accountName:       account,
      contactName:       contactCol ? (row[contactCol] || '').trim() : '',
      notes:             notesCol   ? (row[notesCol]   || '').trim() : ''
    });
  }

  return {
    toImport,
    summary: {
      imported:   toImport.length,
      skipped,
      duplicates,
      errors
    }
  };
}

module.exports = { parseAndPrepare };
