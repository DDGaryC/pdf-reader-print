const { execFile, spawn } = require('child_process');

const DEFAULT_SETTINGS = Object.freeze({
  printer: null,
  direction: 'counterclockwise',
  scale: 'fit',
  paper: 'A4',
  grayscale: false,
  duplex: 'simplex',
});
const DIRECTIONS = ['counterclockwise', 'clockwise'];
const SCALES = ['fit', 'shrink', 'noscale'];
const PAPERS = ['A4', 'A3', 'A5', 'letter', 'legal'];
const DUPLEX = ['simplex', 'duplexlong', 'duplexshort'];
const PAGE_RANGE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;
const MAX_COPIES = 999;

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// The settings remembered between prints. Copies and page range are left out on purpose.
function sanitizePrintSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    printer: typeof source.printer === 'string' && source.printer ? source.printer : DEFAULT_SETTINGS.printer,
    direction: pick(source.direction, DIRECTIONS, DEFAULT_SETTINGS.direction),
    scale: pick(source.scale, SCALES, DEFAULT_SETTINGS.scale),
    paper: pick(source.paper, PAPERS, DEFAULT_SETTINGS.paper),
    grayscale: source.grayscale === true,
    duplex: pick(source.duplex, DUPLEX, DEFAULT_SETTINGS.duplex),
  };
}

function buildPrintSettings({ pages = '', copies = 1, scale, grayscale, duplex, paper }) {
  if (pages && !PAGE_RANGE.test(pages)) throw new Error('invalid page range');
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new Error('invalid copies');
  const parts = [];
  if (pages) parts.push(pages);
  if (copies > 1) parts.push(`${copies}x`);
  parts.push(
    pick(scale, SCALES, DEFAULT_SETTINGS.scale),
    // Sumatra turns landscape pages itself; portrait says how to fit them on the sheet.
    'portrait',
    grayscale ? 'monochrome' : 'color',
    pick(duplex, DUPLEX, DEFAULT_SETTINGS.duplex),
    `paper=${pick(paper, PAPERS, DEFAULT_SETTINGS.paper)}`,
    'ignore-pdf-print-settings',
  );
  return parts.join(',');
}

function buildPrintArgs({ printer, file, appDataDir, ...options }) {
  if (typeof printer !== 'string' || !printer) throw new Error('no printer');
  if (typeof file !== 'string' || !file) throw new Error('no file');
  return [
    '-appdata', appDataDir,
    '-print-to', printer,
    '-print-settings', buildPrintSettings(options),
    '-silent',
    file,
  ];
}

// Resolves with Sumatra's exit code once it has finished. There is deliberately no
// timeout and no kill: forcing Sumatra to quit while Microsoft Print to PDF's Save As
// window is open can leave the program underneath it stuck and unclickable. Output is
// ignored, because a full pipe would make it wait forever. `windowsHide` stays off,
// otherwise that same Save As window can come up hidden.
function runSumatra(exe, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
    } catch {
      resolve(-1);
      return;
    }
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

function parseWindowsPrinters(json) {
  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  return (Array.isArray(rows) ? rows : [rows]).filter((row) => row?.Name).map((row) => ({
    name: row.Name,
    isDefault: row.Default === true,
    asksForFile: /^PORTPROMPT:/i.test(row.PortName ?? ''),
  }));
}

// Windows knows which printer is the default and which one asks where to save.
function queryWindowsPrinters() {
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + 'ConvertTo-Json -InputObject @(Get-CimInstance Win32_Printer | Select-Object Name, PortName, Default)';
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve(err ? [] : parseWindowsPrinters(stdout));
    });
  });
}

// Merges Electron's printer list with what Windows says about each one.
function mergePrinters(electronPrinters, windowsPrinters) {
  const details = new Map(windowsPrinters.map((printer) => [printer.name, printer]));
  return electronPrinters.map(({ name, displayName }) => ({
    name,
    displayName: displayName || name,
    isDefault: details.get(name)?.isDefault ?? false,
    asksForFile: details.get(name)?.asksForFile ?? false,
  }));
}

// Last used printer, then the Windows default, then the first in the list.
function choosePrinter(printers, lastUsed) {
  const names = printers.map((printer) => printer.name);
  if (lastUsed && names.includes(lastUsed)) return lastUsed;
  return printers.find((printer) => printer.isDefault)?.name ?? names[0] ?? null;
}

module.exports = {
  DEFAULT_SETTINGS,
  sanitizePrintSettings,
  buildPrintSettings,
  buildPrintArgs,
  runSumatra,
  parseWindowsPrinters,
  queryWindowsPrinters,
  mergePrinters,
  choosePrinter,
};
