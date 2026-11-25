const { sanitizePrintSettings } = require('./printer');

// Named sets of print settings the user saved, such as "SHARP, 2 per sheet, two-sided".
// Shared by the print dialog and the batch print dialog. Copies and page range are left
// out: they belong to one printout, not to a habit.

const PER_SHEET = [1, 2, 4, 6, 9, 16];
const MAX_SETUPS = 30;
const MAX_NAME = 40;

function cleanName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
}

function sanitizeSetup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  return {
    name,
    ...sanitizePrintSettings(raw),
    perSheet: PER_SHEET.includes(raw.perSheet) ? raw.perSheet : 1,
    border: raw.border === true,
  };
}

// A list read back from the settings file: anything odd is dropped, names stay unique.
function sanitizeSetups(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const clean = [];
  for (const raw of list) {
    const setup = sanitizeSetup(raw);
    if (!setup || seen.has(setup.name)) continue;
    seen.add(setup.name);
    clean.push(setup);
    if (clean.length === MAX_SETUPS) break;
  }
  return clean;
}

// The same name replaces the old one where it stood; a new name goes at the end.
function addSetup(list, raw) {
  const setup = sanitizeSetup(raw);
  const current = sanitizeSetups(list);
  if (!setup) return { ok: false, reason: 'NO_NAME', setups: current };
  const index = current.findIndex((one) => one.name === setup.name);
  if (index >= 0) {
    current[index] = setup;
    return { ok: true, replaced: true, setups: current };
  }
  if (current.length >= MAX_SETUPS) return { ok: false, reason: 'TOO_MANY', setups: current };
  return { ok: true, replaced: false, setups: [...current, setup] };
}

function removeSetup(list, name) {
  return sanitizeSetups(list).filter((one) => one.name !== cleanName(name));
}

module.exports = { MAX_SETUPS, MAX_NAME, sanitizeSetup, sanitizeSetups, addSetup, removeSetup };
