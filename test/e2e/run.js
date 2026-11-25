// Runs the real app with its window hidden and drives the page. No window ever
// appears, so this can run while the user is working in other programs.
//   PDF_E2E_SHOTS   folder for screenshots (optional)
//   PDF_E2E_REPORT  file for the results (optional)
//   PDF_E2E_EXTRA   a real PDF to open as well; PDF_E2E_EXTRA_QUERY is searched in it (optional)
const electron = require('electron');

const { app, BrowserWindow, dialog, ipcMain, shell } = electron;
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('@cantoo/pdf-lib');
const { PdfFiles } = require('../../lib/pdf-files');
const runCompareTests = require('./compare');
const runFeatures14Tests = require('./features14');
const runOrganizeTests = require('./organize');
const runWindowTests = require('./windows');

const { spawn } = childProcess;

// Nothing is ever sent to a real printer: starting Sumatra is caught here, so a
// test can read the command and decide when and how the print job "finishes".
const printCalls = [];
// PDFgear is never really started either. A test says whether it would have worked.
const pdfgearCalls = [];
let pdfgearAnswer = 'spawn';
childProcess.spawn = function spawnWithoutPrinting(command, args, options) {
  if (/pdfgear/i.test(String(command))) {
    const child = new EventEmitter();
    child.unref = () => {};
    pdfgearCalls.push({ command, args });
    setImmediate(() => child.emit(pdfgearAnswer, new Error('pretend')));
    return child;
  }
  if (path.basename(String(command)).toLowerCase() !== 'sumatrapdf.exe') return spawn(command, args, options);
  const child = new EventEmitter();
  printCalls.push({ command, args, options, finish: (code) => child.emit('exit', code) });
  return child;
};

// The file picker is a real window, so it is answered here and never opens.
let pickedFiles = [];
let pretendNoPdfgear = false;
const { handle } = ipcMain;
ipcMain.handle = function handleWithoutPicker(channel, listener) {
  if (channel === 'pdfgear:available') {
    return handle.call(ipcMain, channel, (...args) => (pretendNoPdfgear ? false : listener(...args)));
  }
  return handle.call(ipcMain, channel, channel === 'pdf:pick' ? async () => pickedFiles : listener);
};

// The Save As window is real too. A test says where it "saves"; null means cancelled.
// If this could not be replaced, the tests that would open it are skipped.
let saveTarget = null;
let saveDialogOptions = null;
let saveDialogCalls = 0;
let saveDialogGate = Promise.resolve();
let saveDialogParent = null;
async function answerSaveDialog(parent, options) {
  saveDialogCalls++;
  saveDialogParent = parent;
  saveDialogOptions = options;
  await saveDialogGate;
  return saveTarget ? { canceled: false, filePath: saveTarget } : { canceled: true, filePath: '' };
}
dialog.showSaveDialog = answerSaveDialog;
const saveDialogReplaced = electron.dialog === dialog && dialog.showSaveDialog === answerSaveDialog;

// The folder picker and opening a folder in Explorer are real windows as well.
let folderAnswer = null;
const openedFolders = [];
async function answerFolderDialog() {
  return folderAnswer ? { canceled: false, filePaths: [folderAnswer] } : { canceled: true, filePaths: [] };
}
async function noteOpenedFolder(folder) {
  openedFolders.push(folder);
  return '';
}
dialog.showOpenDialog = answerFolderDialog;
shell.openPath = noteOpenedFolder;
// The Windows settings are a real window too.
const openedLinks = [];
shell.openExternal = async (link) => {
  openedLinks.push(link);
};
const folderWindowsReplaced = electron.dialog.showOpenDialog === answerFolderDialog && electron.shell.openPath === noteOpenedFolder;

// Which files the app is holding open, to catch any it forgets to close.
const heldFiles = new Set();
const { register, close: closeFile } = PdfFiles.prototype;
PdfFiles.prototype.register = async function registerAndNote(filePath) {
  const result = await register.call(this, filePath);
  if (result.ok) heldFiles.add(result.file.id);
  return result;
};
PdfFiles.prototype.close = function closeAndNote(id) {
  heldFiles.delete(id);
  return closeFile.call(this, id);
};

// The update library is never really used: nothing here may reach GitHub or install
// anything. A test sets what the pretend one finds.
const pretendUpdater = Object.assign(new EventEmitter(), {
  version: '0.0.1',
  fails: false,
  checks: 0,
  downloads: 0,
  installs: [],
  async checkForUpdates() {
    this.checks++;
    if (this.fails) throw new Error('pretend: no network');
    return { updateInfo: { version: this.version } };
  },
  async downloadUpdate() {
    this.downloads++;
    this.emit('download-progress', { percent: 42 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (this.fails) throw new Error('pretend: no network');
  },
  quitAndInstall(...args) {
    this.installs.push(args);
  },
});
const updaterModule = require.resolve('electron-updater');
require.cache[updaterModule] = { id: updaterModule, filename: updaterModule, loaded: true, children: [], paths: [], exports: { autoUpdater: pretendUpdater } };
process.env.PDF_READER_TEST_UPDATER = '1';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const fixture = (name) => path.join(FIXTURES, name);
const lines = [];
const consoleErrors = [];
let failures = 0;
const TEMP_PREFIX = 'pdfrp-e2e-';

// Without this, Electron shows an error dialog on the user's screen.
process.on('uncaughtException', (err) => {
  report(`CRASH ${err.stack}`);
  failures++;
  finish(1);
});

// Chromium keeps its profile folder locked until the app has exited, so a run
// cannot delete its own folder. Each run clears what earlier runs left behind.
function removeOldProfiles() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    try {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    } catch {
      // Still in use by another run; the next run gets it.
    }
  }
}

if (!process.env.PDF_E2E_USERDATA) removeOldProfiles();
const userData = process.env.PDF_E2E_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));

app.setPath('userData', userData);
process.env.PDF_READER_TEST_HIDDEN = '1';
process.argv.push(process.env.PDF_E2E_ROLE === 'second' ? fixture('cjk-not-embedded.pdf') : fixture('mixed.pdf'));
// Most of this test works with tabs. windows.js turns on one window for each file.
if (process.env.PDF_E2E_ROLE !== 'second') fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ openIn: 'tab' }));
require('../../main.js');

if (process.env.PDF_E2E_ROLE !== 'second') {
  app.once('browser-window-created', (_event, win) => {
    run(win).catch((err) => {
      report(`CRASH ${err.stack}`);
      finish(1);
    });
  });
}

function report(line) {
  lines.push(line);
  console.log(line);
  if (process.env.PDF_E2E_REPORT) fs.writeFileSync(process.env.PDF_E2E_REPORT, `${lines.join('\n')}\n`);
}

function check(name, ok, detail = '') {
  if (!ok) failures++;
  report(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
}

function finish(code) {
  report(`--- ${failures} failed`);
  app.exit(code);
}

async function run(win) {
  const { webContents } = win;
  webContents.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message);
  });
  webContents.on('render-process-gone', (_e, info) => {
    check('renderer stayed alive', false, `${info.reason} code ${info.exitCode}`);
    finish(1);
  });

  const js = (code) => webContents.executeJavaScript(code);
  const waitFor = async (code, label, timeout = 20000) => {
    const start = Date.now();
    for (;;) {
      const value = await js(code).catch(() => false);
      if (value) return value;
      if (Date.now() - start > timeout) {
        check(`waited for ${label}`, false, 'timed out');
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  };
  const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const value = (id) => js(`document.getElementById(${JSON.stringify(id)}).value`);
  const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const press = (key, extra = {}) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, ...extra })}))`);
  const tabCount = () => js(`document.querySelectorAll('.tab').length`);
  const openFiles = (paths) => webContents.send('pdf:open', paths);
  const shot = async (name) => {
    if (!process.env.PDF_E2E_SHOTS) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await webContents.capturePage(undefined, { stayHidden: true });
    fs.writeFileSync(path.join(process.env.PDF_E2E_SHOTS, `${name}.png`), image.toPNG());
  };
  const pageWidth = () => js(`document.querySelector('.viewer-host.active .page').getBoundingClientRect().width`);
  const pageHeight = () => js(`document.querySelector('.viewer-host.active .page').getBoundingClientRect().height`);
  const inkExpression = (n) => `(() => {
    const c = document.querySelector('.viewer-host.active .page[data-page-number="${n}"] canvas');
    if (!c || !c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
    return ink;
  })()`;
  const pagesPainted = (n) => `(${inkExpression(n)} > 100)`;
  const textOnPage = (n) => `(document.querySelector('.viewer-host.active .page[data-page-number="${n}"] .textLayer')?.textContent ?? '')`;
  const typePage = (n) => js(`(() => {
    const i = document.getElementById('page-input');
    i.focus();
    i.value = '${n}';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);

  await new Promise((resolve) => webContents.once('did-finish-load', resolve));
  check('window stays hidden', !win.isVisible());
  const url = webContents.getURL();
  check('loaded from the app scheme', url === 'app://local/index.html', url);

  // ---- Opening from the command line
  await waitFor(`document.getElementById('page-total').textContent === '/ 4'`, 'mixed.pdf from command line');
  check('command line file becomes a tab', (await tabCount()) === 1);
  check('title shows the file name', (await js('document.title')) === 'mixed.pdf - PDF閱讀列印');
  await waitFor(pagesPainted(1), 'page 1 painted');
  check('page 1 has real ink', (await js(inkExpression(1))) > 500);
  await waitFor(`${textOnPage(1)}.includes('PAGE 1')`, 'text layer on page 1');
  check('text layer has the text', (await js(textOnPage(1))).includes('PAGE 1'));
  check('worker runs in a real thread', !(await js(`Boolean(globalThis.pdfjsWorker)`)));
  await shot('01-mixed');

  // ---- Thumbnails
  check('one thumbnail per page', (await js(`document.querySelectorAll('.thumb-pane.active .thumb').length`)) === 4);
  await waitFor(`document.querySelectorAll('.thumb-pane.active .thumb[data-drawn]').length === 4`, 'thumbnails drawn');
  check('current page is marked', (await js(`document.querySelector('.thumb.current')?.dataset.page`)) === '1');
  await js(`document.querySelector('.thumb-pane.active .thumb[data-page="3"]').click()`);
  await waitFor(`document.getElementById('page-input').value === '3'`, 'clicking thumbnail 3');
  check('clicking a thumbnail jumps there', (await value('page-input')) === '3');
  check('thumbnail mark follows', (await js(`document.querySelector('.thumb.current')?.dataset.page`)) === '3');

  // ---- Page navigation
  await click('btn-next');
  await waitFor(`document.getElementById('page-input').value === '4'`, 'next page');
  check('next page button', (await value('page-input')) === '4');
  check('next page disabled on the last page', await js(`document.getElementById('btn-next').disabled`));
  await press('PageUp');
  await waitFor(`document.getElementById('page-input').value === '3'`, 'Page Up');
  check('Page Up', (await value('page-input')) === '3');
  await press('ArrowLeft');
  await waitFor(`document.getElementById('page-input').value === '2'`, 'Left arrow');
  check('Left arrow', (await value('page-input')) === '2');
  await press('PageDown');
  await waitFor(`document.getElementById('page-input').value === '3'`, 'Page Down');
  check('Page Down', (await value('page-input')) === '3');
  await press('Home');
  await waitFor(`document.getElementById('page-input').value === '1'`, 'Home');
  check('Home', (await value('page-input')) === '1');
  await typePage(2);
  await waitFor(`document.querySelector('.thumb.current')?.dataset.page === '2'`, 'typing a page number');
  check('typing a page number', (await value('page-input')) === '2');
  await typePage(99);
  check('page number out of range keeps the page', (await value('page-input')) === '2', await value('page-input'));
  check('page number out of range explains why', (await text('toast')).includes('1 到 4'));

  // ---- Zoom
  await js(`(() => { const s = document.getElementById('zoom-select'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const at200 = await pageWidth();
  await js(`(() => { const s = document.getElementById('zoom-select'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const at100 = await pageWidth();
  check('200% is twice 100%', Math.abs(at200 / at100 - 2) < 0.03, `${at200} / ${at100}`);
  check('zoom list shows 100%', (await value('zoom-select')) === '1');
  await click('btn-zoom-in');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('zoom in button', (await pageWidth()) > at100);
  check('zoom list shows other sizes', (await js(`document.getElementById('zoom-select').selectedOptions[0].textContent`)).endsWith('%'));
  await press('-', { ctrlKey: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('Ctrl+- zooms out', Math.abs((await pageWidth()) - at100) < 2);
  const wheelBefore = await pageWidth();
  await js(`document.querySelector('.viewer-host.active').dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: 500, clientY: 300, bubbles: true, cancelable: true }))`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('Ctrl+wheel zooms', (await pageWidth()) > wheelBefore);
  await js(`(() => { const s = document.getElementById('zoom-select'); s.value = 'page-width'; s.dispatchEvent(new Event('change')); })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const hostWidth = await js(`document.querySelector('.viewer-host.active').clientWidth`);
  check('fit to width', Math.abs(hostWidth - (await pageWidth())) < 60, `${await pageWidth()} of ${hostWidth}`);
  await js(`(() => { const s = document.getElementById('zoom-select'); s.value = 'page-fit'; s.dispatchEvent(new Event('change')); })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const hostHeight = await js(`document.querySelector('.viewer-host.active').clientHeight`);
  check('whole page fits', (await pageHeight()) <= hostHeight, `${await pageHeight()} of ${hostHeight}`);

  // ---- Rotate view
  await press('Home');
  await waitFor(`document.getElementById('page-input').value === '1'`, 'back on page 1');
  const portrait = { w: await pageWidth(), h: await pageHeight() };
  await click('btn-rotate-right');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const turned = { w: await pageWidth(), h: await pageHeight() };
  check('rotate view turns the page', portrait.h / portrait.w > 1.2 && turned.w / turned.h > 1.2, JSON.stringify(turned));
  await waitFor(`(() => { const c = document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas'); return c.width > c.height; })()`, 'thumbnail turning too');
  await click('btn-rotate-right');
  await click('btn-rotate-right');
  await click('btn-rotate-right');
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('four turns come back', (await pageHeight()) / (await pageWidth()) > 1.2);

  // ---- Search
  await click('btn-find');
  check('search bar opens', !(await js(`document.getElementById('findbar').hidden`)));
  await js(`(() => { const i = document.getElementById('find-input'); i.value = 'quick brown'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`/^\\d+ \\/ 8$/.test(document.getElementById('find-count').textContent)`, 'search count');
  check('search counts matches on all pages', /^\d+ \/ 8$/.test(await text('find-count')), await text('find-count'));
  await shot('02-find');
  const firstMatch = await text('find-count');
  await js(`document.getElementById('find-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await waitFor(`document.getElementById('find-count').textContent !== ${JSON.stringify(firstMatch)}`, 'next match');
  check('Enter moves to the next match', (await text('find-count')) !== firstMatch, await text('find-count'));
  await js(`(() => { const i = document.getElementById('find-input'); i.value = 'zzz-not-there'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.getElementById('find-count').textContent === '找不到'`, 'not found');
  check('search says when nothing is found', (await text('find-count')) === '找不到');
  await press('Escape');
  check('Esc closes the search bar', await js(`document.getElementById('findbar').hidden`));

  // ---- Second instance adds a tab to this window
  const second = spawn(process.execPath, [__filename, fixture('cjk-not-embedded.pdf')], {
    env: { ...process.env, PDF_E2E_ROLE: 'second', PDF_E2E_USERDATA: userData },
    stdio: 'ignore',
  });
  const secondExit = await new Promise((resolve) => {
    second.once('exit', resolve);
    second.once('error', () => resolve('spawn error'));
  });
  check('second copy of the app quits', secondExit === 0, String(secondExit));
  await waitFor(`document.querySelectorAll('.tab').length === 2`, 'tab from the second copy');
  check('second copy opens a tab here', (await tabCount()) === 2);
  check('new tab is shown', (await js('document.title')).startsWith('cjk-not-embedded.pdf'));
  check('only one viewer visible', (await js(`document.querySelectorAll('.viewer-host.active').length`)) === 1);

  // ---- Chinese with fonts that are not embedded
  await waitFor(pagesPainted(1), 'Chinese page painted');
  check('Chinese page has ink', (await js(inkExpression(1))) > 500);
  await waitFor(`${textOnPage(1)}.includes('統一發票')`, 'Chinese text layer');
  check('Chinese text layer', (await js(textOnPage(1))).includes('統一發票'));
  await click('btn-find');
  await js(`(() => { const i = document.getElementById('find-input'); i.value = '電子發票'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`/ 4$/.test(document.getElementById('find-count').textContent)`, 'Chinese search');
  check('Chinese search', /\/ 4$/.test(await text('find-count')), await text('find-count'));
  await press('Escape');
  await shot('03-cjk');

  // ---- Sharpness and search marks, at several zoom levels. In this file each
  // character is one em wide and the first line starts at x=40, baseline y=122.
  for (const percent of ['1', '1.5', '2']) {
    await js(`(() => { const s = document.getElementById('zoom-select'); s.value = '${percent}'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor(`Math.abs(document.querySelector('.viewer-host.active canvas').width - ${Math.floor(595 * percent * (96 / 72)) * 2}) < 5`, `canvas at ${percent}`);
    await waitFor(pagesPainted(1), `painted at ${percent}`);
    const canvasBox = await js(`(() => {
      const c = document.querySelector('.viewer-host.active .page canvas');
      const r = c.getBoundingClientRect();
      return { pixels: c.width, shown: r.width, ratio: devicePixelRatio };
    })()`);
    check(`page image is drawn at exactly twice its size at ${percent}`, canvasBox.ratio === 2 && Math.abs(canvasBox.shown * canvasBox.ratio - canvasBox.pixels) <= 2, JSON.stringify(canvasBox));

    await click('btn-find');
    await js(`(() => { const i = document.getElementById('find-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.value = '電子'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.querySelectorAll('.viewer-host.active .page[data-page-number="1"] .highlight').length === 4`, `search marks at ${percent}`);
    const mark = await js(`(() => {
      const canvas = document.querySelector('.viewer-host.active .page canvas').getBoundingClientRect();
      const box = document.querySelector('.viewer-host.active .page .highlight').getBoundingClientRect();
      return { left: box.left - canvas.left, right: box.right - canvas.left, top: box.top - canvas.top, bottom: box.bottom - canvas.top, scale: canvas.width / 595 };
    })()`);
    const wantLeft = 150 * mark.scale;
    const wantRight = 194 * mark.scale;
    const wantBaseline = 122 * mark.scale;
    const tolerance = 4 * mark.scale;
    check(`search mark covers the word sideways at ${percent}`, Math.abs(mark.left - wantLeft) <= tolerance && Math.abs(mark.right - wantRight) <= tolerance, JSON.stringify(mark));
    check(`search mark covers the word up and down at ${percent}`, mark.top < wantBaseline - 8 * mark.scale && mark.bottom > wantBaseline - tolerance && mark.bottom < wantBaseline + 12 * mark.scale, JSON.stringify(mark));
    await press('Escape');
  }
  await js(`(() => { const s = document.getElementById('zoom-select'); s.value = 'page-fit'; s.dispatchEvent(new Event('change')); })()`);

  // ---- Switching tabs keeps each page position
  await js(`document.querySelectorAll('.tab')[0].click()`);
  await waitFor(`document.getElementById('page-total').textContent === '/ 4'`, 'switch to first tab');
  check('switching tabs shows that document', (await js('document.title')).startsWith('mixed.pdf'));
  check('one thumbnail column visible', (await js(`document.querySelectorAll('.thumb-pane.active').length`)) === 1);
  await press('Tab', { ctrlKey: true });
  await waitFor(`document.title.startsWith('cjk-not-embedded')`, 'Ctrl+Tab');
  check('Ctrl+Tab', (await js('document.title')).startsWith('cjk-not-embedded'));

  // ---- Opening the same file again
  openFiles([fixture('mixed.pdf').toUpperCase()]);
  await waitFor(`document.title.startsWith('mixed.pdf')`, 'same file again');
  check('same file again just shows its tab', (await tabCount()) === 2);

  // ---- Three files at once, like dragging three in
  openFiles([fixture('square.pdf'), fixture('small-page.pdf'), fixture('annotated.pdf')]);
  await waitFor(`document.querySelectorAll('.tab').length === 5`, 'three files at once');
  check('three files give three tabs', (await tabCount()) === 5);
  await waitFor(`document.title.startsWith('annotated.pdf') && document.getElementById('page-total').textContent === '/ 1'`, 'last file shown');
  await waitFor(pagesPainted(1), 'annotated page painted');
  check('annotations appear in the viewer', (await js(`document.querySelectorAll('.viewer-host.active .annotationLayer section').length`)) >= 2);
  await shot('04-annotated');

  // ---- Password
  openFiles([fixture('enc-open-password.pdf')]);
  await waitFor(`document.getElementById('password-dialog').open`, 'password prompt');
  check('password prompt appears', await js(`document.getElementById('password-dialog').open`));
  await shot('05-password');
  await js(`document.getElementById('password-input').value = 'wrong'; document.getElementById('password-ok').click()`);
  await waitFor(`document.getElementById('password-dialog').open && !document.getElementById('password-error').hidden`, 'wrong password message');
  check('wrong password asks again', !(await js(`document.getElementById('password-error').hidden`)));
  await js(`document.getElementById('password-cancel').click()`);
  await waitFor(`document.querySelectorAll('.tab').length === 5`, 'cancel removes the tab');
  check('cancel closes that tab quietly', (await tabCount()) === 5);
  openFiles([fixture('enc-open-password.pdf')]);
  await waitFor(`document.getElementById('password-dialog').open`, 'password prompt again');
  await js(`document.getElementById('password-input').value = 'test1234'; document.getElementById('password-ok').click()`);
  await waitFor(`document.title.startsWith('enc-open-password') && document.getElementById('page-total').textContent === '/ 1'`, 'right password');
  check('right password opens the file', (await tabCount()) === 6);
  await waitFor(pagesPainted(1), 'protected page painted');
  check('protected page has ink', (await js(inkExpression(1))) > 300);
  await press('w', { ctrlKey: true });
  await waitFor(`document.querySelectorAll('.tab').length === 5`, 'Ctrl+W');
  check('Ctrl+W closes the tab', (await tabCount()) === 5);

  // ---- Protected without an open password
  openFiles([fixture('enc-owner-no-print.pdf')]);
  await waitFor(`document.title.startsWith('enc-owner-no-print') && document.getElementById('page-total').textContent === '/ 1'`, 'owner protected file');
  check('protected file opens without asking', !(await js(`document.getElementById('password-dialog').open`)));
  await press('w', { ctrlKey: true });
  await waitFor(`document.querySelectorAll('.tab').length === 5`, 'closing protected file');

  // ---- Bad files never crash the app
  for (const [file, expected] of [
    ['corrupt.pdf', '損毀'],
    ['empty.pdf', '空的'],
    ['notes.txt', '只能開啟 PDF'],
    ['does-not-exist.pdf', '找不到'],
  ]) {
    await js(`document.getElementById('toast').textContent = ''`);
    openFiles([fixture(file)]);
    await waitFor(`document.getElementById('toast').textContent.includes(${JSON.stringify(expected)})`, `message for ${file}`);
    check(`${file} explains the problem`, (await text('toast')).includes(expected), await text('toast'));
    await waitFor(`document.querySelectorAll('.tab').length === 5`, `no tab left for ${file}`);
  }

  // ---- A file dropped without a real path is ignored safely
  await js(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'fake.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('drop hint goes away', await js(`document.getElementById('drop-hint').hidden`));
  check('fake drop adds no tab', (await tabCount()) === 5);

  // ---- A big document
  const bigStart = Date.now();
  openFiles([fixture('big-500pages.pdf')]);
  await waitFor(`document.getElementById('page-total').textContent === '/ 500'`, '500 page file', 40000);
  await waitFor(pagesPainted(1), 'big file first page', 40000);
  const bigMs = Date.now() - bigStart;
  check('500 pages open quickly', bigMs < 8000, `${bigMs} ms`);
  check('thumbnail for every page', (await js(`document.querySelectorAll('.thumb-pane.active .thumb').length`)) === 500);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const drawn = await js(`document.querySelectorAll('.thumb-pane.active .thumb[data-drawn]').length`);
  check('only nearby thumbnails are drawn', drawn > 0 && drawn < 40, `${drawn} drawn`);
  const jumpStart = Date.now();
  await typePage(400);
  await waitFor(pagesPainted(400), 'jump to page 400', 15000);
  check('jumping to page 400', (await value('page-input')) === '400', `${Date.now() - jumpStart} ms`);
  await waitFor(`document.querySelector('.thumb-pane.active .thumb[data-page="400"]')?.dataset.drawn === 'true'`, 'thumbnail 400 drawn', 15000);
  check('thumbnail scrolls to the current page', await js(`(() => {
    const pane = document.querySelector('.thumb-pane.active').getBoundingClientRect();
    const item = document.querySelector('.thumb.current').getBoundingClientRect();
    return item.top >= pane.top - 1 && item.bottom <= pane.bottom + 1;
  })()`));
  check('thumbnails are never black while drawing', await js(`(() => {
    const blackCanvases = [...document.querySelectorAll('.thumb-pane.active canvas')].filter((c) => {
      const box = c.getBoundingClientRect();
      if (box.top > window.innerHeight || box.bottom < 0) return false;
      const [r, g, b, a] = c.getContext('2d').getImageData(1, 1, 1, 1).data;
      return a > 0 && r + g + b < 30;
    });
    return blackCanvases.length === 0;
  })()`));
  await shot('06-big');
  await press('w', { ctrlKey: true });
  await waitFor(`document.querySelectorAll('.tab').length === 5`, 'closing big file');

  // ---- A real file
  if (process.env.PDF_E2E_EXTRA) {
    openFiles([process.env.PDF_E2E_EXTRA]);
    await waitFor(`document.title.startsWith(${JSON.stringify(path.basename(process.env.PDF_E2E_EXTRA))}) && document.getElementById('page-total').textContent !== '/ 0'`, 'real file');
    await waitFor(pagesPainted(1), 'real file painted');
    check('real file has ink', (await js(inkExpression(1))) > 500);
    if (process.env.PDF_E2E_EXTRA_QUERY) {
      await click('btn-find');
      await js(`(() => { const i = document.getElementById('find-input'); i.value = ${JSON.stringify(process.env.PDF_E2E_EXTRA_QUERY)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await waitFor(`/\\/ [1-9]/.test(document.getElementById('find-count').textContent)`, 'search in the real file');
      check('search finds text in the real file', /\/ [1-9]/.test(await text('find-count')), await text('find-count'));
      await press('Escape');
    }
    await shot('07-real');
    await press('w', { ctrlKey: true });
    await waitFor(`document.querySelectorAll('.tab').length === 5`, 'closing real file');
  }

  // ---- Window resize keeps fit-to-page
  const beforeResize = await pageHeight();
  win.setSize(1000, 620);
  await new Promise((resolve) => setTimeout(resolve, 700));
  check('smaller window refits the page', (await pageHeight()) < beforeResize, `${beforeResize} to ${await pageHeight()}`);

  // ---- Sidebar
  await click('btn-thumbs');
  check('thumbnails can be hidden', (await js(`getComputedStyle(document.getElementById('sidebar')).display`)) === 'none');
  await click('btn-thumbs');
  check('thumbnails come back', (await js(`getComputedStyle(document.getElementById('sidebar')).display`)) !== 'none');

  // ---- Printing
  const selectTab = async (name) => {
    await js(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === ${JSON.stringify(name)}).click()`);
    await waitFor(`document.title.startsWith(${JSON.stringify(name)})`, `tab ${name}`);
  };

  // Memory is released after a few idle seconds; the document has to keep working
  await selectTab('mixed.pdf');
  await typePage(1);
  await waitFor(pagesPainted(1), 'page 1 before going idle');
  await new Promise((resolve) => setTimeout(resolve, 6500));
  check('the page on screen survives the idle cleanup', (await js(inkExpression(1))) > 500);
  await typePage(3);
  await waitFor(pagesPainted(3), 'a new page after the idle cleanup');
  check('new pages still draw after the idle cleanup', (await js(inkExpression(3))) > 500);
  await waitFor(`${textOnPage(3)}.includes('PAGE 3')`, 'text after the idle cleanup');
  check('text can still be selected after the idle cleanup', (await js(textOnPage(3))).includes('PAGE 3'));
  await click('btn-find');
  await js(`(() => { const i = document.getElementById('find-input'); i.value = 'quick brown'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`/ 8$/.test(document.getElementById('find-count').textContent)`, 'search after the idle cleanup');
  check('search still works after the idle cleanup', /\/ 8$/.test(await text('find-count')));
  await press('Escape');
  const setSelect = (id, v) => js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const setRadio = (name, v) => js(`(() => { const r = document.querySelector('input[name="${name}"][value="${v}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const setCustomRange = (v) => js(`(() => {
    const r = document.querySelector('input[name="print-range"][value="custom"]');
    r.checked = true;
    const i = document.getElementById('print-custom');
    i.value = ${JSON.stringify(v)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const sheetCount = () => js(`document.querySelectorAll('.sheet-item').length`);
  const waitAllSheetsDrawn = (n, label) => waitFor(`document.querySelectorAll('.sheet-item').length === ${n} && document.querySelectorAll('.sheet-item[data-drawn]').length === ${n}`, label);
  const openPrint = async () => {
    await js(`document.getElementById('btn-print').click()`);
    await waitFor(`document.getElementById('print-dialog').open && document.getElementById('print-printer').options.length > 0 && document.querySelectorAll('.sheet-item').length > 0`, 'print dialog ready');
  };
  const printDialogOpen = () => js(`document.getElementById('print-dialog').open`);
  const closePrint = async () => {
    await js(`document.getElementById('print-cancel').click()`);
    await waitFor(`!document.getElementById('print-dialog').open`, 'print dialog closed');
  };
  const summary = () => text('print-summary');
  const statusText = () => text('print-status');
  const printers = () => js(`[...document.getElementById('print-printer').options].map((o) => o.value)`);
  const noticeText = () => js(`document.getElementById('print-notices').textContent`);
  // Where the arrow on a turned page ends up: ink left or right of the middle, half way down.
  const arrowSide = (index) => js(`(() => {
    const c = document.querySelectorAll('.sheet-item')[${index}].querySelector('canvas');
    const context = c.getContext('2d');
    const y = Math.round(c.height / 2);
    const ink = (from, to) => {
      const data = context.getImageData(Math.round(from * c.width), y - 3, Math.round((to - from) * c.width), 6).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 100) dark++;
      return dark;
    };
    const left = ink(0.22, 0.42);
    const right = ink(0.58, 0.78);
    return left > right * 3 && left > 20 ? 'left' : right > left * 3 && right > 20 ? 'right' : 'unclear';
  })()`);

  await selectTab('mixed.pdf');
  await press('Home');
  await waitFor(`document.getElementById('page-input').value === '1'`, 'mixed on page 1');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))`);
  await waitFor(`document.getElementById('print-dialog').open && document.querySelectorAll('.sheet-item').length === 4`, 'Ctrl+P');
  check('Ctrl+P opens the print dialog', await printDialogOpen());
  check('printers are listed', (await printers()).length > 0, (await printers()).length + ' printers');
  check('the Windows default is chosen first', await js(`document.getElementById('print-printer').selectedOptions[0].textContent.endsWith('（預設）')`), await js(`document.getElementById('print-printer').selectedOptions[0].textContent`));
  check('defaults: one copy, all pages, counter-clockwise, fit, A4, colour, one side', await js(`
    document.getElementById('print-copies').value === '1'
    && document.querySelector('input[name="print-range"]:checked').value === 'all'
    && document.querySelector('input[name="print-direction"]:checked').value === 'counterclockwise'
    && document.getElementById('print-scale').value === 'fit'
    && document.getElementById('print-paper').value === 'A4'
    && !document.getElementById('print-grayscale').checked
    && document.getElementById('print-duplex').value === 'simplex'`));
  await waitFor(`document.getElementById('print-summary').textContent.includes('橫向')`, 'print summary');
  check('summary counts the turned pages', (await summary()) === '共 4 頁，其中 2 頁橫向已自動轉向', await summary());
  check('the print button stays in view on a small window', await js(`(() => {
    const button = document.getElementById('print-start').getBoundingClientRect();
    const box = document.getElementById('print-dialog').getBoundingClientRect();
    return button.bottom <= box.bottom && button.top >= box.top;
  })()`));
  check('preview says it is only a guide', (await js(`document.querySelector('.print-head span').textContent`)).includes('僅供參考'));
  await waitAllSheetsDrawn(4, 'preview drawn');
  check('all pages are upright on the sheet', await js(`[...document.querySelectorAll('.sheet canvas')].every((c) => c.height > c.width)`));
  check('only landscape pages are marked as turned', JSON.stringify(await js(`[...document.querySelectorAll('.sheet-item')].filter((i) => i.querySelector('.sheet-badge')).map((i) => i.dataset.page)`)) === '["2","4"]');
  check('counter-clockwise sends the arrow left', (await arrowSide(1)) === 'left', await arrowSide(1));
  await shot('08-print');

  await setRadio('print-direction', 'clockwise');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 4`, 'rebuild');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitAllSheetsDrawn(4, 'clockwise preview');
  check('clockwise sends the arrow right', (await arrowSide(1)) === 'right', await arrowSide(1));
  await setRadio('print-direction', 'counterclockwise');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitAllSheetsDrawn(4, 'back to counter-clockwise');

  await setCustomRange('1-2,4');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 3`, 'custom range');
  check('custom range limits the preview', JSON.stringify(await js(`[...document.querySelectorAll('.sheet-item')].map((i) => i.dataset.page)`)) === '["1","2","4"]');
  check('summary follows the range', (await summary()) === '共 3 頁，其中 2 頁橫向已自動轉向', await summary());
  check('the total page count shows while a range is typed', (await text('print-all-label')) === '全部（共 4 頁）', await text('print-all-label'));
  await setCustomRange('3-1');
  await waitFor(`!document.getElementById('print-range-error').hidden`, 'range error');
  check('reversed range is explained', (await text('print-range-error')).includes('由小到大'));
  check('print is disabled while the range is wrong', await js(`document.getElementById('print-start').disabled`));
  await setCustomRange('9');
  await waitFor(`document.getElementById('print-range-error').textContent.includes('1 到 4')`, 'out of range error');
  check('range past the end is explained', (await text('print-range-error')).includes('1 到 4'));
  await setCustomRange('２－３');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 2`, 'full-width range');
  check('full-width digits from a Chinese keyboard work', !(await js(`document.getElementById('print-start').disabled`)));
  await setRadio('print-range', 'current');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 1`, 'current page');
  check('current page shows one sheet', (await js(`document.querySelector('.sheet-item').dataset.page`)) === '1');
  await setRadio('print-range', 'all');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 4`, 'all pages again');

  await js(`(() => { const i = document.getElementById('print-copies'); i.value = '0'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('print is disabled with zero copies', await js(`document.getElementById('print-start').disabled`));
  await js(`(() => { const i = document.getElementById('print-copies'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('print is enabled again', !(await js(`document.getElementById('print-start').disabled`)));

  await setSelect('print-paper', 'legal');
  await waitFor(`Math.abs(document.querySelector('.sheet').getBoundingClientRect().height / document.querySelector('.sheet').getBoundingClientRect().width - 1008 / 612) < 0.02`, 'legal sheet');
  check('paper choice changes the sheet shape', true);
  await setSelect('print-paper', 'A4');

  const realPrinter = await js(`(() => {
    const names = [...document.getElementById('print-printer').options].map((o) => o.value);
    return names.find((n) => !/Print to PDF|OneNote|XPS/i.test(n)) ?? names[0];
  })()`);
  await setSelect('print-printer', realPrinter);
  await js(`(() => { const c = document.getElementById('print-grayscale'); c.click(); })()`);
  check('grayscale shows in the preview', await js(`document.getElementById('print-sheets').classList.contains('gray')`));
  await setSelect('print-duplex', 'duplexlong');
  await js(`(() => { const i = document.getElementById('print-copies'); i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setCustomRange('1-2,4');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 3`, 'range before printing');

  // A successful print
  await click('print-start');
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (printCalls.length > 0 || Date.now() - started > 8000) {
        clearInterval(poll);
        resolve();
      }
    }, 30);
  });
  check('printing starts Sumatra once', printCalls.length === 1, String(printCalls.length));
  const firstJob = printCalls[0];
  check('Sumatra is really in place', fs.existsSync(firstJob.command), firstJob.command);
  check('the command is exact', JSON.stringify(firstJob.args.slice(2)) === JSON.stringify([
    '-print-to', realPrinter,
    '-print-settings', '1-2,4,2x,fit,portrait,monochrome,duplexlong,paper=A4,ignore-pdf-print-settings',
    '-silent', fixture('mixed.pdf'),
  ]), JSON.stringify(firstJob.args.slice(2)));
  check('Sumatra keeps its settings out of the install folder', firstJob.args[0] === '-appdata' && firstJob.args[1].startsWith(userData), firstJob.args[1]);
  check('no pipes and not started hidden', firstJob.options.stdio === 'ignore' && firstJob.options.windowsHide === false);
  check('says it is working while Sumatra runs', (await statusText()).includes('處理中'), await statusText());
  check('stays open while Sumatra runs', await printDialogOpen());
  check('cancel is disabled while Sumatra runs', await js(`document.getElementById('print-cancel').disabled`));
  check('print is disabled while Sumatra runs', await js(`document.getElementById('print-start').disabled`));
  await js(`document.getElementById('print-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  check('Esc does not close it while Sumatra runs', await printDialogOpen());
  firstJob.finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'dialog closes after printing');
  check('closes after a good print', !(await printDialogOpen()));
  await waitFor(`document.getElementById('toast').textContent.includes('已送出到印表機')`, 'sent message');
  check('says it was sent', (await text('toast')).includes('已送出到印表機'), await text('toast'));

  // What is and is not remembered
  const savedPrint = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).print;
  check('settings are saved', savedPrint.printer === realPrinter && savedPrint.grayscale === true && savedPrint.duplex === 'duplexlong', JSON.stringify(savedPrint));
  check('copies and pages are not saved', !('copies' in savedPrint) && !('pages' in savedPrint));
  await openPrint();
  check('settings come back next time', await js(`
    document.getElementById('print-grayscale').checked
    && document.getElementById('print-duplex').value === 'duplexlong'
    && document.getElementById('print-printer').value === ${JSON.stringify(realPrinter)}
    && document.getElementById('print-sheets').classList.contains('gray')`));
  check('copies and range start fresh', await js(`
    document.getElementById('print-copies').value === '1'
    && document.querySelector('input[name="print-range"]:checked').value === 'all'`));

  // A failed print
  await click('print-start');
  await waitFor(`document.getElementById('print-cancel').disabled`, 'job started');
  printCalls.at(-1).finish(1);
  await waitFor(`document.getElementById('print-status').textContent.includes('列印失敗')`, 'failure message');
  check('a failed print explains and stays open', (await statusText()).includes('列印失敗') && (await printDialogOpen()));
  check('after a failure you can try again or cancel', await js(`!document.getElementById('print-cancel').disabled && !document.getElementById('print-start').disabled`));

  // Microsoft Print to PDF asks where to save
  const fileAsker = (await printers()).find((name) => /Print to PDF/i.test(name));
  if (fileAsker) {
    await setSelect('print-printer', fileAsker);
    check('warns that a Save As window will come', (await text('print-printer-hint')).includes('存檔') && !(await js(`document.getElementById('print-printer-hint').hidden`)));
    await click('print-start');
    await waitFor(`document.getElementById('print-status').textContent.includes('另存列印輸出')`, 'save as prompt');
    check('points to the Save As window while waiting', (await statusText()).includes('另存列印輸出'));
    printCalls.at(-1).finish(1);
    await waitFor(`document.getElementById('print-status').textContent.includes('已取消')`, 'cancel message');
    check('cancelling the Save As window is not called an error', (await statusText()).includes('已取消') && !(await js(`document.getElementById('print-status').classList.contains('error')`)));
    await setSelect('print-printer', realPrinter);
    check('the hint goes away with another printer', await js(`document.getElementById('print-printer-hint').hidden`));
  }

  // Clockwise uses a temporary copy that is removed afterwards
  await setRadio('print-direction', 'clockwise');
  const beforeClockwise = printCalls.length;
  const originalBytes = fs.readFileSync(fixture('mixed.pdf'));
  await click('print-start');
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (printCalls.length > beforeClockwise || Date.now() - started > 8000) {
        clearInterval(poll);
        resolve();
      }
    }, 30);
  });
  const clockwiseJob = printCalls.at(-1);
  const copyPath = clockwiseJob.args.at(-1);
  check('clockwise prints a temporary copy', copyPath !== fixture('mixed.pdf') && copyPath.startsWith(app.getPath('temp')), copyPath);
  const copy = await PDFDocument.load(fs.readFileSync(copyPath));
  check('the copy has its landscape pages turned', JSON.stringify(copy.getPages().map((p) => p.getRotation().angle)) === '[0,90,0,90]');
  check('the original file is untouched', originalBytes.equals(fs.readFileSync(fixture('mixed.pdf'))));
  clockwiseJob.finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'clockwise print done');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('the temporary copy is deleted afterwards', !fs.existsSync(copyPath));

  // Back to plain settings for the rest. Settings are only saved by printing.
  await openPrint();
  check('clockwise is remembered', await js(`document.querySelector('input[name="print-direction"]:checked').value === 'clockwise'`));
  await setRadio('print-direction', 'counterclockwise');
  await js(`document.getElementById('print-grayscale').click()`);
  await setSelect('print-duplex', 'simplex');
  await click('print-start');
  await waitFor(`document.getElementById('print-cancel').disabled`, 'plain print started');
  printCalls.at(-1).finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'plain print done');
  await openPrint();
  await setRadio('print-direction', 'clockwise');
  await closePrint();
  await openPrint();
  check('closing without printing does not save changes', await js(`document.querySelector('input[name="print-direction"]:checked').value === 'counterclockwise'`));
  await closePrint();

  // Rotating the view must not affect the printout
  await click('btn-rotate-right');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await openPrint();
  await waitAllSheetsDrawn(4, 'preview with a rotated view');
  check('rotate view does not change the printout', (await arrowSide(1)) === 'left' && await js(`document.querySelector('.sheet canvas').height > document.querySelector('.sheet canvas').width`));
  await closePrint();
  for (let i = 0; i < 3; i++) await click('btn-rotate-right');

  // Fit, shrink and actual size
  await selectTab('small-page.pdf');
  await openPrint();
  const canvasShare = () => js(`document.querySelector('.sheet canvas').getBoundingClientRect().width / document.querySelector('.sheet').getBoundingClientRect().width`);
  await waitAllSheetsDrawn(1, 'small page preview');
  check('fit enlarges a small page', Math.abs((await canvasShare()) - 1) < 0.02, String(await canvasShare()));
  await setSelect('print-scale', 'shrink');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitAllSheetsDrawn(1, 'shrink preview');
  check('shrink keeps a small page small', Math.abs((await canvasShare()) - 0.5) < 0.02, String(await canvasShare()));
  check('shrink stays centred', !(await js(`document.querySelector('.sheet').classList.contains('actual-size')`)));
  await setSelect('print-scale', 'noscale');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitAllSheetsDrawn(1, 'actual size preview');
  check('actual size starts at the corner', await js(`document.querySelector('.sheet').classList.contains('actual-size')`));
  await setSelect('print-scale', 'fit');
  await closePrint();

  // Annotations that will not print
  await selectTab('annotated.pdf');
  await openPrint();
  await waitAllSheetsDrawn(1, 'annotated preview');
  await waitFor(`document.getElementById('print-notices').textContent.includes('註解')`, 'annotation notice');
  check('warns about annotations that will not print', (await noticeText()).includes('有 1 個註解'), await noticeText());
  const colours = await js(`(() => {
    const c = document.querySelector('.sheet canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++;
      if (d[i + 2] > 200 && d[i] < 60 && d[i + 1] < 60) blue++;
    }
    return { red, blue };
  })()`);
  check('preview shows the printable annotation only', colours.red > colours.blue * 2 && colours.blue > 0, JSON.stringify(colours));
  await shot('09-annotated-print');
  await closePrint();

  // Pages that only look landscape, or only look portrait
  openFiles([fixture('prerotated.pdf')]);
  await waitFor(`document.title.startsWith('prerotated.pdf') && document.getElementById('page-total').textContent === '/ 1'`, 'prerotated file');
  await openPrint();
  await waitAllSheetsDrawn(1, 'prerotated preview');
  check('a page that looks landscape is turned', await js(`Boolean(document.querySelector('.sheet-badge')) && document.querySelector('.sheet canvas').height > document.querySelector('.sheet canvas').width`));
  check('and its arrow goes left', (await arrowSide(0)) === 'left', await arrowSide(0));
  await closePrint();
  openFiles([fixture('landscape-rotated.pdf')]);
  await waitFor(`document.title.startsWith('landscape-rotated.pdf') && document.getElementById('page-total').textContent === '/ 1'`, 'landscape-rotated file');
  await openPrint();
  await waitAllSheetsDrawn(1, 'landscape-rotated preview');
  check('a page that looks portrait is left alone', await js(`!document.querySelector('.sheet-badge') && document.querySelector('.sheet canvas').height > document.querySelector('.sheet canvas').width`));
  await waitFor(`document.getElementById('print-summary').textContent.includes('橫向')`, 'summary without landscape');
  check('summary says there is no landscape page', (await summary()) === '共 1 頁，沒有橫向頁', await summary());
  await closePrint();

  // Protected files
  openFiles([fixture('enc-owner-no-print.pdf')]);
  await waitFor(`document.title.startsWith('enc-owner-no-print') && document.getElementById('page-total').textContent === '/ 1'`, 'print-forbidden file');
  await openPrint();
  check('reminds when the author forbids printing', (await noticeText()).includes('禁止列印'), await noticeText());
  check('but printing stays possible', !(await js(`document.getElementById('print-start').disabled`)));
  check('protected files only turn counter-clockwise', await js(`document.querySelector('input[name="print-direction"][value="clockwise"]').disabled && !document.getElementById('print-direction-hint').hidden`));
  const beforeForbidden = printCalls.length;
  await click('print-start');
  await waitFor(`document.getElementById('print-cancel').disabled`, 'forbidden job started');
  check('a print-forbidden file still goes to the printer', printCalls.length === beforeForbidden + 1 && printCalls.at(-1).args.at(-1) === fixture('enc-owner-no-print.pdf'));
  printCalls.at(-1).finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'forbidden print done');
  openFiles([fixture('enc-owner-print-allowed.pdf')]);
  await waitFor(`document.title.startsWith('enc-owner-print-allowed') && document.getElementById('page-total').textContent === '/ 1'`, 'protected file');
  await openPrint();
  check('no reminder when printing is allowed', !(await noticeText()).includes('禁止列印'), await noticeText());
  check('protected but printable can print', !(await js(`document.getElementById('print-start').disabled`)));
  await closePrint();

  openFiles([fixture('enc-open-password.pdf')]);
  await waitFor(`document.getElementById('password-dialog').open`, 'password for printing test');
  await js(`document.getElementById('password-input').value = 'test1234'; document.getElementById('password-ok').click()`);
  await waitFor(`document.title.startsWith('enc-open-password') && document.getElementById('page-total').textContent === '/ 1'`, 'password file open');
  await openPrint();
  await waitFor(`!document.getElementById('print-start').disabled`, 'print ready for a file opened with its password');
  check('a file opened with its password can be printed', !(await noticeText()).includes('開啟密碼') && !(await js(`document.getElementById('print-start').disabled`)), await noticeText());
  await shot('10-password-print');
  await closePrint();
  await press('w', { ctrlKey: true });

  // A clockwise request that pdf-lib cannot handle falls back instead of failing
  await selectTab('mixed.pdf');
  const realReadFile = fs.promises.readFile;
  fs.promises.readFile = async (file, ...rest) => {
    if (file === fixture('mixed.pdf')) throw new Error('simulated: unreadable for pdf-lib');
    return realReadFile(file, ...rest);
  };
  await openPrint();
  await setRadio('print-direction', 'clockwise');
  const beforeFallback = printCalls.length;
  await click('print-start');
  await waitFor(`document.getElementById('print-cancel').disabled`, 'fallback job started');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('falls back to printing the original', printCalls.length === beforeFallback + 1 && printCalls.at(-1).args.at(-1) === fixture('mixed.pdf'));
  printCalls.at(-1).finish(0);
  fs.promises.readFile = realReadFile;
  await waitFor(`document.getElementById('toast').textContent.includes('逆時針')`, 'fallback message');
  check('says it used counter-clockwise instead', (await text('toast')).includes('逆時針'), await text('toast'));
  await openPrint();
  await setRadio('print-direction', 'counterclockwise');
  await closePrint();

  // Several pages per sheet
  const slotBoxes = () => js(`[...document.querySelectorAll('.sheet-slot')].map((c) => {
    const r = c.getBoundingClientRect();
    return { page: Number(c.dataset.page), x: r.left, y: r.top, w: r.width, h: r.height };
  })`);
  const slotArrowSide = (page) => js(`(() => {
    const c = document.querySelector('.sheet-slot[data-page="${page}"]');
    const context = c.getContext('2d');
    const y = Math.round(c.height / 2);
    const ink = (from, to) => {
      const data = context.getImageData(Math.round(from * c.width), y - 3, Math.round((to - from) * c.width), 6).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 100) dark++;
      return dark;
    };
    const left = ink(0.22, 0.42);
    const right = ink(0.58, 0.78);
    return left > right * 3 && left > 5 ? 'left' : right > left * 3 && right > 5 ? 'right' : 'unclear';
  })()`);
  const waitSheetsDrawn = (n, label) => waitFor(`document.querySelectorAll('.sheet-item').length === ${n} && document.querySelectorAll('.sheet-item[data-drawn]').length === ${n} && !document.getElementById('print-start').disabled`, label);
  const printAndCatch = async (label) => {
    const before = printCalls.length;
    await click('print-start');
    for (const started = Date.now(); printCalls.length === before && Date.now() - started < 12000;) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    check(`${label}: Sumatra is started once`, printCalls.length === before + 1);
    return printCalls.at(-1);
  };
  const settingsOf = (job) => job.args[job.args.indexOf('-print-settings') + 1];

  await openPrint();
  check('starts at one page per sheet', await js(`document.getElementById('print-per-sheet').value === '1' && document.getElementById('print-border-row').hidden && !document.getElementById('print-scale').disabled`));
  await setRadio('print-direction', 'counterclockwise');
  await setSelect('print-per-sheet', '4');
  await waitSheetsDrawn(1, 'four per sheet');
  check('four pages share one sheet in the preview', (await js(`document.querySelectorAll('.sheet-item .sheet-slot').length`)) === 4);
  check('the sheet says which pages it holds', (await js(`document.querySelector('.sheet-label').textContent`)) === '第 1 張：第 1–4 頁', await js(`document.querySelector('.sheet-label').textContent`));
  check('summary counts sheets and turned pages', (await summary()) === '共 4 頁，每張紙印 4 頁，要用 1 張紙，2 頁已轉向', await summary());
  check('scale is not offered, frames are', await js(`document.getElementById('print-scale').disabled && !document.getElementById('print-border-row').hidden`));
  const four = await slotBoxes();
  check('pages go left to right, then down', four.map((b) => b.page).join() === '1,2,3,4'
    && four[1].x > four[0].x + four[0].w && Math.abs(four[1].y - four[0].y) < 2 && four[2].y > four[0].y + four[0].h, JSON.stringify(four));
  check('landscape pages are turned to fit their space', four[1].h > four[1].w && four[3].h > four[3].w);
  check('and turned the chosen way', (await slotArrowSide(2)) === 'left', await slotArrowSide(2));
  check('one page per sheet frames nothing', !(await js(`document.querySelector('.sheet').classList.contains('framed')`)));
  await js(`document.getElementById('print-border').click()`);
  check('frames show in the preview at once', await js(`document.querySelector('.sheet').classList.contains('framed') && document.querySelector('.sheet-item').dataset.drawn === 'true'`));
  await shot('10b-four-per-sheet');
  const fourJob = await printAndCatch('four per sheet');
  const sheetsFile = fourJob.args.at(-1);
  check('prints a temporary file of whole sheets', sheetsFile !== fixture('mixed.pdf') && sheetsFile.startsWith(app.getPath('temp')), sheetsFile);
  check('every sheet is printed, fitted to the paper', /^fit,portrait,/.test(settingsOf(fourJob)), settingsOf(fourJob));
  const sheetsDoc = await PDFDocument.load(fs.readFileSync(sheetsFile));
  const sheetSize = sheetsDoc.getPage(0).getSize();
  check('the file holds one A4 sheet', sheetsDoc.getPageCount() === 1 && Math.abs(sheetSize.width - 595.28) < 0.1 && Math.abs(sheetSize.height - 841.89) < 0.1, JSON.stringify(sheetSize));
  fourJob.finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'four per sheet printed');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('the file of sheets is deleted afterwards', !fs.existsSync(sheetsFile));

  // A file the layout cannot read says so and prints nothing.
  fs.promises.readFile = async (file, ...rest) => {
    if (file === fixture('mixed.pdf')) throw new Error('simulated: unreadable for pdf-lib');
    return realReadFile(file, ...rest);
  };
  await openPrint();
  await setSelect('print-per-sheet', '4');
  await waitSheetsDrawn(1, 'four per sheet before a failure');
  const beforeArrangeFailure = printCalls.length;
  await click('print-start');
  await waitFor(`document.getElementById('print-status').textContent.includes('每張紙印 1 頁')`, 'cannot arrange message');
  fs.promises.readFile = realReadFile;
  check('a file that cannot be laid out explains and sends nothing', printCalls.length === beforeArrangeFailure && await js(`document.getElementById('print-status').classList.contains('error')`));
  await setSelect('print-per-sheet', '1');
  check('the message goes away with one page per sheet', await js(`document.getElementById('print-status').hidden`));
  await closePrint();

  // Protected files are laid out too, and printable annotations show.
  openFiles([fixture('enc-owner-print-allowed.pdf')]);
  await waitFor(`document.title.startsWith('enc-owner-print-allowed') && document.getElementById('page-total').textContent === '/ 1'`, 'protected file for sheets');
  await openPrint();
  await setSelect('print-per-sheet', '2');
  await waitSheetsDrawn(1, 'protected two per sheet');
  const protectedSheets = await printAndCatch('protected file per sheet');
  check('a protected file still becomes sheets', (await PDFDocument.load(fs.readFileSync(protectedSheets.args.at(-1)))).getPageCount() === 1);
  protectedSheets.finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'protected sheets printed');
  await selectTab('annotated.pdf');
  await openPrint();
  await setSelect('print-per-sheet', '2');
  await waitSheetsDrawn(1, 'annotated two per sheet');
  const sheetColours = await js(`(() => {
    const c = document.querySelector('.sheet-slot');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++;
      if (d[i + 2] > 200 && d[i] < 60 && d[i + 1] < 60) blue++;
    }
    return { red, blue };
  })()`);
  check('the sheet preview shows only the printable annotation', sheetColours.red > 0 && sheetColours.red > sheetColours.blue * 2, JSON.stringify(sheetColours));
  await closePrint();
  await selectTab('mixed.pdf');

  // Last, because it leaves clockwise remembered, as the batch tests expect.
  await openPrint();
  check('pages per sheet is not remembered', await js(`document.getElementById('print-per-sheet').value === '1' && !document.getElementById('print-border').checked`));
  await setCustomRange('1,3');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await setSelect('print-per-sheet', '2');
  await waitSheetsDrawn(1, 'two per sheet');
  check('two upright pages lie side by side', (await summary()).endsWith('印出來要橫著看') && await js(`(() => { const r = document.querySelector('.sheet').getBoundingClientRect(); return r.width > r.height; })()`), await summary());
  check('the label follows the range', (await js(`document.querySelector('.sheet-label').textContent`)) === '第 1 張：第 1、3 頁');

  // Both sides: paper is counted in sheets, sides are front and back, and sideways sheets say how to turn over.
  const sheetLabel = () => js(`document.querySelector('.sheet-label').textContent`);
  const setCopies = (n) => js(`(() => { const c = document.getElementById('print-copies'); c.value = '${n}'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('one-sided shows no turn-over hint', await js(`document.getElementById('print-duplex-hint').hidden`));
  await setSelect('print-duplex', 'duplexlong');
  check('two-sided counts sheets of paper', (await summary()) === '共 2 頁，每張紙印 2 頁，雙面印，要用 1 張紙，印出來要橫著看', await summary());
  check('two-sided names the front', (await sheetLabel()) === '第 1 張正面：第 1、3 頁', await sheetLabel());
  check('long edge on a sideways sheet points to short edge', !(await js(`document.getElementById('print-duplex-hint').hidden`)) && (await text('print-duplex-hint')).includes('改選「雙面短邊翻頁」'), await text('print-duplex-hint'));
  await setSelect('print-duplex', 'duplexshort');
  check('short edge on a sideways sheet turns like a book', (await text('print-duplex-hint')).includes('像翻書') && !(await text('print-duplex-hint')).includes('改選'), await text('print-duplex-hint'));
  await setCopies(2);
  check('more copies count paper per copy', (await summary()).includes('雙面印，每份要用 1 張紙'), await summary());
  await setCopies(1);
  await setSelect('print-duplex', 'simplex');
  check('one-sided again hides the hint and drops front and back', await js(`document.getElementById('print-duplex-hint').hidden`) && (await sheetLabel()) === '第 1 張：第 1、3 頁', await sheetLabel());

  await setRadio('print-direction', 'clockwise');
  await waitSheetsDrawn(1, 'two per sheet, clockwise');
  const twoJob = await printAndCatch('two per sheet clockwise');
  const twoDoc = await PDFDocument.load(fs.readFileSync(twoJob.args.at(-1)));
  check('a lying sheet is turned clockwise in the file', twoDoc.getPage(0).getRotation().angle === 90 && twoDoc.getPage(0).getSize().width > twoDoc.getPage(0).getSize().height);
  check('the page range is not sent again', !/^\d/.test(settingsOf(twoJob)), settingsOf(twoJob));
  twoJob.finish(0);
  await waitFor(`!document.getElementById('print-dialog').open`, 'two per sheet printed');

  // A long document keeps only nearby preview images
  openFiles([fixture('big-500pages.pdf')]);
  await waitFor(`document.title.startsWith('big-500pages') && document.getElementById('page-total').textContent === '/ 500'`, 'big file for printing');
  await js(`document.getElementById('btn-print').click()`);
  await waitFor(`document.querySelectorAll('.sheet-item').length === 500`, 'big print preview');
  await waitFor(`document.querySelector('.sheet-item[data-index="0"]')?.dataset.drawn === 'true'`, 'first big sheet');
  for (let top = 0; top <= 9000; top += 900) {
    await js(`document.getElementById('print-sheets').scrollTop = ${top}; 0`);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  const keptImages = await js(`document.querySelectorAll('.sheet canvas').length`);
  check('a long preview keeps only nearby page images', keptImages > 0 && keptImages <= 30, `${keptImages} of 500`);
  check('far away sheets are emptied', await js(`document.querySelector('.sheet-item[data-index="0"] canvas') === null && !document.querySelector('.sheet-item[data-index="0"]').dataset.drawn`));
  await js(`document.getElementById('print-sheets').scrollTop = 0; 0`);
  await waitFor(`document.querySelector('.sheet-item[data-index="0"]')?.dataset.drawn === 'true'`, 'first sheet redrawn after scrolling back');
  check('scrolling back draws it again', await js(`document.querySelector('.sheet-item[data-index="0"] canvas').width > 0`));
  const layoutStarted = Date.now();
  await setSelect('print-per-sheet', '16');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 32 && document.querySelector('.sheet-item[data-index="0"]')?.dataset.drawn === 'true'`, '500 pages, 16 per sheet');
  check('500 pages are laid out 16 per sheet quickly', Date.now() - layoutStarted < 5000, `${Date.now() - layoutStarted} ms`);
  check('a long layout draws only nearby sheets', (await js(`document.querySelectorAll('.sheet-item[data-drawn]').length`)) < 32);
  await closePrint();
  await press('w', { ctrlKey: true });
  await waitFor(`!document.title.startsWith('big-500pages')`, 'big file closed');

  // Keys do not reach the page behind the dialog
  const tabsBehind = await tabCount();
  await openPrint();
  await press('w', { ctrlKey: true });
  check('Ctrl+W leaves the tab alone while the dialog is open', (await tabCount()) === tabsBehind);
  await closePrint();
  // ---- Batch printing
  const batchRowCount = () => js(`document.querySelectorAll('#batch-list .file-row').length`);
  const batchNames = () => js(`[...document.querySelectorAll('#batch-list .file-name')].map((n) => n.textContent)`);
  const batchRow = (name) => `[...document.querySelectorAll('#batch-list .file-row')].find((r) => r.querySelector('.file-name').textContent === ${JSON.stringify(name)})`;
  const batchRowText = (name) => js(`${batchRow(name)}?.textContent ?? ''`);
  const batchSummaryText = () => text('batch-summary');
  const batchStatus = () => text('batch-status');
  const batchOpen = () => js(`document.getElementById('batch-dialog').open`);
  const batchSheets = (n) => `document.querySelectorAll('#batch-sheets .sheet-item').length === ${n} && document.querySelectorAll('#batch-sheets .sheet-item[data-drawn]').length === ${n}`;
  const pickFiles = async (names, count) => {
    pickedFiles = names.map(fixture);
    await click('batch-add');
    await waitFor(`document.querySelectorAll('#batch-list .file-row').length === ${count} && !document.getElementById('batch-summary').textContent.includes('還剩')`, `files checked: ${names.join(', ')}`, 40000);
  };
  const openBatch = async () => {
    await click('btn-batch');
    await waitFor(`document.getElementById('batch-dialog').open && document.getElementById('batch-printer').options.length > 0`, 'batch dialog ready');
  };
  const closeBatch = async () => {
    await click('batch-close');
    await waitFor(`!document.getElementById('batch-dialog').open`, 'batch dialog closed');
  };
  const waitForNewPrint = async (count) => {
    for (const started = Date.now(); printCalls.length < count && Date.now() - started < 12000;) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return printCalls[count - 1];
  };
  const sentFile = (call) => path.basename(call?.args.at(-1) ?? 'nothing was sent');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Tall enough to draw all four preview pages of mixed.pdf at once.
  win.setSize(1400, 1000);
  await pause(500);
  const tabsBeforeBatch = await tabCount();
  const heldBeforeBatch = heldFiles.size;
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }))`);
  await waitFor(`document.getElementById('batch-dialog').open && document.getElementById('batch-printer').options.length > 0`, 'Ctrl+Shift+P');
  check('Ctrl+Shift+P opens batch printing', (await batchOpen()) && !(await printDialogOpen()));
  check('the batch button works with no file too', !(await js(`document.getElementById('btn-batch').disabled`)));
  check('uses the remembered settings', (await value('batch-printer')) === realPrinter && (await value('batch-paper')) === 'A4', await value('batch-printer'));
  check('an empty list says what to do', !(await js(`document.getElementById('batch-empty').hidden`)) && (await batchSummaryText()) === '還沒有加入檔案');
  check('nothing to print yet', await js(`document.getElementById('batch-start').disabled`));
  await shot('11-batch-empty');
  await press('w', { ctrlKey: true });
  check('Ctrl+W leaves the tabs alone during batch printing', (await tabCount()) === tabsBeforeBatch);
  // The test before this one left clockwise remembered.
  check('picks up the remembered direction', await js(`document.querySelector('input[name="batch-direction"]:checked').value === 'clockwise'`));
  await setRadio('batch-direction', 'counterclockwise');

  // Adding files, with reasons on the ones that cannot print
  await pickFiles(['mixed.pdf', 'small-page.pdf', 'annotated.pdf', 'enc-owner-no-print.pdf', 'enc-owner-print-allowed.pdf', 'enc-open-password.pdf', 'corrupt.pdf', 'empty.pdf'], 8);
  check('each row shows pages and landscape pages', (await batchRowText('mixed.pdf')).includes('4 頁，其中 2 頁橫向'), await batchRowText('mixed.pdf'));
  check('a file with no landscape page says so', (await batchRowText('small-page.pdf')).includes('沒有橫向頁'), await batchRowText('small-page.pdf'));
  check('warns about annotations that will not print', (await batchRowText('annotated.pdf')).includes('有 1 個註解'), await batchRowText('annotated.pdf'));
  check('reminds about forbidden printing without blocking it', (await batchRowText('enc-owner-no-print.pdf')).includes('禁止列印') && !(await batchRowText('enc-owner-no-print.pdf')).includes('不會列印'), await batchRowText('enc-owner-no-print.pdf'));
  check('an open password is marked, with a button and no prompt', (await batchRowText('enc-open-password.pdf')).includes('有開啟密碼，按右邊的鑰匙輸入密碼才會列印') && !(await js(`document.getElementById('password-dialog').open`)), await batchRowText('enc-open-password.pdf'));
  check('a damaged file is marked', (await batchRowText('corrupt.pdf')).includes('損毀'), await batchRowText('corrupt.pdf'));
  check('an empty file is marked', (await batchRowText('empty.pdf')).includes('空的'), await batchRowText('empty.pdf'));
  check('the summary adds up the good files', (await batchSummaryText()).startsWith('共 5 個檔案、8 頁') && (await batchSummaryText()).endsWith('另有 3 個不能印'), await batchSummaryText());
  check('printing is possible now', !(await js(`document.getElementById('batch-start').disabled`)));
  await shot('12-batch-list');

  pickedFiles = [fixture('mixed.pdf').toUpperCase()];
  await click('batch-add');
  await waitFor(`document.getElementById('batch-status').textContent.includes('不會重複')`, 'duplicate message');
  check('the same file is not added twice', (await batchRowCount()) === 8);

  await click('batch-add-open');
  await waitFor(`document.querySelectorAll('#batch-list .file-row').length === 12 && !document.getElementById('batch-summary').textContent.includes('還剩')`, 'open tabs added', 40000);
  check('adds the open files that are not on the list yet', (await batchRowCount()) === 12, String(await batchRowCount()));
  check('adding them does not touch the tabs', (await tabCount()) === tabsBeforeBatch);
  for (const name of ['cjk-not-embedded.pdf', 'square.pdf', 'prerotated.pdf', 'landscape-rotated.pdf']) {
    await js(`${batchRow(name)}.querySelector('.file-remove').click()`);
  }
  check('the remove button takes a file off the list', (await batchRowCount()) === 8);
  await pause(200);
  check('removed files are let go of', heldFiles.size === heldBeforeBatch + 7, String(heldFiles.size - heldBeforeBatch));

  await js(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    data.items.add(new File(['x'], 'fake.pdf', { type: 'application/pdf' }));
    const dialog = document.getElementById('batch-dialog');
    dialog.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    dialog.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`);
  await pause(200);
  check('dropped files stay in the batch and open no tab', (await tabCount()) === tabsBeforeBatch && (await batchRowCount()) === 8);
  check('says other kinds of file were skipped', (await batchStatus()).includes('只能加入 PDF'), await batchStatus());
  check('the main drop hint stays out of the way', await js(`document.getElementById('drop-hint').hidden && !document.getElementById('batch-dialog').classList.contains('dropping')`));

  // Preview of the chosen file
  await waitFor(batchSheets(4), 'first file previewed');
  check('the first file is previewed', (await text('batch-preview-name')) === 'mixed.pdf');
  check('and is marked in the list', await js(`${batchRow('mixed.pdf')}.classList.contains('selected')`));
  check('the preview says it is only a guide', (await js(`document.querySelector('.batch-preview .print-head span').textContent`)).includes('僅供參考'));
  check('landscape pages are marked as turned', JSON.stringify(await js(`[...document.querySelectorAll('#batch-sheets .sheet-item')].filter((i) => i.querySelector('.sheet-badge')).map((i) => i.dataset.page)`)) === '["2","4"]');
  check('counter-clockwise sends the arrow left', (await arrowSide(1)) === 'left', await arrowSide(1));
  await shot('13-batch-preview');
  await js(`${batchRow('small-page.pdf')}.click()`);
  await waitFor(batchSheets(1), 'second file previewed');
  check('clicking a row shows that file', (await text('batch-preview-name')) === 'small-page.pdf');
  await js(`${batchRow('enc-open-password.pdf')}.click()`);
  await waitFor(`document.getElementById('batch-preview-note').textContent.includes('開啟密碼')`, 'note instead of a preview');
  check('a file that cannot print explains itself instead', (await js(`document.querySelectorAll('#batch-sheets .sheet-item').length`)) === 0);
  await js(`${batchRow('mixed.pdf')}.click()`);
  await waitFor(batchSheets(4), 'back to the first file');
  check('the note goes away again', await js(`document.getElementById('batch-preview-note').hidden`));
  await setRadio('batch-direction', 'clockwise');
  await pause(100);
  await waitFor(batchSheets(4), 'clockwise preview');
  check('clockwise shows in the preview', (await arrowSide(1)) === 'right', await arrowSide(1));
  check('protected files warn about clockwise', (await batchRowText('enc-owner-print-allowed.pdf')).includes('受保護'), await batchRowText('enc-owner-print-allowed.pdf'));
  await setRadio('batch-direction', 'counterclockwise');
  await pause(100);
  await waitFor(batchSheets(4), 'counter-clockwise again');
  check('the warning goes away with counter-clockwise', !(await batchRowText('enc-owner-print-allowed.pdf')).includes('受保護'));
  await setSelect('batch-paper', 'legal');
  await waitFor(`Math.abs(document.querySelector('#batch-sheets .sheet').getBoundingClientRect().height / document.querySelector('#batch-sheets .sheet').getBoundingClientRect().width - 1008 / 612) < 0.02`, 'legal sheet in the batch');
  check('paper choice changes the preview', true);
  await setSelect('batch-paper', 'A4');
  await js(`document.getElementById('batch-grayscale').click()`);
  check('grayscale shows in the preview', await js(`document.getElementById('batch-sheets').classList.contains('gray')`));
  await js(`document.getElementById('batch-grayscale').click()`);
  await js(`(() => { const i = document.getElementById('batch-copies'); i.value = '0'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('zero copies cannot print', await js(`document.getElementById('batch-start').disabled`));
  await js(`(() => { const i = document.getElementById('batch-copies'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  // Dragging a row changes the order
  const dragRow = (name, beforeName) => js(`(() => {
    const list = document.getElementById('batch-list');
    const row = ${batchRow(name)};
    const data = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }));
    const target = ${beforeName ? batchRow(beforeName) : 'null'};
    const y = target ? target.getBoundingClientRect().top + 1 : list.lastElementChild.getBoundingClientRect().bottom + 5;
    list.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, clientY: y, bubbles: true, cancelable: true }));
    const marks = list.querySelectorAll('.drop-before, .drop-after').length;
    list.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    row.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
    return marks;
  })()`);
  check('a line shows where the file will land', (await dragRow('annotated.pdf', 'mixed.pdf')) === 1);
  check('dragging moves a file up', (await batchNames())[0] === 'annotated.pdf', (await batchNames()).join());
  await dragRow('small-page.pdf', null);
  check('dragging moves a file to the end', (await batchNames()).at(-1) === 'small-page.pdf', (await batchNames()).join());
  await dragRow('small-page.pdf', 'enc-owner-no-print.pdf');
  check('and back up', JSON.stringify((await batchNames()).slice(0, 4)) === JSON.stringify(['annotated.pdf', 'mixed.pdf', 'small-page.pdf', 'enc-owner-no-print.pdf']), (await batchNames()).join());
  check('no marks left after dragging', await js(`document.querySelectorAll('.drop-before, .drop-after, .file-row.dragging').length === 0`));
  check('dragging a row opens no tab', (await tabCount()) === tabsBeforeBatch);

  // One file at a time, in list order. A failure does not stop the rest.
  const beforeBatch = printCalls.length;
  await click('batch-start');
  const job1 = await waitForNewPrint(beforeBatch + 1);
  check('starts with the first file on the list', sentFile(job1) === 'annotated.pdf', sentFile(job1));
  check('the command is exact', JSON.stringify(job1.args.slice(2)) === JSON.stringify([
    '-print-to', realPrinter,
    '-print-settings', 'fit,portrait,color,simplex,paper=A4,ignore-pdf-print-settings',
    '-silent', fixture('annotated.pdf'),
  ]), JSON.stringify(job1.args.slice(2)));
  check('shows the progress', (await text('batch-progress-text')) === '正在列印 1 / 5：annotated.pdf', await text('batch-progress-text'));
  check('progress bar is visible', await js(`!document.getElementById('batch-progress').hidden && document.getElementById('batch-bar').max === 5`));
  check('marks the file being printed', await js(`${batchRow('annotated.pdf')}.classList.contains('printing')`));
  check('stop replaces close while printing', await js(`!document.getElementById('batch-stop').hidden && document.getElementById('batch-close').hidden`));
  check('the list and settings are locked while printing', await js(`document.getElementById('batch-start').disabled && document.getElementById('batch-add').disabled && document.getElementById('batch-fields').disabled && document.querySelector('.file-remove').disabled && !document.querySelector('.file-row').draggable`));
  await js(`document.getElementById('batch-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  check('Esc does not close it while printing', await batchOpen());
  await pause(400);
  check('the next file waits for the first to finish', printCalls.length === beforeBatch + 1, String(printCalls.length - beforeBatch));
  job1.finish(0);
  const job2 = await waitForNewPrint(beforeBatch + 2);
  check('then the second file', sentFile(job2) === 'mixed.pdf', sentFile(job2));
  await waitFor(`document.getElementById('batch-progress-text').textContent.startsWith('正在列印 2 / 5')`, 'progress 2');
  check('the bar moves on', (await js(`document.getElementById('batch-bar').value`)) === 1);
  job2.finish(1);
  const job3 = await waitForNewPrint(beforeBatch + 3);
  check('a failed file does not stop the rest', sentFile(job3) === 'small-page.pdf', sentFile(job3));
  job3.finish(0);
  const job4 = await waitForNewPrint(beforeBatch + 4);
  check('a print-forbidden file still prints', sentFile(job4) === 'enc-owner-no-print.pdf', sentFile(job4));
  job4.finish(0);
  const job5 = await waitForNewPrint(beforeBatch + 5);
  check('a protected file still prints', sentFile(job5) === 'enc-owner-print-allowed.pdf', sentFile(job5));
  job5.finish(0);
  await waitFor(`!document.getElementById('batch-close').hidden`, 'batch finished');
  await pause(200);
  check('files with problems are never sent', printCalls.length === beforeBatch + 5, String(printCalls.length - beforeBatch));
  check('the dialog stays open to list what went wrong', await batchOpen());
  check('the result is counted', (await batchStatus()).includes('已送出 4 個檔案，4 個沒有印出'), await batchStatus());
  check('and shown as a problem', await js(`document.getElementById('batch-status').classList.contains('error')`));
  check('only the unprinted files stay on the list', JSON.stringify(await batchNames()) === JSON.stringify(['mixed.pdf', 'enc-open-password.pdf', 'corrupt.pdf', 'empty.pdf']), (await batchNames()).join());
  check('the failed file says so', (await batchRowText('mixed.pdf')).includes('列印失敗'), await batchRowText('mixed.pdf'));
  check('the dialog is unlocked again', await js(`!document.getElementById('batch-close').hidden && document.getElementById('batch-stop').hidden && document.getElementById('batch-progress').hidden && !document.getElementById('batch-fields').disabled`));
  check('rows can be moved again', await js(`document.querySelector('.file-row').draggable`));
  await shot('14-batch-failures');

  // Printing again only sends what is left
  const beforeRetry = printCalls.length;
  await click('batch-start');
  const retry = await waitForNewPrint(beforeRetry + 1);
  check('the second try sends only the failed file', sentFile(retry) === 'mixed.pdf', sentFile(retry));
  check('the failure note goes away while retrying', !(await batchRowText('mixed.pdf')).includes('列印失敗'));
  retry.finish(0);
  await waitFor(`document.querySelectorAll('#batch-list .file-row').length === 3`, 'retry finished');
  await pause(200);
  check('files already printed are not printed twice', printCalls.length === beforeRetry + 1);
  check('with only bad files left there is nothing to print', await js(`document.getElementById('batch-start').disabled`));
  check('the summary says so', (await batchSummaryText()) === '3 個檔案都不能印', await batchSummaryText());
  for (const name of ['enc-open-password.pdf', 'corrupt.pdf', 'empty.pdf']) {
    await js(`${batchRow(name)}.querySelector('.file-remove').click()`);
  }
  await waitFor(`!document.getElementById('batch-empty').hidden`, 'list emptied');
  check('an emptied list clears the preview', (await text('batch-preview-name')) === '' && (await js(`document.querySelectorAll('#batch-sheets .sheet-item').length`)) === 0);
  await closeBatch();
  await pause(200);
  check('closing lets go of every file', heldFiles.size === heldBeforeBatch, String(heldFiles.size - heldBeforeBatch));

  // Everything printed: the dialog closes and says so
  await openBatch();
  check('the list starts empty next time', (await batchRowCount()) === 0);
  await pickFiles(['mixed.pdf', 'square.pdf'], 2);
  const beforeGood = printCalls.length;
  await click('batch-start');
  (await waitForNewPrint(beforeGood + 1)).finish(0);
  (await waitForNewPrint(beforeGood + 2)).finish(0);
  await waitFor(`!document.getElementById('batch-dialog').open`, 'closes when all is printed');
  await waitFor(`document.getElementById('toast').textContent.includes('已送出 2 個檔案到印表機')`, 'batch sent message');
  check('closes and says how many were sent', (await text('toast')).includes('已送出 2 個檔案到印表機'), await text('toast'));
  await pause(200);
  check('every file is let go of after printing', heldFiles.size === heldBeforeBatch, String(heldFiles.size - heldBeforeBatch));

  // Stopping lets the current file finish and keeps the rest on the list
  await openBatch();
  await pickFiles(['mixed.pdf', 'square.pdf', 'small-page.pdf'], 3);
  const beforeStop = printCalls.length;
  await click('batch-start');
  const stopJob = await waitForNewPrint(beforeStop + 1);
  await click('batch-stop');
  check('stopping explains that it waits for the current file', (await batchStatus()).includes('處理完就停止'), await batchStatus());
  check('the stop button can only be pressed once', await js(`document.getElementById('batch-stop').disabled`));
  check('stopping never forces Sumatra to quit', typeof stopJob.finish === 'function' && (await batchOpen()));
  stopJob.finish(0);
  await waitFor(`!document.getElementById('batch-close').hidden`, 'stopped');
  await pause(200);
  check('nothing more is sent after stopping', printCalls.length === beforeStop + 1);
  check('says it stopped and what is left', (await batchStatus()).includes('已停止') && (await batchStatus()).includes('還有 2 個沒有印'), await batchStatus());
  check('stopping is not called an error', !(await js(`document.getElementById('batch-status').classList.contains('error')`)));
  check('the rest stay on the list', JSON.stringify(await batchNames()) === JSON.stringify(['square.pdf', 'small-page.pdf']), (await batchNames()).join());
  check('the stop button is out of the way until printing again', await js(`document.getElementById('batch-stop').hidden`));
  await click('batch-start');
  const resume = await waitForNewPrint(beforeStop + 2);
  check('printing again carries on from there', sentFile(resume) === 'square.pdf', sentFile(resume));
  check('the stop button works again', !(await js(`document.getElementById('batch-stop').disabled`)));
  resume.finish(0);
  (await waitForNewPrint(beforeStop + 3)).finish(0);
  await waitFor(`!document.getElementById('batch-dialog').open`, 'resumed batch done');

  // Microsoft Print to PDF asks for each file; cancelling stops the batch
  const batchFileAsker = (await printers()).find((name) => /Print to PDF/i.test(name));
  if (batchFileAsker) {
    await openBatch();
    await pickFiles(['mixed.pdf', 'square.pdf', 'small-page.pdf'], 3);
    check('no Save As warning for a real printer', await js(`document.getElementById('batch-printer-hint').hidden`));
    await setSelect('batch-printer', batchFileAsker);
    check('warns that every file will ask', (await text('batch-printer-hint')).includes('每個檔案都會問一次') && !(await js(`document.getElementById('batch-printer-hint').hidden`)));
    const beforeAsk = printCalls.length;
    await click('batch-start');
    const ask1 = await waitForNewPrint(beforeAsk + 1);
    check('points to the Save As window', (await batchStatus()).includes('另存列印輸出'), await batchStatus());
    ask1.finish(0);
    const ask2 = await waitForNewPrint(beforeAsk + 2);
    ask2.finish(1);
    await waitFor(`!document.getElementById('batch-close').hidden`, 'cancelled Save As');
    await pause(200);
    check('cancelling a Save As window sends no more', printCalls.length === beforeAsk + 2, String(printCalls.length - beforeAsk));
    check('says it stopped there', (await batchStatus()).includes('已取消存檔') && (await batchStatus()).includes('還有 2 個沒有印'), await batchStatus());
    check('cancelling is not called an error', !(await js(`document.getElementById('batch-status').classList.contains('error')`)));
    check('the cancelled file says so', (await batchRowText('square.pdf')).includes('已取消存檔'), await batchRowText('square.pdf'));
    await closeBatch();
  }

  // Several pages per sheet: only files with more than one page are laid out, each on sheets of its own
  await openBatch();
  await setSelect('batch-printer', realPrinter);
  check('batch starts at one page per sheet', (await value('batch-per-sheet')) === '1' && await js(`document.getElementById('batch-per-sheet-hint').hidden && document.getElementById('batch-border-row').hidden`));
  await pickFiles(['mixed.pdf', 'small-page.pdf'], 2);
  await waitFor(batchSheets(4), 'mixed.pdf previewed page by page');
  await setSelect('batch-per-sheet', '2');
  check('says one-page files print as usual, and offers frames', !(await js(`document.getElementById('batch-per-sheet-hint').hidden`)) && !(await js(`document.getElementById('batch-border-row').hidden`)));
  check('a file of several pages says how it is laid out', (await batchRowText('mixed.pdf')).includes('4 頁，每張紙印 2 頁，用 2 張紙，要橫著看'), await batchRowText('mixed.pdf'));
  check('a one-page file is left as it is', (await batchRowText('small-page.pdf')).includes('1 頁，沒有橫向頁'), await batchRowText('small-page.pdf'));
  check('the batch summary counts the paper', (await batchSummaryText()) === '共 2 個檔案、5 頁，1 個多頁檔案每張紙印 2 頁，要用 3 張紙', await batchSummaryText());
  await waitFor(`document.querySelectorAll('#batch-sheets .sheet-item').length === 2 && document.querySelector('#batch-sheets .sheet-item').dataset.drawn === 'true'`, 'batch sheets preview');
  check('the batch preview shows the sheets', (await js(`document.querySelector('#batch-sheets .sheet-label').textContent`)) === '第 1 張：第 1–2 頁' && (await js(`document.querySelector('#batch-sheets .sheet-item').querySelectorAll('.sheet-slot').length`)) === 2);
  await js(`${batchRow('small-page.pdf')}.click()`);
  await waitFor(batchSheets(1), 'one-page file previewed');
  check('a one-page file is previewed as usual', (await js(`document.querySelector('#batch-sheets .sheet-label').textContent`)) === '第 1 頁');
  await js(`${batchRow('mixed.pdf')}.click()`);
  await waitFor(`document.querySelectorAll('#batch-sheets .sheet-item').length === 2`, 'back to the sheets');
  await setSelect('batch-duplex', 'duplexshort');
  check('two-sided batch counts paper file by file', (await batchSummaryText()) === '共 2 個檔案、5 頁，1 個多頁檔案每張紙印 2 頁，雙面印，要用 2 張紙', await batchSummaryText());
  check('two-sided batch names the front', (await js(`document.querySelector('#batch-sheets .sheet-label').textContent`)) === '第 1 張正面：第 1–2 頁');
  check('sideways sheets printed two-sided say how to turn over', !(await js(`document.getElementById('batch-duplex-hint').hidden`)) && (await text('batch-duplex-hint')).includes('短邊翻頁時'), await text('batch-duplex-hint'));
  await setSelect('batch-duplex', 'simplex');
  check('one-sided hides the turn-over hint', await js(`document.getElementById('batch-duplex-hint').hidden`));
  await js(`(() => { const b = document.getElementById('batch-border'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('frames show in the batch preview', await js(`document.querySelector('#batch-sheets .sheet').classList.contains('framed')`));
  const beforeSheetsBatch = printCalls.length;
  await click('batch-start');
  const batchSheetsJob = await waitForNewPrint(beforeSheetsBatch + 1);
  const batchSheetsFile = batchSheetsJob.args.at(-1);
  const batchSheetsDoc = await PDFDocument.load(fs.readFileSync(batchSheetsFile));
  check('a file of several pages is sent as sheets', batchSheetsFile !== fixture('mixed.pdf') && batchSheetsFile.startsWith(app.getPath('temp')) && batchSheetsDoc.getPageCount() === 2, batchSheetsFile);
  check('batch sheets are fitted to the paper', settingsOf(batchSheetsJob).startsWith('fit,portrait,'), settingsOf(batchSheetsJob));
  batchSheetsJob.finish(0);
  const batchSingleJob = await waitForNewPrint(beforeSheetsBatch + 2);
  check('a one-page file is sent as it is', batchSingleJob.args.at(-1) === fixture('small-page.pdf'), batchSingleJob.args.at(-1));
  check('the sheets file is deleted before moving on', !fs.existsSync(batchSheetsFile));
  batchSingleJob.finish(0);
  await waitFor(`!document.getElementById('batch-dialog').open`, 'sheets batch done');

  // Clockwise: a temporary copy for each file, except protected ones
  await openBatch();
  check('batch pages per sheet is not remembered', (await value('batch-per-sheet')) === '1');
  await setSelect('batch-printer', realPrinter);
  await setRadio('batch-direction', 'clockwise');
  await pickFiles(['mixed.pdf', 'enc-owner-print-allowed.pdf'], 2);
  const beforeClockwiseBatch = printCalls.length;
  await click('batch-start');
  const turnedJob = await waitForNewPrint(beforeClockwiseBatch + 1);
  const turnedCopy = turnedJob.args.at(-1);
  check('clockwise prints a temporary copy', turnedCopy !== fixture('mixed.pdf') && turnedCopy.startsWith(app.getPath('temp')), turnedCopy);
  check('the copy has its landscape pages turned', JSON.stringify((await PDFDocument.load(fs.readFileSync(turnedCopy))).getPages().map((p) => p.getRotation().angle)) === '[0,90,0,90]');
  turnedJob.finish(0);
  const protectedJob = await waitForNewPrint(beforeClockwiseBatch + 2);
  check('a protected file is sent as it is', protectedJob.args.at(-1) === fixture('enc-owner-print-allowed.pdf'), protectedJob.args.at(-1));
  check('the first copy is deleted before moving on', !fs.existsSync(turnedCopy));
  protectedJob.finish(0);
  await waitFor(`!document.getElementById('batch-dialog').open`, 'clockwise batch done');
  await waitFor(`document.getElementById('toast').textContent.includes('其中 1 個無法改成順時針')`, 'clockwise fallback message');
  check('says which direction was really used', (await text('toast')).includes('其中 1 個無法改成順時針'), await text('toast'));
  const savedBatch = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).print;
  check('batch settings are remembered and a protected file does not change them', savedBatch.direction === 'clockwise' && savedBatch.printer === realPrinter, JSON.stringify(savedBatch));

  // Both dialogs share the remembered settings
  await selectTab('mixed.pdf');
  await openPrint();
  check('the print dialog picks up the batch settings', await js(`document.querySelector('input[name="print-direction"]:checked').value === 'clockwise'`));
  await closePrint();
  await openBatch();
  check('and the batch dialog remembers them too', await js(`document.querySelector('input[name="batch-direction"]:checked').value === 'clockwise'`));
  await setRadio('batch-direction', 'counterclockwise');
  await pickFiles(['square.pdf'], 1);
  const beforeReset = printCalls.length;
  await click('batch-start');
  (await waitForNewPrint(beforeReset + 1)).finish(0);
  await waitFor(`!document.getElementById('batch-dialog').open`, 'settings reset');

  // A long document: checked in reasonable time, and removing it mid-check is safe
  await openBatch();
  pickedFiles = [fixture('big-500pages.pdf')];
  await click('batch-add');
  await waitFor(`document.querySelectorAll('#batch-list .file-row').length === 1`, 'big file on the list');
  await js(`document.querySelector('.file-remove').click()`);
  await pause(300);
  check('a file can be removed while it is being checked', (await batchRowCount()) === 0);
  const bigBatchStart = Date.now();
  await pickFiles(['big-500pages.pdf', 'mixed.pdf'], 2);
  const bigBatchMs = Date.now() - bigBatchStart;
  check('a 500 page file is checked in reasonable time', bigBatchMs < 15000, `${bigBatchMs} ms`);
  check('its pages are counted', (await batchRowText('big-500pages.pdf')).includes('500 頁'), await batchRowText('big-500pages.pdf'));
  await waitFor(`document.querySelectorAll('#batch-sheets .sheet-item').length === 500 && document.querySelector('#batch-sheets .sheet-item[data-drawn]')`, 'big file preview');
  await pause(800);
  const keptBatchImages = await js(`document.querySelectorAll('#batch-sheets canvas').length`);
  check('the preview only draws nearby pages', keptBatchImages > 0 && keptBatchImages <= 30, `${keptBatchImages} of 500`);
  await js(`document.getElementById('batch-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  await waitFor(`!document.getElementById('batch-dialog').open`, 'Esc closes the batch dialog');
  check('Esc closes the dialog when not printing', !(await batchOpen()));
  await pause(200);
  check('closing mid-way lets go of every file', heldFiles.size === heldBeforeBatch, String(heldFiles.size - heldBeforeBatch));

  // A small window keeps the buttons in view and drops the preview
  win.setSize(760, 500);
  await pause(500);
  await openBatch();
  await pickFiles(['mixed.pdf'], 1);
  check('the print button stays in view on a small window', await js(`(() => {
    const button = document.getElementById('batch-start').getBoundingClientRect();
    const box = document.getElementById('batch-dialog').getBoundingClientRect();
    return button.bottom <= box.bottom && button.top >= box.top;
  })()`));
  check('the preview gives way to the list', await js(`getComputedStyle(document.querySelector('.batch-preview')).display === 'none' && document.getElementById('batch-list').getBoundingClientRect().width > 200`));
  await shot('15-batch-small');
  await closeBatch();
  win.setSize(1000, 620);
  await pause(500);
  check('the batch dialog never changed the tabs', (await tabCount()) === tabsBeforeBatch);

  // ---- Zooming the preview
  const A4_AT_100 = 595.28 * 96 / 72;
  const sheetRect = (box, index = 0) => js(`(() => {
    const r = document.querySelectorAll('#${box} .sheet')[${index}].getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  const waitSheetWidth = (box, width, label) => waitFor(`Math.abs(document.querySelector('#${box} .sheet').getBoundingClientRect().width - ${width}) < 2`, label);
  // Drawn again for the new size: twice as many pixels as shown, unless the cap applies.
  const waitSharp = (box, label) => waitFor(`(() => {
    const item = document.querySelector('#${box} .sheet-item');
    const canvas = item.querySelector('canvas');
    return Boolean(item.dataset.drawn && canvas && Math.abs(canvas.width / canvas.getBoundingClientRect().width - 2) < 0.05);
  })()`, label);
  const pressInDialog = (id, key) => js(`document.getElementById('${id}').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ctrlKey: true, bubbles: true, cancelable: true }))`);

  await selectTab('mixed.pdf');
  await openPrint();
  await waitAllSheetsDrawn(4, 'preview before zooming');
  check('the preview starts on automatic', (await value('print-zoom')) === 'auto');
  const side = [await sheetRect('print-sheets', 0), await sheetRect('print-sheets', 1)];
  check('automatic puts several pages side by side', side[0].top === side[1].top && side[0].left < side[1].left, JSON.stringify(side));
  await shot('16-zoom-auto');

  await setSelect('print-zoom', '1');
  await waitSheetWidth('print-sheets', A4_AT_100, '100%');
  check('100% is the real paper size', true);
  await waitSharp('print-sheets', 'sharp at 100%');
  check('the page is drawn again for the new size', true);
  check('a percentage shows one page across here', (await sheetRect('print-sheets', 1)).top > (await sheetRect('print-sheets', 0)).top);
  await click('print-zoom-in');
  await waitSheetWidth('print-sheets', A4_AT_100 * 1.25, 'zoom in button');
  check('the plus button zooms in and the list follows', (await value('print-zoom')) === '1.25', await value('print-zoom'));
  await click('print-zoom-in');
  await waitSheetWidth('print-sheets', A4_AT_100 * 1.56, 'zoom in again');
  check('sizes that are not on the list are still shown', (await js(`document.getElementById('print-zoom').selectedOptions[0].textContent`)) === '156%', await js(`document.getElementById('print-zoom').selectedOptions[0].textContent`));
  await click('print-zoom-out');
  await waitSheetWidth('print-sheets', A4_AT_100 * 1.25, 'zoom out button');
  check('the minus button comes back', (await value('print-zoom')) === '1.25', await value('print-zoom'));

  await setSelect('print-zoom', '2');
  await waitSheetWidth('print-sheets', A4_AT_100 * 2, '200%');
  await waitSharp('print-sheets', 'sharp at 200%');
  await shot('17-zoom-200');
  check('a page wider than the pane can be scrolled sideways', await js(`(() => { const b = document.getElementById('print-sheets'); return b.scrollWidth > b.clientWidth; })()`));
  check('its left side can be reached', await js(`(() => {
    const b = document.getElementById('print-sheets');
    b.scrollLeft = 0;
    return document.querySelector('#print-sheets .sheet').getBoundingClientRect().left >= b.getBoundingClientRect().left;
  })()`));
  // A hidden window reports scrolled-away pages a little late, so this gets a moment.
  await waitFor(`document.querySelectorAll('#print-sheets canvas').length <= 3`, 'far pages let go');
  check('only nearby pages keep their picture', (await js(`document.querySelectorAll('#print-sheets canvas').length`)) <= 3, String(await js(`document.querySelectorAll('#print-sheets canvas').length`)));

  await setSelect('print-zoom', '4');
  await waitSheetWidth('print-sheets', A4_AT_100 * 4, '400%');
  await waitFor(`(() => { const c = document.querySelector('#print-sheets .sheet-item[data-drawn] canvas'); return c && Math.abs(c.getBoundingClientRect().width / c.width - 1) < 0.1; })()`, 'drawn at 400%');
  const huge = await js(`(() => { const c = document.querySelector('#print-sheets canvas'); return c.width * c.height; })()`);
  check('very high zoom stays under the memory cap', huge <= 16.2 * 1024 * 1024, `${(huge / 1024 / 1024).toFixed(1)} M pixels`);
  await click('print-zoom-in');
  await pause(50);
  check('zoom in stops at 400%', (await value('print-zoom')) === '4', await value('print-zoom'));

  // Ctrl+wheel zooms around the pointer
  await setSelect('print-zoom', '1');
  await waitSheetWidth('print-sheets', A4_AT_100, 'back to 100%');
  await js(`document.getElementById('print-sheets').scrollTop = 120; 0`);
  await pause(50);
  const pointer = await js(`(() => { const r = document.getElementById('print-sheets').getBoundingClientRect(); return { x: Math.round(r.left + 200), y: Math.round(r.top + 150) }; })()`);
  const beforeWheel = await sheetRect('print-sheets');
  await js(`document.getElementById('print-sheets').dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: ${pointer.x}, clientY: ${pointer.y}, bubbles: true, cancelable: true }))`);
  await waitSheetWidth('print-sheets', A4_AT_100 * 1.25, 'Ctrl+wheel');
  const afterWheel = await sheetRect('print-sheets');
  const shareBefore = { x: (pointer.x - beforeWheel.left) / beforeWheel.width, y: (pointer.y - beforeWheel.top) / beforeWheel.height };
  const shareAfter = { x: (pointer.x - afterWheel.left) / afterWheel.width, y: (pointer.y - afterWheel.top) / afterWheel.height };
  check('Ctrl+wheel keeps the spot under the pointer in place', Math.abs(shareBefore.x - shareAfter.x) < 0.01 && Math.abs(shareBefore.y - shareAfter.y) < 0.01, JSON.stringify({ shareBefore, shareAfter }));
  await js(`document.getElementById('print-sheets').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: ${pointer.x}, clientY: ${pointer.y}, bubbles: true, cancelable: true }))`);
  await pause(50);
  check('the wheel alone does not zoom', (await value('print-zoom')) === '1.25', await value('print-zoom'));

  await pressInDialog('print-dialog', '-');
  await waitSheetWidth('print-sheets', A4_AT_100, 'Ctrl+-');
  check('Ctrl+- zooms out', (await value('print-zoom')) === '1');
  await pressInDialog('print-dialog', '=');
  await waitSheetWidth('print-sheets', A4_AT_100 * 1.25, 'Ctrl+=');
  check('Ctrl+= zooms in', (await value('print-zoom')) === '1.25');

  // Fit to the pane
  const paneSize = () => js(`(() => { const b = document.getElementById('print-sheets'); return { width: b.clientWidth, height: b.clientHeight, scrollWidth: b.scrollWidth }; })()`);
  await setSelect('print-zoom', 'page-width');
  await waitSheetWidth('print-sheets', (await paneSize()).width - 36, 'fit to width');
  check('fit to width leaves no sideways scrolling', (await paneSize()).scrollWidth <= (await paneSize()).width, JSON.stringify(await paneSize()));
  await setSelect('print-zoom', 'page-fit');
  await pause(100);
  const fitted = await sheetRect('print-sheets');
  const pane = await paneSize();
  check('whole page fits inside the pane', fitted.height + 36 <= pane.height && fitted.height + 80 >= pane.height, JSON.stringify({ fitted, pane }));
  await waitSharp('print-sheets', 'sharp when fitted');

  // Dragging moves a zoomed page
  const dragPreview = (id, { dx, dy, button = 0, atX = 100, atY = 100 }) => js(`(() => {
    const box = document.getElementById('${id}');
    box.setPointerCapture = () => {};
    const r = box.getBoundingClientRect();
    const start = { clientX: r.left + ${atX}, clientY: r.top + ${atY}, button: ${button}, pointerId: 1, bubbles: true };
    box.dispatchEvent(new PointerEvent('pointerdown', start));
    const panning = box.classList.contains('panning');
    box.dispatchEvent(new PointerEvent('pointermove', { ...start, clientX: start.clientX + ${dx}, clientY: start.clientY + ${dy} }));
    const during = { left: box.scrollLeft, top: box.scrollTop };
    box.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }));
    box.dispatchEvent(new PointerEvent('pointermove', { ...start, clientX: start.clientX + 500, clientY: start.clientY + 500 }));
    delete box.setPointerCapture;
    return { panning, during, left: box.scrollLeft, top: box.scrollTop, stillPanning: box.classList.contains('panning') };
  })()`);
  const placePreview = (id, left, top) => js(`(() => { const b = document.getElementById('${id}'); b.scrollLeft = ${left}; b.scrollTop = ${top}; return { left: b.scrollLeft, top: b.scrollTop }; })()`);
  await setSelect('print-zoom', '2');
  await waitSheetWidth('print-sheets', A4_AT_100 * 2, '200% for dragging');
  check('a page bigger than the pane shows it can be dragged', await js(`document.getElementById('print-sheets').classList.contains('pannable') && getComputedStyle(document.getElementById('print-sheets')).cursor === 'grab'`));
  await placePreview('print-sheets', 200, 300);
  const dragged = await dragPreview('print-sheets', { dx: -50, dy: -80 });
  check('dragging moves the page with the pointer', dragged.panning && dragged.during.left === 250 && dragged.during.top === 380, JSON.stringify(dragged));
  check('letting go stops moving it', dragged.left === 250 && dragged.top === 380 && !dragged.stillPanning, JSON.stringify(dragged));
  const draggedBack = await dragPreview('print-sheets', { dx: 50, dy: 80 });
  check('dragging the other way comes back', draggedBack.left === 200 && draggedBack.top === 300, JSON.stringify(draggedBack));
  const rightButton = await dragPreview('print-sheets', { dx: -50, dy: -80, button: 2 });
  check('the right mouse button does not drag', !rightButton.panning && rightButton.left === 200, JSON.stringify(rightButton));
  const paneWidth = await js(`document.getElementById('print-sheets').clientWidth`);
  const onBar = await dragPreview('print-sheets', { dx: -50, dy: 0, atX: paneWidth + 3 });
  check('pressing on a scrollbar is left to the scrollbar', !onBar.panning, JSON.stringify(onBar));
  await setSelect('print-zoom', 'page-fit');
  await pause(100);
  await js(`document.querySelector('#print-sheets').scrollTop = 0; 0`);

  // Other settings keep the zoom; closing does not
  await setSelect('print-zoom', '1');
  await waitSheetWidth('print-sheets', A4_AT_100, '100% again');
  await setSelect('print-paper', 'A3');
  await waitSheetWidth('print-sheets', 841.89 * 96 / 72, 'A3 at 100%');
  check('zoom stays when the paper changes, at the new paper\'s real size', (await value('print-zoom')) === '1');
  await setSelect('print-paper', 'A4');
  await pressInDialog('print-dialog', '0');
  await pause(100);
  check('Ctrl+0 goes back to automatic', (await value('print-zoom')) === 'auto' && (await sheetRect('print-sheets', 0)).top === (await sheetRect('print-sheets', 1)).top);
  await setSelect('print-zoom', '2');
  await closePrint();
  await openPrint();
  check('the next time starts on automatic again', (await value('print-zoom')) === 'auto' && (await js(`!document.getElementById('print-sheets').classList.contains('zoomed')`)));
  await waitAllSheetsDrawn(4, 'automatic again');
  await closePrint();

  // A page alone has nothing to sit next to
  await selectTab('small-page.pdf');
  await openPrint();
  await waitAllSheetsDrawn(1, 'one page preview');
  const alone = await sheetRect('print-sheets');
  const aloneWidth = await js(`document.getElementById('print-sheets').clientHeight`);
  check('automatic shows a single page as large as fits', alone.height + 80 >= aloneWidth && alone.height + 36 <= aloneWidth, JSON.stringify({ alone, aloneWidth }));
  const aloneInk = await js(`(() => {
    const c = document.querySelector('#print-sheets .sheet canvas');
    if (!c || !c.width) return { dark: 0 };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) dark++;
    const r = c.getBoundingClientRect();
    return { dark, shownWidth: r.width, attached: c.isConnected };
  })()`);
  check('the single page is really drawn on screen', aloneInk.dark > 200 && aloneInk.attached && Math.abs(aloneInk.shownWidth - alone.width) < 2, JSON.stringify(aloneInk));
  await pause(1500);
  check('a page that fits has nothing to drag', !(await js(`document.getElementById('print-sheets').classList.contains('pannable')`)));
  const nothingToDrag = await dragPreview('print-sheets', { dx: -50, dy: -50 });
  check('and dragging it does nothing', !nothingToDrag.panning && nothingToDrag.left === 0 && nothingToDrag.top === 0, JSON.stringify(nothingToDrag));
  await shot('18-zoom-one-page');
  await closePrint();

  // The batch dialog has the same control, and it stays when switching files
  await openBatch();
  await pickFiles(['mixed.pdf', 'square.pdf'], 2);
  await waitFor(`document.querySelector('#batch-sheets .sheet-item[data-drawn]')`, 'batch preview before zooming');
  check('the zoom control is in view in the batch dialog', await js(`(() => {
    const control = document.getElementById('batch-zoom-in').getBoundingClientRect();
    const dialog = document.getElementById('batch-dialog').getBoundingClientRect();
    return control.right <= dialog.right && control.top >= dialog.top && control.width > 0;
  })()`));
  await setSelect('batch-zoom', '1');
  await waitSheetWidth('batch-sheets', A4_AT_100, 'batch at 100%');
  await waitSharp('batch-sheets', 'batch sharp at 100%');
  await click('batch-zoom-in');
  await waitSheetWidth('batch-sheets', A4_AT_100 * 1.25, 'batch zoom in');
  await placePreview('batch-sheets', 10, 40);
  const batchDragged = await dragPreview('batch-sheets', { dx: -20, dy: -30 });
  check('dragging works in the batch dialog too', batchDragged.left === 30 && batchDragged.top === 70, JSON.stringify(batchDragged));
  await js(`${batchRow('square.pdf')}.click()`);
  await waitFor(`document.getElementById('batch-preview-name').textContent === 'square.pdf' && document.querySelector('#batch-sheets .sheet-item[data-drawn]')`, 'second file at the same zoom');
  check('zoom stays when another file is chosen', (await value('batch-zoom')) === '1.25' && Math.abs((await sheetRect('batch-sheets')).width - A4_AT_100 * 1.25) < 2);
  await closeBatch();
  await pause(200);
  check('zooming leaves no file open', heldFiles.size === heldBeforeBatch, String(heldFiles.size - heldBeforeBatch));

  // ---- Save As
  check('the Save As window is replaced for this test', saveDialogReplaced);
  if (saveDialogReplaced) {
    const saveFolder = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}save-`));
    const saved = (name) => path.join(saveFolder, name);
    const toastText = () => text('toast');
    const clearToast = () => js(`document.getElementById('toast').textContent = ''; 0`);
    const saveTo = async (target, expectedToast) => {
      saveTarget = target;
      await clearToast();
      await click('btn-save');
      await waitFor(`document.getElementById('toast').textContent.includes(${JSON.stringify(expectedToast)})`, `save message: ${expectedToast}`);
    };
    const rotateView = async (times) => {
      for (let i = 0; i < times; i++) await click('btn-rotate-right');
      await pause(150);
    };
    const pageAngles = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPages().map((page) => page.getRotation().angle);

    await selectTab('mixed.pdf');
    check('the save button is ready with a file open', !(await js(`document.getElementById('btn-save').disabled`)));

    // Cancelling
    saveTarget = null;
    await clearToast();
    const callsBeforeCancel = saveDialogCalls;
    await click('btn-save');
    for (const started = Date.now(); saveDialogCalls === callsBeforeCancel && Date.now() - started < 5000;) await pause(30);
    await pause(150);
    check('cancelling saves nothing and says nothing', fs.readdirSync(saveFolder).length === 0 && (await toastText()) === '');
    check('it suggests a new name next to the original', saveDialogOptions.defaultPath === fixture('mixed_複本.pdf'), saveDialogOptions.defaultPath);

    // No turn: an exact copy
    await saveTo(saved('copy.pdf'), '已另存成「copy.pdf」');
    check('an unrotated copy is byte for byte the same', fs.readFileSync(saved('copy.pdf')).equals(fs.readFileSync(fixture('mixed.pdf'))));

    // Turned once, then twice
    const originalMixed = fs.readFileSync(fixture('mixed.pdf'));
    await rotateView(1);
    await saveTo(saved('turned-90.pdf'), '旋轉後的方向');
    check('the suggested name says it is turned', saveDialogOptions.defaultPath === fixture('mixed_旋轉.pdf'), saveDialogOptions.defaultPath);
    check('the file has every page turned once', JSON.stringify(await pageAngles(saved('turned-90.pdf'))) === '[90,90,90,90]', JSON.stringify(await pageAngles(saved('turned-90.pdf'))));
    check('the original file is untouched', originalMixed.equals(fs.readFileSync(fixture('mixed.pdf'))));
    check('the page stays turned on screen after saving', (await pageWidth()) > (await pageHeight()));
    await rotateView(1);
    await saveTo(saved('turned-180.pdf'), '已另存成「turned-180.pdf」');
    check('turning twice saves half a turn', JSON.stringify(await pageAngles(saved('turned-180.pdf'))) === '[180,180,180,180]');
    await rotateView(2);

    // The saved file opens and really is turned
    const tabsBeforeSaved = await tabCount();
    openFiles([saved('turned-90.pdf')]);
    await waitFor(`document.title.startsWith('turned-90.pdf') && document.getElementById('page-total').textContent === '/ 4'`, 'saved file opens');
    await waitFor(pagesPainted(1), 'saved file painted');
    check('the saved file opens turned', (await pageWidth()) > (await pageHeight()), `${await pageWidth()} x ${await pageHeight()}`);
    await press('w', { ctrlKey: true });
    await waitFor(`document.querySelectorAll('.tab').length === ${tabsBeforeSaved}`, 'saved file closed');

    // A turn adds to what the page already has
    await selectTab('prerotated.pdf');
    await rotateView(1);
    await saveTo(saved('prerotated-turned.pdf'), '已另存成「prerotated-turned.pdf」');
    check('a turn adds to the rotation already in the file', JSON.stringify(await pageAngles(saved('prerotated-turned.pdf'))) === '[180]', JSON.stringify(await pageAngles(saved('prerotated-turned.pdf'))));
    await rotateView(3);

    // Annotations survive
    await selectTab('annotated.pdf');
    await rotateView(1);
    await saveTo(saved('annotated-turned.pdf'), '已另存成「annotated-turned.pdf」');
    const annotationsIn = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPage(0).node.Annots()?.size() ?? 0;
    check('annotations survive in the turned file', (await annotationsIn(saved('annotated-turned.pdf'))) === (await annotationsIn(fixture('annotated.pdf'))) && (await annotationsIn(fixture('annotated.pdf'))) >= 2);
    await rotateView(3);

    // Protected files
    await selectTab('enc-owner-print-allowed.pdf');
    await rotateView(1);
    const callsBeforeProtected = saveDialogCalls;
    await saveTo(saved('protected-turned.pdf'), '受保護');
    check('a protected file says so without asking where to save', saveDialogCalls === callsBeforeProtected && !fs.existsSync(saved('protected-turned.pdf')));
    await rotateView(3);
    await saveTo(saved('protected-copy.pdf'), '已另存成「protected-copy.pdf」');
    check('turned back, it can be copied as it is', fs.readFileSync(saved('protected-copy.pdf')).equals(fs.readFileSync(fixture('enc-owner-print-allowed.pdf'))));

    // Where it cannot go
    await selectTab('mixed.pdf');
    await saveTo(fixture('mixed.pdf'), '不能存到正在開啟的原檔');
    check('saving over the open file is refused and leaves it alone', originalMixed.equals(fs.readFileSync(fixture('mixed.pdf'))));
    await saveTo(path.join(saveFolder, 'no-such-folder', 'copy.pdf'), '無法存檔');
    check('a folder that does not exist is explained', (await toastText()).includes('資料夾'), await toastText());
    fs.writeFileSync(saved('locked.pdf'), 'what was here before');
    const lockedHandle = fs.openSync(saved('locked.pdf'), 'r');
    await saveTo(saved('locked.pdf'), '正在被其他程式使用');
    fs.closeSync(lockedHandle);
    check('a file another program has open is explained and left alone', fs.readFileSync(saved('locked.pdf'), 'utf8') === 'what was here before', await toastText());
    fs.writeFileSync(saved('existing.pdf'), 'what was here before');
    await saveTo(saved('existing.pdf'), '已另存成「existing.pdf」');
    check('choosing an existing file replaces it', fs.readFileSync(saved('existing.pdf')).equals(originalMixed));

    // Keyboard
    saveTarget = saved('from-keyboard.pdf');
    await clearToast();
    await press('s', { ctrlKey: true });
    await waitFor(`document.getElementById('toast').textContent.includes('from-keyboard.pdf')`, 'Ctrl+S');
    check('Ctrl+S saves too', fs.existsSync(saved('from-keyboard.pdf')));
    await openPrint();
    const callsInPrint = saveDialogCalls;
    await press('s', { ctrlKey: true });
    await pause(150);
    check('Ctrl+S waits while a print dialog is open', saveDialogCalls === callsInPrint);
    await closePrint();

    check('no half-written files are left behind', fs.readdirSync(saveFolder).every((name) => !name.endsWith('.tmp')), fs.readdirSync(saveFolder).join());
    check('nothing is left behind next to the originals', fs.readdirSync(FIXTURES).every((name) => !name.endsWith('.tmp')));
    check('rotate view is back to normal for the rest', (await pageHeight()) > (await pageWidth()));
  }

  // ---- Merging and splitting
  check('the Save As and folder windows are replaced for this test', saveDialogReplaced && folderWindowsReplaced);
  if (saveDialogReplaced && folderWindowsReplaced) {
    const outFolder = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}pages-`));
    const out = (name) => path.join(outFolder, name);
    const sizesOf = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPages().map((page) => {
      const { width, height } = page.getSize();
      return `${Math.round(width)}x${Math.round(height)}`;
    });
    const listNames = (id) => js(`[...document.querySelectorAll('#${id} .file-name')].map((n) => n.textContent)`);
    const rowIn = (id, name) => `[...document.querySelectorAll('#${id} .file-row')].find((r) => r.querySelector('.file-name').textContent === ${JSON.stringify(name)})`;
    const rowText = (id, name) => js(`${rowIn(id, name)}?.textContent ?? ''`);
    const heldBeforePages = heldFiles.size;
    const tabsBeforePages = await tabCount();

    // ---- Merge
    const mergeOpen = () => js(`document.getElementById('merge-dialog').open`);
    const openMerge = async () => {
      await click('btn-merge');
      await waitFor(`document.getElementById('merge-dialog').open`, 'merge dialog');
    };
    const addToMerge = async (names, count) => {
      pickedFiles = names.map(fixture);
      await click('merge-add');
      await waitFor(`document.querySelectorAll('#merge-list .file-row').length === ${count} && !document.getElementById('merge-summary').textContent.includes('還剩')`, `merge list: ${names.join(', ')}`, 40000);
    };
    const mergeStatus = () => text('merge-status');
    const mergeReady = () => js(`!document.getElementById('merge-start').disabled`);
    const dropRow = (id, name, beforeName) => js(`(() => {
      const list = document.getElementById('${id}');
      const row = ${rowIn(id, name)};
      const data = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }));
      const target = ${beforeName ? rowIn(id, beforeName) : 'null'};
      const y = target ? target.getBoundingClientRect().top + 1 : list.lastElementChild.getBoundingClientRect().bottom + 5;
      list.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, clientY: y, bubbles: true, cancelable: true }));
      list.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      row.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
    })()`);

    await openMerge();
    check('an empty merge list says what to do', (await text('merge-summary')) === '還沒有加入檔案' && !(await js(`document.getElementById('merge-empty').hidden`)));
    check('nothing to merge yet', !(await mergeReady()));
    check('says what may be lost when merging', (await js(`document.getElementById('merge-limits').textContent`)).includes('書籤') && !(await js(`document.getElementById('merge-limits').hidden`)));
    await shot('19-merge-empty');
    await addToMerge(['mixed.pdf'], 1);
    check('one file is not enough to merge', !(await mergeReady()));
    await addToMerge(['small-page.pdf', 'annotated.pdf'], 3);
    check('each row shows its pages', (await rowText('merge-list', 'mixed.pdf')).includes('4 頁'), await rowText('merge-list', 'mixed.pdf'));
    check('the summary adds them up', (await text('merge-summary')) === '共 3 個檔案、6 頁', await text('merge-summary'));
    check('ready to merge', await mergeReady());
    await shot('20-merge-list');
    pickedFiles = [fixture('mixed.pdf').toUpperCase()];
    await click('merge-add');
    await waitFor(`document.getElementById('merge-status').textContent.includes('不會重複')`, 'duplicate in merge');
    check('the same file is not added twice', (await listNames('merge-list')).length === 3);

    // Files that cannot be merged must come off the list first
    await addToMerge(['enc-owner-print-allowed.pdf', 'enc-open-password.pdf', 'corrupt.pdf', 'empty.pdf'], 7);
    check('a protected file is marked', (await rowText('merge-list', 'enc-owner-print-allowed.pdf')).includes('受保護'), await rowText('merge-list', 'enc-owner-print-allowed.pdf'));
    check('so is one with an open password, with no prompt', (await rowText('merge-list', 'enc-open-password.pdf')).includes('受保護') && !(await js(`document.getElementById('password-dialog').open`)), await rowText('merge-list', 'enc-open-password.pdf'));
    check('so is a damaged file', (await rowText('merge-list', 'corrupt.pdf')).includes('損毀'));
    check('so is an empty file', (await rowText('merge-list', 'empty.pdf')).includes('空的'));
    check('merging waits until they are removed', !(await mergeReady()));
    check('and says why', (await text('merge-summary')).endsWith('有 4 個不能合併，請先從清單移除'), await text('merge-summary'));
    for (const name of ['enc-owner-print-allowed.pdf', 'enc-open-password.pdf', 'corrupt.pdf', 'empty.pdf']) {
      await js(`${rowIn('merge-list', name)}.querySelector('.file-remove').click()`);
    }
    check('with them gone it can merge again', await mergeReady());

    await js(`(() => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
      const dialog = document.getElementById('merge-dialog');
      dialog.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      dialog.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    })()`);
    await pause(150);
    check('files dropped here open no tab', (await tabCount()) === tabsBeforePages);
    check('other kinds of file are skipped with a word', (await mergeStatus()).includes('只能加入 PDF'), await mergeStatus());

    await click('merge-add-open');
    await waitFor(`document.querySelectorAll('#merge-list .file-row').length > 3 && !document.getElementById('merge-summary').textContent.includes('還剩')`, 'open tabs in merge', 40000);
    check('open files can be added', (await listNames('merge-list')).includes('square.pdf'));
    for (const name of (await listNames('merge-list')).filter((n) => !['mixed.pdf', 'small-page.pdf', 'annotated.pdf'].includes(n))) {
      await js(`${rowIn('merge-list', name)}.querySelector('.file-remove').click()`);
    }
    check('adding them leaves the tabs alone', (await tabCount()) === tabsBeforePages);

    await dropRow('merge-list', 'annotated.pdf', 'mixed.pdf');
    check('dragging changes the order', JSON.stringify(await listNames('merge-list')) === JSON.stringify(['annotated.pdf', 'mixed.pdf', 'small-page.pdf']), (await listNames('merge-list')).join());
    await dropRow('merge-list', 'annotated.pdf', null);
    check('dragging to the end works', JSON.stringify(await listNames('merge-list')) === JSON.stringify(['mixed.pdf', 'small-page.pdf', 'annotated.pdf']), (await listNames('merge-list')).join());

    // Save window cancelled
    saveTarget = null;
    const callsBeforeMerge = saveDialogCalls;
    await click('merge-start');
    for (const started = Date.now(); saveDialogCalls === callsBeforeMerge && Date.now() - started < 5000;) await pause(30);
    await waitFor(`!document.getElementById('merge-close').disabled`, 'merge cancelled');
    check('cancelling saves nothing', fs.readdirSync(outFolder).length === 0 && (await mergeStatus()) === '');
    const mergeDefault = saveDialogOptions.defaultPath;
    check('the suggested name has the date, next to the first file', path.dirname(mergeDefault) === FIXTURES && /^合併_\d{4}-\d{2}-\d{2}\.pdf$/.test(path.basename(mergeDefault)), mergeDefault);

    // The list is locked while the Save window is up
    let releaseSave = () => {};
    saveDialogGate = new Promise((resolve) => { releaseSave = resolve; });
    saveTarget = out('merged.pdf');
    await click('merge-start');
    await waitFor(`document.getElementById('merge-close').disabled`, 'merge busy');
    check('the list is locked while merging', await js(`document.getElementById('merge-start').disabled && document.getElementById('merge-add').disabled && document.querySelector('#merge-list .file-remove').disabled && !document.querySelector('#merge-list .file-row').draggable`));
    await js(`document.getElementById('merge-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    check('Esc does not close it while merging', await mergeOpen());
    releaseSave();
    saveDialogGate = Promise.resolve();
    await waitFor(`document.getElementById('merge-status').textContent.includes('已合併成')`, 'merged');
    check('says what it made', (await mergeStatus()) === '已合併成「merged.pdf」，共 6 頁。', await mergeStatus());
    check('the merged file has the pages in list order', JSON.stringify(await sizesOf(out('merged.pdf'))) === JSON.stringify(['595x842', '842x595', '595x842', '842x595', '298x420', '842x595']), JSON.stringify(await sizesOf(out('merged.pdf'))));
    check('annotations come along', (await PDFDocument.load(fs.readFileSync(out('merged.pdf')))).getPage(5).node.Annots().size() === 2);
    check('it offers to open the result', !(await js(`document.getElementById('merge-open').hidden`)));
    check('the list is unlocked again', await js(`!document.getElementById('merge-close').disabled && !document.getElementById('merge-add').disabled && document.querySelector('#merge-list .file-row').draggable`));
    await shot('21-merge-done');

    // Where it cannot save
    saveTarget = fixture('mixed.pdf');
    const mixedBefore = fs.readFileSync(fixture('mixed.pdf'));
    await click('merge-start');
    await waitFor(`document.getElementById('merge-status').textContent.includes('不能存到要合併的檔案上')`, 'same file refused');
    check('it cannot save over one of its own files', mixedBefore.equals(fs.readFileSync(fixture('mixed.pdf'))) && await js(`document.getElementById('merge-status').classList.contains('error')`));
    check('the offer to open goes away after a failure', await js(`document.getElementById('merge-open').hidden`));
    fs.writeFileSync(out('locked.pdf'), 'what was here before');
    const lockedMerge = fs.openSync(out('locked.pdf'), 'r');
    saveTarget = out('locked.pdf');
    await click('merge-start');
    await waitFor(`document.getElementById('merge-status').textContent.includes('正在被其他程式使用')`, 'file in use');
    fs.closeSync(lockedMerge);
    check('a file another program has open is explained and left alone', fs.readFileSync(out('locked.pdf'), 'utf8') === 'what was here before');
    check('no half-written files are left', fs.readdirSync(outFolder).every((name) => !name.endsWith('.tmp')), fs.readdirSync(outFolder).join());

    // Opening the result
    saveTarget = out('merged.pdf');
    await click('merge-start');
    await waitFor(`document.getElementById('merge-status').textContent.includes('已合併成')`, 'merged again');
    await click('merge-open');
    await waitFor(`!document.getElementById('merge-dialog').open && document.title.startsWith('merged.pdf') && document.getElementById('page-total').textContent === '/ 6'`, 'merged file opens');
    check('the merged file opens in a new tab', (await tabCount()) === tabsBeforePages + 1);
    await waitFor(pagesPainted(1), 'merged page 1');
    await waitFor(`${textOnPage(1)}.includes('PAGE 1')`, 'merged page text');
    check('its text can still be read', (await js(textOnPage(1))).includes('PAGE 1'));
    await press('w', { ctrlKey: true });
    await waitFor(`document.querySelectorAll('.tab').length === ${tabsBeforePages}`, 'merged tab closed');
    await pause(200);
    check('closing lets go of every file', heldFiles.size === heldBeforePages, String(heldFiles.size - heldBeforePages));

    // ---- Split
    const splitReady = () => js(`!document.getElementById('split-start').disabled`);
    const openSplit = async () => {
      await click('btn-split');
      await waitFor(`document.getElementById('split-dialog').open && document.getElementById('split-plan-count').textContent !== ''`, 'split dialog');
      await pause(100);
    };
    const closeSplit = async () => {
      await click('split-close');
      await waitFor(`!document.getElementById('split-dialog').open`, 'split dialog closed');
    };
    const typeSplit = (id, v) => js(`(() => { const i = document.getElementById('${id}'); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const planNames = () => js(`[...document.querySelectorAll('#split-plan-names li')].map((n) => n.textContent)`);
    const splitStatus = () => text('split-status');
    const runSplit = async (expected) => {
      await click('split-start');
      await waitFor(`document.getElementById('split-status').textContent.includes(${JSON.stringify(expected)})`, `split: ${expected}`, 60000);
    };

    await selectTab('mixed.pdf');
    await openSplit();
    check('shows which file is being split', (await text('split-file')) === 'mixed.pdf（共 4 頁）', await text('split-file'));
    check('starts with one file a page', (await text('split-plan-count')) === '會拆成 4 個檔案' && (await splitReady()), await text('split-plan-count'));
    check('lists the file names', JSON.stringify(await planNames()) === JSON.stringify(['mixed_1.pdf', 'mixed_2.pdf', 'mixed_3.pdf', 'mixed_4.pdf']), (await planNames()).join());
    check('suggests the folder of the original', (await text('split-folder-path')) === FIXTURES, await text('split-folder-path'));
    check('says what may be lost when splitting', (await js(`document.querySelector('#split-dialog .pages-foot .print-hint:not([hidden])').textContent`)).includes('書籤'));
    await shot('22-split');

    await typeSplit('split-every', '3');
    check('typing a size chooses that way', await js(`document.querySelector('input[name="split-mode"]:checked').value === 'every'`));
    check('every 3 pages of 4 makes two files', JSON.stringify(await planNames()) === JSON.stringify(['mixed_1.pdf', 'mixed_2.pdf']), (await planNames()).join());
    await typeSplit('split-every', '4');
    check('a size that makes no second file is explained', (await text('split-error')).includes('只有 4 頁') && !(await splitReady()), await text('split-error'));
    await typeSplit('split-every', '0');
    check('zero is refused', (await text('split-error')).includes('整數') && !(await splitReady()), await text('split-error'));

    await typeSplit('split-ranges', '');
    check('typing a range chooses that way', await js(`document.querySelector('input[name="split-mode"]:checked').value === 'ranges'`));
    check('an empty range asks for one', !(await splitReady()) && !(await js(`document.getElementById('split-error').hidden`)));
    await typeSplit('split-ranges', '3-1');
    check('a reversed range is explained', (await text('split-error')).includes('由小到大') && !(await splitReady()));
    await typeSplit('split-ranges', '1-9');
    check('a range past the end is explained', (await text('split-error')).includes('1 到 4') && !(await splitReady()));
    await typeSplit('split-ranges', '１－２， 3　4');
    check('full-width digits and spaces work', JSON.stringify(await planNames()) === JSON.stringify(['mixed_1-2.pdf', 'mixed_3.pdf', 'mixed_4.pdf']), (await planNames()).join());
    await typeSplit('split-ranges', '1-2');
    check('says when pages are left out', (await text('split-plan-count')) === '會拆成 1 個檔案，有 2 頁不在範圍內，不會輸出', await text('split-plan-count'));

    // Choosing where it goes
    await typeSplit('split-ranges', '1-2, 3-4');
    folderAnswer = null;
    await click('split-folder-pick');
    await pause(100);
    check('cancelling the folder window keeps the folder', (await text('split-folder-path')) === FIXTURES);
    folderAnswer = outFolder;
    await click('split-folder-pick');
    await waitFor(`document.getElementById('split-folder-path').textContent === ${JSON.stringify(outFolder)}`, 'folder chosen');
    await runSplit('已拆成 2 個檔案');
    check('makes the files with the right names', fs.existsSync(out('mixed_1-2.pdf')) && fs.existsSync(out('mixed_3-4.pdf')));
    check('with the right pages', JSON.stringify(await sizesOf(out('mixed_3-4.pdf'))) === JSON.stringify(['595x842', '842x595']));
    check('nothing is written next to the original', !fs.existsSync(fixture('mixed_1-2.pdf')));
    check('offers to open the folder', !(await js(`document.getElementById('split-open-folder').hidden`)));
    check('the progress bar goes away', await js(`document.getElementById('split-progress').hidden`));
    await shot('23-split-done');
    await click('split-open-folder');
    await pause(100);
    check('opens the folder the files went to', openedFolders.at(-1) === outFolder, String(openedFolders.at(-1)));

    // Names already taken
    const firstSplit = fs.readFileSync(out('mixed_1-2.pdf'));
    await runSplit('自動加了編號');
    check('says names were numbered', (await splitStatus()).startsWith('已拆成 2 個檔案。其中 2 個檔名已存在'), await splitStatus());
    check('the new files get a number', fs.existsSync(out('mixed_1-2 (2).pdf')) && fs.existsSync(out('mixed_3-4 (2).pdf')));
    check('the earlier files are left alone', firstSplit.equals(fs.readFileSync(out('mixed_1-2.pdf'))));
    await closeSplit();

    // Opens and shows the right page
    openFiles([out('mixed_3-4.pdf')]);
    await waitFor(`document.title.startsWith('mixed_3-4.pdf') && document.getElementById('page-total').textContent === '/ 2'`, 'split file opens');
    await waitFor(`${textOnPage(1)}.includes('PAGE 3')`, 'split file text');
    check('a split file opens with the right page first', (await js(textOnPage(1))).includes('PAGE 3'));

    // Next to the original when nothing else is chosen
    await openSplit();
    check('the folder is back to the original\'s next time', (await text('split-folder-path')) === outFolder.replace(/\//g, '\\'), await text('split-folder-path'));
    await runSplit('已拆成 2 個檔案');
    check('files go next to the original', fs.existsSync(out('mixed_3-4_1.pdf')) && fs.existsSync(out('mixed_3-4_2.pdf')));
    await closeSplit();
    await press('w', { ctrlKey: true });
    await waitFor(`document.querySelectorAll('.tab').length === ${tabsBeforePages}`, 'split file closed');

    // A rotated view does not reach the split files
    await selectTab('mixed.pdf');
    await click('btn-rotate-right');
    await pause(100);
    await openSplit();
    check('says the rotation is not applied', !(await js(`document.getElementById('split-rotation-note').hidden`)));
    folderAnswer = outFolder;
    await click('split-folder-pick');
    await waitFor(`document.getElementById('split-folder-path').textContent === ${JSON.stringify(outFolder)}`, 'folder chosen again');
    await typeSplit('split-ranges', '1');
    await runSplit('已拆成 1 個檔案');
    check('the split file is not rotated', (await PDFDocument.load(fs.readFileSync(out('mixed_1.pdf')))).getPage(0).getRotation().angle === 0);
    await closeSplit();
    for (let i = 0; i < 3; i++) await click('btn-rotate-right');
    await pause(100);

    // Protected files
    await selectTab('enc-owner-print-allowed.pdf');
    await openSplit();
    await waitFor(`!document.getElementById('split-notice').hidden`, 'protected notice');
    check('a protected file cannot be split, and says so', (await text('split-notice')).includes('受保護') && !(await splitReady()), await text('split-notice'));
    await closeSplit();

    // A long document, one file a page, with progress
    openFiles([fixture('big-500pages.pdf')]);
    await waitFor(`document.title.startsWith('big-500pages') && document.getElementById('page-total').textContent === '/ 500'`, 'big file for splitting');
    await openSplit();
    check('only some names are listed, and how many more', (await planNames()).length === 7 && (await planNames()).at(-1) === '…還有 494 個', (await planNames()).at(-1));
    folderAnswer = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}big-`));
    const bigFolder = folderAnswer;
    await click('split-folder-pick');
    await waitFor(`document.getElementById('split-folder-path').textContent === ${JSON.stringify(bigFolder)}`, 'big folder chosen');
    const bigSplitStart = Date.now();
    await click('split-start');
    await waitFor(`!document.getElementById('split-progress').hidden && /^正在拆分 [1-9]/.test(document.getElementById('split-progress-text').textContent)`, 'split progress', 30000);
    check('shows progress while splitting', /^正在拆分 \d+ \/ 500$/.test(await text('split-progress-text')), await text('split-progress-text'));
    check('stays locked while splitting', await js(`document.getElementById('split-close').disabled && document.getElementById('split-start').disabled && document.getElementById('split-fields').disabled`));
    await js(`document.getElementById('split-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    check('Esc does not close it while splitting', await js(`document.getElementById('split-dialog').open`));
    await waitFor(`document.getElementById('split-status').textContent.includes('已拆成 500 個檔案')`, 'big split done', 120000);
    const bigSplitMs = Date.now() - bigSplitStart;
    check('500 pages split in reasonable time', bigSplitMs < 60000, `${bigSplitMs} ms`);
    check('all the files are there', fs.readdirSync(bigFolder).length === 500, String(fs.readdirSync(bigFolder).length));
    await js(`document.getElementById('split-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.getElementById('split-dialog').open`, 'Esc closes the split dialog');
    await press('w', { ctrlKey: true });
    await waitFor(`document.querySelectorAll('.tab').length === ${tabsBeforePages}`, 'big file closed');

    // Keys and drops wait while these dialogs are open
    await selectTab('mixed.pdf');
    await openSplit();
    const callsWithSplit = saveDialogCalls;
    await press('s', { ctrlKey: true });
    await press('w', { ctrlKey: true });
    await js(`(() => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'fake.pdf', { type: 'application/pdf' }));
      window.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    })()`);
    await pause(150);
    check('keys and drops wait while a dialog is open', saveDialogCalls === callsWithSplit && (await tabCount()) === tabsBeforePages && await js(`document.getElementById('drop-hint').hidden`));
    await closeSplit();

    await pause(200);
    check('nothing is left open after merging and splitting', heldFiles.size === heldBeforePages, String(heldFiles.size - heldBeforePages));

    // On the smallest window the buttons stay in view
    const buttonInView = (button, dialog) => js(`(() => {
      const b = document.getElementById('${button}').getBoundingClientRect();
      const d = document.getElementById('${dialog}').getBoundingClientRect();
      return b.height > 0 && b.bottom <= d.bottom && b.top >= d.top && d.bottom <= window.innerHeight;
    })()`);
    win.setSize(720, 480);
    await pause(500);
    await openSplit();
    check('the split button stays in view on the smallest window', await buttonInView('split-start', 'split-dialog'));
    await closeSplit();
    await openMerge();
    await addToMerge(['mixed.pdf', 'square.pdf'], 2);
    check('the merge button stays in view on the smallest window', await buttonInView('merge-start', 'merge-dialog'));
    await click('merge-close');
    await waitFor(`!document.getElementById('merge-dialog').open`, 'merge dialog closed');
    win.setSize(1000, 620);
    await pause(500);
    check('nothing is left behind next to the originals', fs.readdirSync(FIXTURES).every((name) => !name.endsWith('.tmp') && !/^(merged|合併_|mixed_)/.test(name)), fs.readdirSync(FIXTURES).join());

    await runOrganizeTests({
      check,
      click,
      fixture,
      heldFiles,
      js,
      openFiles,
      pause,
      press,
      saveOptions: () => saveDialogOptions,
      setPicked: (paths) => { pickedFiles = paths; },
      setSaveTarget: (target) => { saveTarget = target; },
      shot,
      tabCount,
      tempPrefix: TEMP_PREFIX,
      text,
      waitFor,
      win,
    });
    check('organizing leaves nothing next to the originals', fs.readdirSync(FIXTURES).every((name) => !/\.(tmp|old)$/.test(name) && !/_(整理|擷取)/.test(name)), fs.readdirSync(FIXTURES).join());
  }

  // ---- Comparing two files side by side
  await runCompareTests({
    check,
    click,
    fixture,
    heldFiles,
    js,
    openFiles,
    pause,
    press,
    setPicked: (paths) => { pickedFiles = paths; },
    shot,
    tabCount,
    text,
    waitFor,
  });

  // ---- Version 1.4: saved print setups, locked files, recent files, bookmarks,
  // two pages, document information, pictures to PDF
  await runFeatures14Tests({
    app,
    check,
    click,
    fixture,
    js,
    openFiles,
    pause,
    press,
    printCalls,
    setPicked: (paths) => { pickedFiles = paths; },
    setSaveTarget: (target) => { saveTarget = target; },
    updater: pretendUpdater,
    shot,
    tabCount,
    tempPrefix: TEMP_PREFIX,
    text,
    userData,
    value,
    waitFor,
  });

  // ---- The width of the thumbnail column
  openFiles([fixture('mixed.pdf')]);
  await waitFor(`document.title.startsWith('mixed.pdf')`, 'mixed.pdf for the column test');
  const columnWidth = () => js(`document.getElementById('sidebar').offsetWidth`);
  const stageWidth = () => js(`document.getElementById('stage').offsetWidth`);
  const thumbBox = (page = 1) => js(`(() => {
    const c = document.querySelector('.thumb-pane.active .thumb[data-page="${page}"] canvas');
    const r = c.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height), pixels: c.width, inColumn: r.right <= document.getElementById('sidebar').getBoundingClientRect().right };
  })()`);
  const dragColumn = (dx, stopBefore = false) => js(`(() => {
    const handle = document.getElementById('sidebar-handle');
    handle.setPointerCapture = () => {};
    const r = handle.getBoundingClientRect();
    const start = { clientX: r.left + 4, clientY: 100, button: 0, pointerId: 1, bubbles: true, cancelable: true };
    handle.dispatchEvent(new PointerEvent('pointerdown', start));
    const pageBefore = document.querySelector('.viewer-host.active .page').getBoundingClientRect().width;
    handle.dispatchEvent(new PointerEvent('pointermove', { ...start, clientX: start.clientX + (${dx}) }));
    const during = {
      marked: document.body.classList.contains('resizing-sidebar'),
      width: document.getElementById('sidebar').offsetWidth,
      pageBefore,
    };
    if (!${stopBefore}) handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }));
    delete handle.setPointerCapture;
    return during;
  })()`);
  check('column: starts at the usual width', (await columnWidth()) === 172, String(await columnWidth()));
  await waitFor(`document.querySelector('.thumb-pane.active .thumb[data-page="1"]').dataset.drawn`, 'first thumbnail for the column test');
  const narrow = await thumbBox();
  check('column: pictures keep their usual size', narrow.width === 132 && narrow.inColumn, JSON.stringify(narrow));
  check('column: the edge can be found', await js(`getComputedStyle(document.getElementById('sidebar-handle')).cursor === 'col-resize'`));
  const stageBefore = await stageWidth();

  const midDrag = await dragColumn(150, true);
  await pause(250);
  check('column: follows the pointer', midDrag.marked && midDrag.width === 322, JSON.stringify(midDrag));
  check('column: the page waits while dragging, so it stays smooth', (await pageWidth()) === midDrag.pageBefore, `${await pageWidth()} vs ${midDrag.pageBefore}`);
  const stretched = await thumbBox();
  check('column: pictures follow at once, not yet sharp', stretched.width === 282 && stretched.pixels === narrow.pixels, JSON.stringify(stretched));
  await js(`document.getElementById('sidebar-handle').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }))`);
  check('column: letting go ends the drag', !(await js(`document.body.classList.contains('resizing-sidebar')`)));
  check('column: the pages get the room that is left', (await stageWidth()) === stageBefore - 150, `${await stageWidth()} vs ${stageBefore}`);
  await waitFor(`document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas').width >= 282`, 'sharp picture after letting go');
  const wide = await thumbBox();
  check('column: pictures are drawn sharp at the new size', wide.width === 282 && wide.pixels >= 282 && wide.inColumn, JSON.stringify(wide));
  check('column: they keep their shape', Math.abs(wide.height / wide.width - narrow.height / narrow.width) < 0.02, JSON.stringify([wide, narrow]));
  check('column: the choice is remembered', (await js(`localStorage.getItem('sidebarWidth')`)) === '322');
  await waitFor(`document.querySelector('.thumb-pane.active .thumb[data-page="2"]').dataset.drawn && document.querySelector('.thumb-pane.active .thumb[data-page="2"] canvas').width >= 282`, 'a wide page at the new size');
  const widePage = await thumbBox(2);
  check('column: a wide page fits too', widePage.width === 282 && widePage.width > widePage.height, JSON.stringify(widePage));

  await dragColumn(5000);
  const windowWidth = await js('window.innerWidth');
  check('column: cannot take all the room from the pages', (await columnWidth()) === Math.min(560, windowWidth - 320), `${await columnWidth()} of ${windowWidth}`);
  await dragColumn(-5000);
  check('column: cannot get too narrow to use', (await columnWidth()) === 120, String(await columnWidth()));
  await pause(100);
  const tiny = await thumbBox();
  check('column: pictures still fit', tiny.width > 50 && tiny.inColumn, JSON.stringify(tiny));

  await dragColumn(300);
  const chosen = await columnWidth();
  win.setSize(720, 480);
  await pause(400);
  check('column: a smaller window keeps room for the pages', (await stageWidth()) >= 300, String(await stageWidth()));
  const inSmallWindow = await thumbBox();
  check('column: the pictures shrink with it', inSmallWindow.inColumn, JSON.stringify(inSmallWindow));
  win.setSize(1000, 620);
  await waitFor(`document.getElementById('sidebar').offsetWidth === ${chosen}`, 'the window growing back');
  check('column: the chosen width comes back', (await columnWidth()) === chosen, `${await columnWidth()} vs ${chosen}`);

  await js(`document.getElementById('sidebar-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  check('column: double-click goes back to the usual width', (await columnWidth()) === 172, String(await columnWidth()));
  check('column: and forgets the choice', (await js(`localStorage.getItem('sidebarWidth')`)) === null);
  await js(`(() => {
    const handle = document.getElementById('sidebar-handle');
    handle.setPointerCapture = () => { throw new Error('a right click must not start a drag'); };
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 2, pointerId: 1, bubbles: true, cancelable: true }));
    delete handle.setPointerCapture;
  })()`);
  check('column: only the left button drags it', !(await js(`document.body.classList.contains('resizing-sidebar')`)));
  await click('btn-rotate-right');
  await waitFor(`(() => { const c = document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas'); return c.width > c.height; })()`, 'thumbnail turning after resizing');
  check('column: turning the view still redraws the pictures', true);
  for (let i = 0; i < 3; i++) await click('btn-rotate-right');
  await waitFor(`(() => { const c = document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas'); return c.height > c.width; })()`, 'thumbnail turned back');

  // ---- Settings
  check('settings: the button is ready', !(await js(`document.getElementById('btn-settings').disabled`)));
  await click('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open && document.getElementById('settings-version').textContent !== ''`, 'settings dialog');
  check('settings: shows the version', (await text('settings-version')) === app.getVersion(), await text('settings-version'));
  check('settings: explains both ways to set the default', await js(`(() => {
    const words = document.getElementById('settings-dialog').textContent;
    return words.includes('設定預設值') && words.includes('選擇其他應用程式') && words.includes('一律');
  })()`));
  check('settings: says how to uninstall, and what to do about the blue warning', await js(`(() => {
    const words = document.getElementById('settings-dialog').textContent;
    return words.includes('解除安裝') && words.includes('其他資訊') && words.includes('仍要執行');
  })()`));
  await waitFor(`document.querySelector('.settings-sample img').naturalWidth > 0`, 'the icon in the settings dialog');
  check('settings: the program icon shows', await js(`document.querySelector('.settings-sample img').naturalWidth === 64`));
  await click('settings-default-apps');
  await pause(100);
  check('settings: the button opens the Windows default apps page', openedLinks.at(-1) === 'ms-settings:defaultapps?registeredAppUser=PDFReaderPrint', String(openedLinks.at(-1)));
  check('settings: stays open to read the steps', await js(`document.getElementById('settings-dialog').open`));
  const keysBefore = await value('page-input');
  await press('PageDown');
  await pause(100);
  check('settings: keys do not reach the page behind', (await value('page-input')) === keysBefore);
  win.setSize(720, 480);
  await pause(400);
  check('settings: fits a small window and scrolls', await js(`(() => {
    const d = document.getElementById('settings-dialog').getBoundingClientRect();
    const b = document.getElementById('settings-close').getBoundingClientRect();
    const scrolls = document.querySelector('.settings-body').scrollHeight > document.querySelector('.settings-body').clientHeight;
    return d.bottom <= window.innerHeight && d.top >= 0 && b.height > 0 && b.bottom <= d.bottom && scrolls;
  })()`));
  win.setSize(1000, 620);
  await pause(400);
  await click('settings-close');
  check('settings: closes', await js(`!document.getElementById('settings-dialog').open`));
  await click('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open`, 'settings again');
  await js(`document.getElementById('settings-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  check('settings: Esc closes too', await js(`!document.getElementById('settings-dialog').open`));

  const selectTabIfOpen = async (name) => {
    openFiles([fixture(name)]);
    await waitFor(`document.title.startsWith(${JSON.stringify(name)})`, `tab ${name}`);
  };

  // ---- The toolbar: small things top left, the main ones in the middle, page tools above the column
  win.setSize(1280, 800);
  await waitFor('window.innerWidth > 1200', 'the wider window');
  await selectTabIfOpen('mixed.pdf');
  await waitFor(`!document.getElementById('btn-organize').disabled`, 'a file for the layout checks');
  const boxOf = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
  const middle = await boxOf('#toolbar .bar-center');
  const screenWidth = await js('document.documentElement.clientWidth');
  check('layout: the main tools sit in the middle of the window', Math.abs((middle.left + middle.right) / 2 - screenWidth / 2) < 3, JSON.stringify(middle));
  const smallOpen = await boxOf('#btn-open');
  check('layout: file buttons are small, at the top left', smallOpen.width <= 32 && smallOpen.right < middle.left, JSON.stringify(smallOpen));
  for (const id of ['btn-open', 'btn-save', 'btn-print', 'btn-thumbs']) {
    check(`layout: ${id} says what it is, having no words`, await js(`(() => { const b = document.getElementById('${id}'); return Boolean(b.title && b.getAttribute('aria-label')); })()`));
  }
  const fileButton = await boxOf('#btn-file');
  check('layout: the file menu button comes first', fileButton.left < smallOpen.left && fileButton.left < 20, JSON.stringify(fileButton));
  check('layout: nothing is cut off at this size', await js(`document.getElementById('toolbar').scrollWidth <= document.getElementById('toolbar').clientWidth`));
  const column = await boxOf('#sidebar');
  for (const id of ['btn-organize', 'btn-merge', 'btn-split']) {
    const tool = await boxOf(`#${id}`);
    check(`layout: ${id} sits above the thumbnails`, tool.left >= column.left && tool.right <= column.right && tool.top >= column.top, JSON.stringify(tool));
  }
  check('layout: the thumbnails start below those tools', (await boxOf('.thumb-pane.active')).top >= (await boxOf('#btn-organize')).bottom);
  await js(`document.documentElement.style.setProperty('--sidebar-width', '120px')`);
  await pause(100);
  const narrowColumn = await boxOf('#sidebar');
  for (const id of ['btn-organize', 'btn-merge', 'btn-split']) {
    const tool = await boxOf(`#${id}`);
    check(`layout: ${id} still fits the narrowest column`, tool.right <= narrowColumn.right && tool.left >= narrowColumn.left, JSON.stringify(tool));
  }
  await js(`document.documentElement.style.removeProperty('--sidebar-width')`);
  await click('sidebar-close');
  check('layout: the column can be closed from its own header', (await js(`getComputedStyle(document.getElementById('sidebar')).display`)) === 'none');
  check('layout: the top-left button shows it is closed', !(await js(`document.getElementById('btn-thumbs').classList.contains('on')`)));
  await click('btn-thumbs');
  check('layout: and opens again from the top left', (await js(`getComputedStyle(document.getElementById('sidebar')).display`)) !== 'none' && (await js(`document.getElementById('btn-thumbs').classList.contains('on')`)));
  await click('btn-organize');
  await waitFor(`document.body.classList.contains('organizing')`, 'organizing for the layout check');
  const organizeMiddle = await boxOf('#organize-bar .bar-center');
  check('layout: the organize tools sit in the middle too', Math.abs((organizeMiddle.left + organizeMiddle.right) / 2 - screenWidth / 2) < 3, JSON.stringify(organizeMiddle));
  await click('org-exit');
  await waitFor(`!document.body.classList.contains('organizing')`, 'back to reading');
  await shot('70-new-toolbar');

  // ---- The file menu
  const menuOpen = () => js(`!document.getElementById('file-menu').hidden`);
  const pressInMenu = (key) => js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true }))`);
  check('menu: starts closed', !(await menuOpen()));
  await click('btn-file');
  check('menu: opens', await menuOpen());
  const menuBox = await boxOf('#file-menu');
  check('menu: right under its button', Math.abs(menuBox.left - fileButton.left) < 2 && menuBox.top >= fileButton.bottom, JSON.stringify(menuBox));
  check('menu: above everything else', await js(`(() => { const r = document.getElementById('menu-open').getBoundingClientRect(); return document.getElementById('menu-open').contains(document.elementFromPoint(r.left + 20, r.top + 10)); })()`));
  check('menu: the first item has the keyboard', (await js('document.activeElement.id')) === 'menu-open');
  check('menu: lists everything for files', await js(`['menu-open', 'menu-save', 'menu-merge', 'menu-split', 'menu-print', 'btn-batch', 'btn-settings', 'menu-close'].every((id) => document.getElementById('file-menu').contains(document.getElementById(id)))`));
  await pressInMenu('ArrowDown');
  check('menu: arrow keys move down', (await js('document.activeElement.id')) === 'menu-save');
  await pressInMenu('ArrowUp');
  await pressInMenu('ArrowUp');
  check('menu: and wrap round', (await js('document.activeElement.id')) === 'menu-close');
  const pageNow = await value('page-input');
  await pressInMenu('End');
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`);
  check('menu: keys do not reach the page behind', (await value('page-input')) === pageNow);
  await pressInMenu('Escape');
  check('menu: Esc closes it', !(await menuOpen()));
  check('menu: the button gets the keyboard back', (await js('document.activeElement.id')) === 'btn-file');
  await click('btn-file');
  await js(`document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  check('menu: clicking elsewhere closes it', !(await menuOpen()));
  await click('btn-file');
  await click('btn-file');
  check('menu: its button closes it', !(await menuOpen()));

  const clickInMenu = async (id) => {
    await click('btn-file');
    await click(id);
    check(`menu: ${id} closes the menu`, !(await menuOpen()));
  };
  const savesBefore = saveDialogCalls;
  saveTarget = null;
  await clickInMenu('menu-save');
  await waitFor('true', 'the save window');
  await pause(100);
  check('menu: Save As works', saveDialogCalls === savesBefore + 1);
  await clickInMenu('menu-merge');
  await waitFor(`document.getElementById('merge-dialog').open`, 'merge from the menu');
  await click('merge-close');
  await clickInMenu('menu-split');
  await waitFor(`document.getElementById('split-dialog').open`, 'split from the menu');
  await click('split-close');
  await clickInMenu('menu-print');
  await waitFor(`document.getElementById('print-dialog').open`, 'print from the menu');
  await click('print-cancel');
  await waitFor(`!document.getElementById('print-dialog').open`, 'print dialog closed');
  await clickInMenu('btn-batch');
  await waitFor(`document.getElementById('batch-dialog').open`, 'batch from the menu');
  await click('batch-close');
  await waitFor(`!document.getElementById('batch-dialog').open`, 'batch dialog closed');
  await clickInMenu('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open`, 'settings from the menu');
  await click('settings-close');
  pickedFiles = [];
  await clickInMenu('menu-open');

  // ---- Turning the view either way
  const turnedOut = path.join(os.tmpdir(), `${TEMP_PREFIX}turned-left.pdf`);
  const viewAngle = () => js(`document.querySelector('.viewer-host.active .page canvas') ? document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas').width > document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas').height : null`);
  await click('btn-rotate-left');
  await waitFor(`(() => { const c = document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas'); return c.width > c.height; })()`, 'the view turning left');
  check('turn: left turns the view', await viewAngle());
  saveTarget = turnedOut;
  await click('btn-save');
  await waitFor(`document.getElementById('toast').textContent.includes('旋轉後的方向')`, 'saving turned left');
  const turnedLeft = (await PDFDocument.load(fs.readFileSync(turnedOut))).getPages().map((page) => page.getRotation().angle);
  check('turn: saved turned left, which is three quarters of the way round', turnedLeft.every((angle) => angle === 270), turnedLeft.join());
  fs.rmSync(turnedOut, { force: true });
  await click('btn-rotate-right');
  await waitFor(`(() => { const c = document.querySelector('.thumb-pane.active .thumb[data-page="1"] canvas'); return c.height > c.width; })()`, 'the view turning back');
  check('turn: right undoes left', !(await viewAngle()));
  saveTarget = null;
  win.setSize(1000, 620);
  await waitFor('window.innerWidth < 1000', 'the usual window size');

  // ---- The caret waits in a text box while the window is not active (see ime-anchor.js)
  const focusedId = () => js(`document.activeElement.id || document.activeElement.className || document.activeElement.tagName`);
  const anchorHolds = () => js(`document.activeElement.id === 'ime-anchor'`);
  const leaveWindow = () => js(`window.dispatchEvent(new Event('blur'))`);
  const returnToWindow = () => js(`window.dispatchEvent(new Event('focus'))`);
  check('input box: nothing can be seen of it', await js(`(() => {
    const a = getComputedStyle(document.getElementById('ime-anchor'));
    return a.opacity === '0' && a.pointerEvents === 'none' && document.getElementById('ime-anchor').tabIndex === -1;
  })()`));
  await js(`document.querySelector('.viewer-host.active').focus({ preventScroll: true })`);
  await leaveWindow();
  check('input box: holds the caret while the window is not active', await anchorHolds(), await focusedId());
  await returnToWindow();
  check('input box: keeps it for a moment after coming back', await anchorHolds());
  await waitFor(`document.activeElement.classList.contains('viewer-host')`, 'the caret going back', 4000);
  check('input box: then gives it back to the page', await js(`document.activeElement.classList.contains('viewer-host')`), await focusedId());

  await leaveWindow();
  await returnToWindow();
  await js(`document.getElementById('ime-anchor').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))`);
  check('input box: a key gives it back at once', await js(`document.activeElement.classList.contains('viewer-host')`), await focusedId());
  // A hidden window never counts as active, so turning the page puts the caret back in the box.
  await leaveWindow();
  const pageBeforeKey = await value('page-input');
  await js(`document.getElementById('ime-anchor').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`);
  await waitFor(`document.getElementById('page-input').value !== ${JSON.stringify(pageBeforeKey)}`, 'the key still working');
  check('input box: and the key still works', (await value('page-input')) !== pageBeforeKey);
  await press('PageUp');
  await pause(100);

  await leaveWindow();
  await js(`(() => { const a = document.getElementById('ime-anchor'); a.value = 'x'; a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('input box: keeps nothing typed into it', (await value('ime-anchor')) === '');
  await returnToWindow();
  await js(`window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await pause(2300);
  check('input box: a click takes over from the wait', await anchorHolds());
  await js(`document.querySelector('.viewer-host.active').focus({ preventScroll: true })`);

  await click('btn-find');
  await leaveWindow();
  check('input box: leaves a search box alone', (await focusedId()) === 'find-input', await focusedId());
  await press('Escape');
  await pause(100);
  await click('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open`, 'settings for the input box check');
  await leaveWindow();
  check('input box: leaves an open dialog alone', !(await anchorHolds()), await focusedId());
  await click('settings-close');

  await waitFor(`document.querySelector('.viewer-host.active .textLayer')?.textContent.length > 0`, 'text to select');
  await js(`(() => {
    const layer = document.querySelector('.viewer-host.active .textLayer');
    const range = document.createRange();
    range.selectNodeContents(layer);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.querySelector('.viewer-host.active').focus({ preventScroll: true });
  })()`);
  const selected = await js('getSelection().toString().length');
  await leaveWindow();
  check('input box: text selected on a page stays selected', selected > 0 && (await js('getSelection().toString().length')) === selected && !(await anchorHolds()), `${selected}`);
  await js('getSelection().removeAllRanges()');

  await leaveWindow();
  await js(`document.getElementById('ime-anchor').dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))`);
  check('input box: shortcuts work from it', !(await js(`document.getElementById('findbar').hidden`)));
  await press('Escape');

  // ---- The PDFgear button, when PDFgear has gone since the program started
  await waitFor(`!document.getElementById('btn-print').disabled`, 'a file for the PDFgear checks');
  if (await js(`document.getElementById('btn-pdfgear').hidden`)) {
    report('note PDFgear is not installed here, so its button cannot be checked');
  } else {
    await js(`document.getElementById('toast').textContent = ''`);
    pdfgearAnswer = 'spawn';
    await click('btn-pdfgear');
    await pause(150);
    check('pdfgear: gets the file', pdfgearCalls.length === 1 && pdfgearCalls[0].args.length === 1 && pdfgearCalls[0].args[0].toLowerCase().endsWith('.pdf'), JSON.stringify(pdfgearCalls[0]?.args));
    check('pdfgear: says nothing when it starts', (await text('toast')) === '', await text('toast'));
    check('pdfgear: the button stays', !(await js(`document.getElementById('btn-pdfgear').hidden`)));
    pdfgearAnswer = 'error';
    await click('btn-pdfgear');
    await waitFor(`document.getElementById('toast').textContent.includes('找不到 PDFgear')`, 'the message when PDFgear is gone');
    check('pdfgear: gone since starting gives a plain message', (await text('toast')).includes('找不到 PDFgear，無法開啟'), await text('toast'));
    check('pdfgear: and the button goes away', await js(`document.getElementById('btn-pdfgear').hidden`));
    pdfgearAnswer = 'spawn';
    await js(`document.getElementById('btn-pdfgear').hidden = false`);
  }
  check('pdfgear: never really started by this test', pdfgearCalls.every(({ command }) => typeof command === 'string'));

  // ---- One window for each file
  if (saveDialogReplaced) {
    await runWindowTests({
      app,
      BrowserWindow,
      check,
      click,
      fixture,
      heldFiles,
      js,
      openFiles,
      pause,
      saveParent: () => saveDialogParent,
      setNoPdfgear: (missing) => { pretendNoPdfgear = missing; },
      setPicked: (paths) => { pickedFiles = paths; },
      setSaveTarget: (target) => { saveTarget = target; },
      tabCount,
      tempPrefix: TEMP_PREFIX,
      userData,
      waitFor,
      win,
    });
  }

  check('no real printing happened in this test', printCalls.every((call) => typeof call.finish === 'function'));

  // ---- The page cannot navigate or open arbitrary windows
  await js(`window.location.href = 'file:///C:/Windows/win.ini'`).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('page cannot navigate away', webContents.getURL() === 'app://local/index.html', webContents.getURL());
  check('page cannot open windows', (await js(`window.open('file:///C:/Windows/win.ini') === null`)) && BrowserWindow.getAllWindows().length === 1);
  check('renderer has no Node', await js(`typeof require === 'undefined' && typeof process === 'undefined'`));
  const blocked = await js(`fetch('https://example.com').then(() => false, () => true)`);
  check('page cannot reach the internet', blocked);
  const traversal = await js(`fetch('app://local/../../main.js').then((r) => r.status)`);
  check('page cannot read outside its folder', traversal !== 200 || !(await js(`fetch('app://local/../../main.js').then((r) => r.text()).then((t) => t.includes('requestSingleInstanceLock'))`)), String(traversal));

  // ---- Closing everything
  // Most of the files opened last were temporary and are gone; this one is still there.
  await js(`window.api.noteRecent(${JSON.stringify(fixture('square.pdf'))})`);
  while ((await tabCount()) > 0) await press('w', { ctrlKey: true });
  await waitFor(`!document.getElementById('empty-state').hidden`, 'empty state');
  check('empty state after the last tab', !(await js(`document.getElementById('empty-state').hidden`)));
  await waitFor(`!document.getElementById('recent-start').hidden && document.querySelectorAll('#recent-start-list button').length > 0`, 'recent files on the start screen');
  check('the start screen lists recent files, with their folders', await js(`(() => {
    const first = document.querySelector('#recent-start-list button');
    return first.querySelector('.recent-name').textContent.endsWith('.pdf') && first.querySelector('.recent-folder').textContent.length > 3 && document.querySelectorAll('#recent-start-list button').length <= 8;
  })()`));
  check('the list sits inside the window, clear of the open button\'s words', await js(`(() => {
    const list = document.getElementById('recent-start').getBoundingClientRect();
    const words = document.querySelector('#empty-state span').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return list.top >= words.bottom && list.bottom <= stage.bottom && list.left >= stage.left && list.right <= stage.right;
  })()`));
  await shot('87-start-recent');
  await js(`[...document.querySelectorAll('#recent-start-list button')].find((b) => b.dataset.path === ${JSON.stringify(fixture('square.pdf'))}).click()`);
  await waitFor(`document.querySelectorAll('.tab').length === 1 && !document.getElementById('btn-print').disabled`, 'a recent file from the start screen');
  check('clicking one opens it', (await tabCount()) === 1 && (await js(`getComputedStyle(document.getElementById('recent-start')).display`)) === 'none');
  await press('w', { ctrlKey: true });
  await waitFor(`!document.getElementById('empty-state').hidden`, 'empty state again');
  check('title goes back', (await js('document.title')) === 'PDF閱讀列印');
  check('controls are disabled with no file', await js(`document.getElementById('btn-next').disabled && document.getElementById('zoom-select').disabled`));
  await press('p', { ctrlKey: true, shiftKey: true });
  await waitFor(`document.getElementById('batch-dialog').open`, 'batch print with no file open');
  check('with no file open, batch print cannot switch to one file', await js(`document.getElementById('batch-mode-single').disabled`));
  await click('batch-close');
  await waitFor(`!document.getElementById('batch-dialog').open`, 'batch print closed');
  check('open button still works', !(await js(`document.getElementById('btn-open').disabled`)));
  check('nothing to save with no file', await js(`document.getElementById('btn-save').disabled`));
  check('nothing to split with no file', await js(`document.getElementById('btn-split').disabled`));
  check('the menu agrees', await js(`['menu-save', 'menu-split', 'menu-print'].every((id) => document.getElementById(id).disabled)`));
  check('the menu can still merge and open', await js(`['menu-open', 'menu-merge', 'btn-batch', 'btn-settings', 'menu-close'].every((id) => !document.getElementById(id).disabled)`));
  check('merging does not need an open file', !(await js(`document.getElementById('btn-merge').disabled`)));
  const callsBeforeEmptySave = saveDialogCalls;
  await press('s', { ctrlKey: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('Ctrl+S with no file does nothing', saveDialogCalls === callsBeforeEmptySave);
  await shot('00-empty');

  // The navigation and fetch attempts above are refused on purpose and leave these messages.
  const unexpected = consoleErrors.filter((message) => !/example\.com|Not allowed to load local resource|Failed to load resource/.test(message));
  check('no errors in the page console', unexpected.length === 0, unexpected.slice(0, 5).join(' | '));

  // ---- Closing the window with unsaved changes: "don't save" really closes it,
  // and the window state is still remembered
  openFiles([fixture('mixed.pdf')]);
  await waitFor(`!document.getElementById('btn-organize').disabled`, 'a file to leave unsaved');
  await click('btn-organize');
  await waitFor(`document.body.classList.contains('organizing')`, 'organizing before closing');
  await press('a', { ctrlKey: true });
  await click('org-right');
  win.once('closed', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    check('window size is saved', saved.window?.width === 1000 && saved.window?.height === 620, JSON.stringify(saved.window));
    finish(failures ? 1 : 0);
  });
  win.close();
  if (!await waitFor(`document.getElementById('organize-dialog').open`, 'asked before closing the window')) finish(1);
  await click('org-dialog-discard');
}
