const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pdfPathsFromArgv } = require('../lib/args');
const { PdfFiles } = require('../lib/pdf-files');
const { parseOpenCommand } = require('../lib/pdfgear');
const { loadSettings, saveSettings } = require('../lib/settings');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-unit-'));
const pdf = path.join(dir, '測試 檔案.pdf');
fs.writeFileSync(pdf, '%PDF-1.4 0123456789');

test('command line: keeps existing PDFs, in order, without repeats', () => {
  const other = path.join(dir, 'b.PDF');
  fs.writeFileSync(other, 'x');
  const argv = ['C:\\app.exe', '--allow-file-access-from-files', pdf, 'missing.pdf', path.join(dir, 'a.txt'), other, pdf];
  assert.deepEqual(pdfPathsFromArgv(argv), [pdf, other]);
});

test('command line: relative paths use the given folder', () => {
  assert.deepEqual(pdfPathsFromArgv(['測試 檔案.pdf'], dir), [pdf]);
});

test('settings: missing or broken files give empty settings', () => {
  assert.deepEqual(loadSettings(path.join(dir, 'none.json')), {});
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{not json');
  assert.deepEqual(loadSettings(broken), {});
  fs.writeFileSync(broken, '[1,2]');
  assert.deepEqual(loadSettings(broken), {});
});

test('settings: save and load round trip, no temporary file left', () => {
  const file = path.join(dir, 'sub', 'settings.json');
  saveSettings(file, { window: { width: 900 } });
  assert.deepEqual(loadSettings(file), { window: { width: 900 } });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('pdfgear: reads the exe out of reg output', () => {
  const output = '\r\nHKEY_CLASSES_ROOT\\PdfGear.App.1\\shell\\open\\command\r\n'
    + '    (預設值)    REG_SZ    "C:\\Program Files\\PDFgear\\PDFLauncher.exe" "%1"\r\n\r\n';
  assert.equal(parseOpenCommand(output), 'C:\\Program Files\\PDFgear\\PDFLauncher.exe');
  assert.equal(parseOpenCommand('    (Default)    REG_EXPAND_SZ    C:\\Tools\\gear.exe %1'), 'C:\\Tools\\gear.exe');
  assert.equal(parseOpenCommand('nothing useful'), null);
});

test('pdf files: registers, reads ranges and closes', async () => {
  const files = new PdfFiles();
  const { ok, file } = await files.register(pdf);
  assert.equal(ok, true);
  assert.equal(file.name, '測試 檔案.pdf');
  assert.equal(file.size, 19);
  assert.equal(files.pathOf(file.id), pdf);
  assert.equal((await files.read(file.id, 0, 8)).toString(), '%PDF-1.4');
  assert.equal((await files.read(file.id, 15, 19)).toString(), '6789');
  await files.close(file.id);
  assert.equal(files.pathOf(file.id), null);
  await assert.rejects(files.read(file.id, 0, 1));
});

test('pdf files: refuses bad ranges', async () => {
  const files = new PdfFiles();
  const { file } = await files.register(pdf);
  for (const [begin, end] of [[-1, 4], [4, 4], [5, 2], [0, 20], [0.5, 2], ['0', 2]]) {
    await assert.rejects(files.read(file.id, begin, end), /invalid range/);
  }
  await files.closeAll();
});

test('pdf files: refuses files that are not PDFs, missing or empty', async () => {
  const files = new PdfFiles();
  const text = path.join(dir, 'secret.txt');
  fs.writeFileSync(text, 'secret');
  const empty = path.join(dir, 'empty.pdf');
  fs.writeFileSync(empty, '');
  assert.deepEqual(await files.register(text), { ok: false, code: 'NOT_PDF' });
  assert.deepEqual(await files.register(path.join(dir, 'missing.pdf')), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await files.register(empty), { ok: false, code: 'EMPTY' });
  assert.deepEqual(await files.register(undefined), { ok: false, code: 'NOT_FOUND' });
});

test('pdf files: the file stays writable by other programs while open', async () => {
  const files = new PdfFiles();
  const shared = path.join(dir, 'shared.pdf');
  fs.writeFileSync(shared, '%PDF-1.4 first');
  const { file } = await files.register(shared);
  fs.writeFileSync(shared, '%PDF-1.4 again');
  assert.equal((await files.read(file.id, 9, 14)).toString(), 'again');
  await files.closeAll();
});

test('pdfgear: says whether it started, and an error does not get away', async () => {
  const { EventEmitter } = require('node:events');
  const { openInPdfgear } = require('../lib/pdfgear');
  assert.equal(await openInPdfgear(path.join(os.tmpdir(), 'no-such-program-here.exe'), 'a.pdf'), false);

  const calls = [];
  let unrefs = 0;
  const started = await openInPdfgear('C:\\PDFgear.exe', 'C:\\a.pdf', (exe, args, options) => {
    calls.push([exe, args, options.detached]);
    const child = Object.assign(new EventEmitter(), { unref: () => { unrefs += 1; } });
    setImmediate(() => child.emit('spawn'));
    return child;
  });
  assert.equal(started, true);
  assert.deepEqual(calls, [['C:\\PDFgear.exe', ['C:\\a.pdf'], true]]);
  assert.equal(unrefs, 1, 'this program does not wait for it to close');
});
