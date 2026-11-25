const path = require('path');

// Files opened lately, newest first, each with the page last looked at. Kept in the
// settings file on this computer only. Windows paths are compared ignoring case.

const MAX_RECENT = 20;
const MAX_PATH = 1024;

const key = (filePath) => path.resolve(filePath).toLowerCase();
const usablePath = (filePath) => typeof filePath === 'string' && filePath.length > 0 && filePath.length <= MAX_PATH
  && path.isAbsolute(filePath) && path.extname(filePath).toLowerCase() === '.pdf';

function sanitizeRecent(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const clean = [];
  for (const entry of list) {
    if (!entry || !usablePath(entry.path) || seen.has(key(entry.path))) continue;
    seen.add(key(entry.path));
    clean.push({
      path: entry.path,
      page: Number.isInteger(entry.page) && entry.page >= 1 ? entry.page : 1,
    });
    if (clean.length === MAX_RECENT) break;
  }
  return clean;
}

// Opening a file puts it first, keeping the page it was left at.
function noteOpened(list, filePath) {
  const current = sanitizeRecent(list);
  if (!usablePath(filePath)) return current;
  const old = current.find((entry) => key(entry.path) === key(filePath));
  const rest = current.filter((entry) => entry !== old);
  return [{ path: filePath, page: old?.page ?? 1 }, ...rest].slice(0, MAX_RECENT);
}

function notePage(list, filePath, page) {
  const current = sanitizeRecent(list);
  if (!usablePath(filePath) || !Number.isInteger(page) || page < 1) return current;
  return current.map((entry) => (key(entry.path) === key(filePath) ? { ...entry, page } : entry));
}

function pageOf(list, filePath) {
  if (!usablePath(filePath)) return null;
  return sanitizeRecent(list).find((entry) => key(entry.path) === key(filePath))?.page ?? null;
}

function forget(list, filePath) {
  if (typeof filePath !== 'string') return sanitizeRecent(list);
  return sanitizeRecent(list).filter((entry) => key(entry.path) !== key(filePath));
}

module.exports = { MAX_RECENT, sanitizeRecent, noteOpened, notePage, pageOf, forget, usablePath };
