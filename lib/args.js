const fs = require('fs');
const path = require('path');

// Picks the existing .pdf files out of a command line. Windows passes the
// double-clicked file here; Chromium flags and the exe path are skipped.
function pdfPathsFromArgv(argv, cwd = process.cwd()) {
  const found = [];
  for (const arg of argv) {
    if (!arg || arg.startsWith('-') || path.extname(arg).toLowerCase() !== '.pdf') continue;
    const full = path.resolve(cwd, arg);
    let isFile = false;
    try {
      isFile = fs.statSync(full).isFile();
    } catch {
      continue;
    }
    if (isFile && !found.includes(full)) found.push(full);
  }
  return found;
}

module.exports = { pdfPathsFromArgv };
