const { execFile, spawn } = require('child_process');
const fs = require('fs');

const OPEN_COMMAND_KEY = 'HKCR\\PdfGear.App.1\\shell\\open\\command';

// Reads the exe path out of `reg query` output such as:
//   (預設值)    REG_SZ    "C:\Program Files\PDFgear\PDFLauncher.exe" "%1"
function parseOpenCommand(regOutput) {
  const value = /REG(?:_EXPAND)?_SZ\s+(.+?)\s*$/m.exec(regOutput)?.[1];
  if (!value) return null;
  const quoted = /^"([^"]+)"/.exec(value);
  if (quoted) return quoted[1];
  return /^(.+?\.exe)\b/i.exec(value)?.[1] ?? null;
}

// Starts PDFgear by its own path. Opening the file "with the system" would
// reopen this app once it is the default PDF program.
function findPdfgear() {
  return new Promise((resolve) => {
    execFile('reg', ['query', OPEN_COMMAND_KEY, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const exe = parseOpenCommand(stdout);
      resolve(exe && fs.existsSync(exe) ? exe : null);
    });
  });
}

// Says whether it started. A program that has gone away only shows as an error event, and
// with nothing listening for it Electron would put up an error window of its own.
function openInPdfgear(exe, filePath, start = spawn) {
  return new Promise((resolve) => {
    const child = start(exe, [filePath], { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

module.exports = { parseOpenCommand, findPdfgear, openInPdfgear };
