const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pdfPathsFromArgv } = require('./lib/args');
const { IMAGE_EXTENSIONS, IMAGE_PAPERS, MAX_IMAGE_BYTES, isImagePath, readImageInfo, shownSize } = require('./lib/images');
const { removeOldTempFiles, writeClockwiseCopy } = require('./lib/normalize');
const { writeSheetsCopy } = require('./lib/n-up');
const { chooseWindow } = require('./lib/open-route');
const { mergeFiles, organizeFiles, saveCopy, splitFile } = require('./lib/pages');
const { PdfFiles } = require('./lib/pdf-files');
const { findPdfgear, openInPdfgear } = require('./lib/pdfgear');
const {
  buildPrintArgs, choosePrinter, mergePrinters, queryWindowsPrinters, runSumatra, sanitizePrintSettings,
} = require('./lib/printer');
const { addSetup, removeSetup, sanitizeSetups } = require('./lib/print-setups');
const recent = require('./lib/recent');
const { loadSettings, saveSettings } = require('./lib/settings');
const { usablePassword, writeUnlockedCopy } = require('./lib/unlock');
const { createUpdater } = require('./lib/updater');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const ENTRY_URL = 'app://local/index.html';
// Goes straight to this program's page in the Windows settings, where Windows has that page.
const DEFAULT_APPS_URI = 'ms-settings:defaultapps?registeredAppUser=PDFReaderPrint';
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
};
// How far each new window sits from the one before, so they do not hide each other exactly.
const WINDOW_CASCADE = 28;

// The automated tests run the real app without ever showing a window.
const HIDDEN_FOR_TEST = process.env.PDF_READER_TEST_HIDDEN === '1';

// A document viewer gains little from the graphics card here, because pages are drawn
// in software anyway, and turning it off saves about 240 MB at peak.
app.disableHardwareAcceleration();
// The same id as the shortcuts, so a pinned icon and the open window are one icon on the taskbar.
app.setAppUserModelId('com.gary.pdfreaderprint');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const pdfFiles = new PdfFiles();
// One entry for each open window, by the id of its page.
const windows = new Map();
let lastActive = null;
let settings = {};
let settingsFile = '';
let pdfgearExe = null;
let windowsPrinters = null;
let windowsPrinterQuery = null;

const stateOf = (event) => windows.get(event.sender.id);

// Looks on GitHub for a newer version only when the user presses the button in the
// settings window. The tests put a pretend updater in place of the real one.
let updateListener = null;
const updates = createUpdater({
  load: () => require('electron-updater').autoUpdater,
  isPackaged: app.isPackaged || process.env.PDF_READER_TEST_UPDATER === '1',
  currentVersion: app.getVersion(),
  canQuit: () => [...windows.values()].every((state) => !state.unsaved),
  onProgress: (percent) => {
    if (updateListener && !updateListener.isDestroyed()) updateListener.send('update:progress', percent);
  },
});
const openMode = () => (settings.openIn === 'tab' ? 'tab' : 'window');

async function serveRenderer(request) {
  const { host, pathname } = new URL(request.url);
  if (host !== 'local') return new Response(null, { status: 404 });
  const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response(null, { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': MIME_TYPES[ext] ?? 'application/octet-stream' };
    if (ext === '.html') headers['content-security-policy'] = CONTENT_SECURITY_POLICY;
    return new Response(body, { headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function restoredBounds() {
  const saved = settings.window;
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return { width: 1280, height: 800 };
  }
  const step = windows.size * WINDOW_CASCADE;
  const bounds = { x: saved.x + step, y: saved.y + step, width: saved.width, height: saved.height };
  const area = screen.getDisplayMatching(bounds).workArea;
  const onScreen = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
    && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  return onScreen ? bounds : { width: saved.width, height: saved.height };
}

function persistSettings() {
  try {
    saveSettings(settingsFile, settings);
  } catch (err) {
    console.error('could not save settings', err);
  }
}

function rememberWindowState(win) {
  if (win.isDestroyed() || win.isMinimized()) return;
  const bounds = win.getNormalBounds();
  // A window moved aside to make room for others should not move the next start along too.
  const place = windows.size > 1 && settings.window ? { x: settings.window.x, y: settings.window.y } : {};
  settings.window = { ...bounds, ...place, maximized: win.isMaximized() };
  persistSettings();
}

const sumatraExe = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'SumatraPDF.exe')
  : path.join(__dirname, 'resources', 'SumatraPDF.exe'));
const printTempDir = () => path.join(app.getPath('temp'), 'pdf-reader-print');

// Asking Windows takes over a second, so the answer is fetched ahead of time and the
// print dialog opens at once. It is refreshed in the background for the next time.
function refreshWindowsPrinters() {
  windowsPrinterQuery ??= queryWindowsPrinters().then((list) => {
    windowsPrinterQuery = null;
    if (list.length > 0) windowsPrinters = list;
  });
  return windowsPrinterQuery;
}

async function printOptions(sender) {
  if (windowsPrinters) refreshWindowsPrinters();
  else await refreshWindowsPrinters();
  const printers = mergePrinters(await sender.getPrintersAsync(), windowsPrinters ?? []);
  const remembered = sanitizePrintSettings(settings.print);
  return {
    printers,
    settings: { ...remembered, printer: choosePrinter(printers, remembered.printer) },
    setups: sanitizeSetups(settings.printSetups),
  };
}

async function saveAs(win, id, rotation) {
  const source = pdfFiles.pathOf(id);
  if (!source) return { ok: false, reason: 'NOT_OPEN' };
  const { dir, name } = path.parse(source);
  const result = await dialog.showSaveDialog(win, {
    defaultPath: path.join(dir, `${name}${rotation ? '_旋轉' : '_複本'}.pdf`),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, reason: 'CANCELED' };
  return saveCopy(source, result.filePath, rotation);
}

// Each entry is the id of an open PDF, or { image: path } for a picture the user added.
async function mergeAs(win, entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  const sources = list.map((entry) => {
    if (typeof entry === 'string') return pdfFiles.pathOf(entry);
    return isImagePath(entry?.image) && path.isAbsolute(entry.image) ? { image: entry.image } : null;
  });
  if (sources.length === 0 || sources.includes(null)) return { ok: false, reason: 'NOT_OPEN' };
  const imagePaper = IMAGE_PAPERS.includes(options?.imagePaper) ? options.imagePaper : 'A4';
  const today = new Date();
  const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  const onlyImages = sources.every((source) => typeof source !== 'string');
  const first = typeof sources[0] === 'string' ? sources[0] : sources[0].image;
  const result = await dialog.showSaveDialog(win, {
    defaultPath: path.join(path.dirname(first), `${onlyImages ? '圖片' : '合併'}_${date}.pdf`),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, reason: 'CANCELED' };
  return mergeFiles(sources, result.filePath, { imagePaper });
}

// What the merge list shows about a picture: its size once turned the way it says.
async function inspectImage(filePath) {
  if (!isImagePath(filePath) || !path.isAbsolute(filePath)) return { ok: false, code: 'NOT_IMAGE' };
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return { ok: false, code: 'EMPTY' };
    if (size > MAX_IMAGE_BYTES) return { ok: false, code: 'TOO_BIG' };
    // The size and the orientation are near the start; a big EXIF block can push them back.
    const head = Buffer.alloc(Math.min(size, 512 * 1024));
    await handle.read(head, 0, head.length, 0);
    const info = readImageInfo(head);
    if (!info) return { ok: false, code: 'BAD_IMAGE' };
    return { ok: true, name: path.basename(filePath), type: info.type, ...shownSize(info), bytes: size };
  } catch (err) {
    return { ok: false, code: err.code === 'ENOENT' ? 'NOT_FOUND' : 'CANNOT_READ' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The picture itself, for a small preview in the list.
async function readImage(filePath) {
  const info = await inspectImage(filePath);
  if (!info.ok) return null;
  try {
    return await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
}

async function pickFolder(state, current) {
  const result = await dialog.showOpenDialog(state.win, {
    defaultPath: typeof current === 'string' ? current : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  [state.pickedFolder] = result.filePaths;
  return state.pickedFolder;
}

// The page may only name a folder the user just chose; otherwise files go next to the original.
async function splitPdf(state, sender, request) {
  const source = pdfFiles.pathOf(request?.fileId);
  if (!source) return { ok: false, reason: 'NOT_OPEN', written: 0 };
  const folder = request.folder && request.folder === state.pickedFolder ? state.pickedFolder : path.dirname(source);
  state.lastOutputFolder = folder;
  return splitFile(source, request.parts, folder, (done, total) => {
    if (!sender.isDestroyed()) sender.send('pages:progress', done, total);
  });
}

// The first source is the file being organized; the others are files inserted into it.
async function organizePages(win, request) {
  const sources = (Array.isArray(request?.sourceIds) ? request.sourceIds : []).map((id) => pdfFiles.pathOf(id));
  if (sources.length === 0 || sources.includes(null)) return { ok: false, reason: 'NOT_OPEN' };
  if (request.how === 'overwrite') return organizeFiles(sources, request.layout, sources[0], { overOriginal: true });
  const suffix = { saveAs: '_整理', extract: '_擷取' }[request.how];
  if (!suffix) return { ok: false, reason: 'BAD_REQUEST' };
  const { dir, name } = path.parse(sources[0]);
  const result = await dialog.showSaveDialog(win, {
    defaultPath: path.join(dir, `${name}${suffix}.pdf`),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, reason: 'CANCELED' };
  const isSource = sources.some((source) => path.resolve(source).toLowerCase() === path.resolve(result.filePath).toLowerCase());
  if (!isSource && pdfFiles.isOpen(result.filePath)) return { ok: false, reason: 'OPEN_ELSEWHERE' };
  return organizeFiles(sources, request.layout, result.filePath);
}

async function runPrintJob(request) {
  const filePath = pdfFiles.pathOf(request?.fileId);
  if (!filePath) return { ok: false, reason: 'NOT_OPEN' };
  const options = sanitizePrintSettings(request.settings);
  settings.print = options;
  persistSettings();

  let target = filePath;
  let tempFile = null;
  let fellBackToCounterclockwise = false;
  // A file that needs a password to open comes with the one the user typed for it. It is
  // only kept in memory, and the unlocked copy goes as soon as printing is done.
  const password = request.password === undefined || request.password === null ? null : request.password;
  if (password !== null && !usablePassword(password)) return { ok: false, reason: 'BAD_REQUEST' };
  // Several pages per sheet: a file of whole sheets, already turned the chosen way.
  const sheets = request.sheets ?? null;
  if (sheets) {
    try {
      tempFile = await writeSheetsCopy(filePath, sheets, printTempDir(), password ?? '');
      target = tempFile;
    } catch (err) {
      if (password !== null && /password/i.test(String(err?.message))) return { ok: false, reason: 'CANNOT_UNLOCK' };
      console.warn('could not lay out several pages per sheet', err);
      return { ok: false, reason: 'CANNOT_ARRANGE' };
    }
  } else if (password !== null) {
    // Locked files count as protected, so they turn counter-clockwise, like the others.
    if (options.direction === 'clockwise') fellBackToCounterclockwise = true;
    try {
      tempFile = await writeUnlockedCopy(filePath, password, printTempDir());
      target = tempFile;
    } catch (err) {
      if (err?.code !== 'WRONG_PASSWORD') console.warn('could not unlock the file for printing', err);
      return { ok: false, reason: 'CANNOT_UNLOCK' };
    }
  } else if (options.direction === 'clockwise' && request.isProtected === true) {
    fellBackToCounterclockwise = true;
  } else if (options.direction === 'clockwise') {
    try {
      tempFile = await writeClockwiseCopy(filePath, printTempDir());
      target = tempFile;
    } catch (err) {
      console.warn('could not rotate clockwise, printing the original', err);
      fellBackToCounterclockwise = true;
    }
  }

  let args;
  try {
    args = buildPrintArgs({
      ...options,
      // The sheets are paper-sized and hold only the chosen pages.
      ...(sheets ? { scale: 'fit' } : {}),
      file: target,
      pages: sheets ? '' : request.pages,
      copies: request.copies,
      appDataDir: path.join(app.getPath('userData'), 'sumatra'),
    });
  } catch {
    if (tempFile) await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    return { ok: false, reason: 'BAD_REQUEST' };
  }

  const exitCode = await runSumatra(sumatraExe(), args);
  // A Save As window that vanished abnormally can leave its owner disabled.
  for (const { win } of windows.values()) {
    if (!win.isDestroyed()) win.setEnabled(true);
  }
  if (tempFile) await fs.promises.rm(tempFile, { force: true }).catch(() => {});
  return { ok: exitCode === 0, reason: exitCode === 0 ? null : 'PRINT_FAILED', exitCode, fellBackToCounterclockwise };
}

function sendToAllWindows(channel, ...args) {
  for (const { win } of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

function changeRecent(change) {
  settings.recent = change(settings.recent);
  persistSettings();
}

function sendPaths(state, paths) {
  if (paths.length === 0) return;
  if (state.rendererReady) state.win.webContents.send('pdf:open', paths);
  else state.pendingPaths.push(...paths);
}

function bringForward({ win, shown }) {
  // A new window comes forward by itself once it has something to show.
  if (HIDDEN_FOR_TEST || !shown) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Files being opened from outside a window, or with a window's Open button.
function placeFiles(paths, asking = null) {
  for (const filePath of paths) {
    const state = chooseWindow([...windows.values()], filePath, { mode: openMode(), asking, lastActive }) ?? createWindow();
    sendPaths(state, [filePath]);
    // Counted right away, so the next file does not take this window for an empty one.
    state.tabPaths.push(filePath);
    bringForward(state);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'PDF閱讀列印',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const { webContents } = win;
  const pageId = webContents.id;
  const state = {
    win,
    shown: false,
    rendererReady: false,
    pendingPaths: [],
    tabPaths: [],
    fileIds: new Set(),
    pickedFolder: null,
    lastOutputFolder: null,
    // While pages are being organized and not saved, closing the window asks first.
    unsaved: false,
    closeApproved: false,
  };
  windows.set(pageId, state);
  lastActive ??= state;
  win.on('focus', () => {
    lastActive = state;
  });

  // Links inside a PDF open in the browser; nothing may navigate the app itself.
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (url !== ENTRY_URL) event.preventDefault();
  });
  webContents.on('did-finish-load', () => webContents.setVisualZoomLevelLimits(1, 1));
  // A page that is gone cannot answer, and the window must still be able to close.
  webContents.on('render-process-gone', () => {
    state.unsaved = false;
  });

  win.once('ready-to-show', () => {
    state.shown = true;
    if (HIDDEN_FOR_TEST) return;
    if (settings.window?.maximized) win.maximize();
    win.show();
  });

  let saveTimer = null;
  const rememberSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => rememberWindowState(win), 500);
  };
  win.on('resize', rememberSoon);
  win.on('move', rememberSoon);
  win.on('close', (event) => {
    if (state.unsaved && !state.closeApproved) {
      event.preventDefault();
      webContents.send('window:closeRequested');
      return;
    }
    clearTimeout(saveTimer);
    rememberWindowState(win);
  });
  win.on('closed', () => {
    windows.delete(pageId);
    for (const id of state.fileIds) pdfFiles.close(id);
    if (lastActive === state) lastActive = [...windows.values()].at(-1) ?? null;
  });

  win.loadURL(ENTRY_URL);
  return state;
}

function registerIpc() {
  ipcMain.handle('pdf:pick', async (event, kind) => {
    const pictures = IMAGE_EXTENSIONS.map((ext) => ext.slice(1));
    const filters = {
      images: [{ name: '圖片', extensions: pictures }, { name: 'PDF 文件', extensions: ['pdf'] }],
      both: [{ name: 'PDF 文件和圖片', extensions: ['pdf', ...pictures] }],
    }[kind] ?? [{ name: 'PDF 文件', extensions: ['pdf'] }];
    const result = await dialog.showOpenDialog(stateOf(event).win, {
      properties: ['openFile', 'multiSelections'],
      filters,
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('pdf:place', (event, paths) => {
    if (Array.isArray(paths)) placeFiles(paths.filter((item) => typeof item === 'string'), stateOf(event));
  });
  ipcMain.handle('pdf:register', async (event, filePath) => {
    if (!windowsPrinters) refreshWindowsPrinters();
    const result = await pdfFiles.register(filePath);
    if (result.ok) {
      // A window closes without letting go of each file, so it is done for it then.
      const state = stateOf(event);
      if (state) state.fileIds.add(result.file.id);
      else pdfFiles.close(result.file.id);
    }
    return result;
  });
  ipcMain.handle('pdf:read', (_event, id, begin, end) => pdfFiles.read(id, begin, end));
  ipcMain.handle('pdf:stat', (_event, id) => pdfFiles.stat(id));
  // The files open in every window, for choosing one to compare with.
  ipcMain.handle('pdf:openPaths', () => [...windows.values()].flatMap((state) => state.tabPaths));
  ipcMain.handle('pdf:close', (event, id) => {
    stateOf(event)?.fileIds.delete(id);
    return pdfFiles.close(id);
  });
  ipcMain.handle('pdfgear:available', async () => {
    pdfgearExe = await findPdfgear();
    return pdfgearExe !== null;
  });
  ipcMain.handle('pdfgear:open', (_event, id) => {
    const filePath = pdfFiles.pathOf(id);
    if (!pdfgearExe || !filePath) return false;
    return openInPdfgear(pdfgearExe, filePath);
  });
  ipcMain.handle('pdf:saveAs', (event, id, rotation) => saveAs(stateOf(event).win, id, rotation));
  ipcMain.handle('pages:merge', (event, entries, options) => mergeAs(stateOf(event).win, entries, options));
  ipcMain.handle('image:inspect', (_event, filePath) => inspectImage(filePath));
  ipcMain.handle('image:read', (_event, filePath) => readImage(filePath));
  ipcMain.handle('pages:split', (event, request) => splitPdf(stateOf(event), event.sender, request));
  ipcMain.handle('pages:pickFolder', (event, current) => pickFolder(stateOf(event), current));
  ipcMain.handle('pages:openFolder', (event) => {
    const folder = stateOf(event)?.lastOutputFolder;
    if (folder) shell.openPath(folder);
  });
  ipcMain.handle('pages:organize', (event, request) => organizePages(stateOf(event).win, request));
  ipcMain.on('window:tabs', (event, paths) => {
    const state = stateOf(event);
    if (state && Array.isArray(paths)) state.tabPaths = paths.filter((item) => typeof item === 'string');
  });
  ipcMain.on('window:unsaved', (event, unsaved) => {
    const state = stateOf(event);
    if (state) state.unsaved = unsaved === true;
  });
  // Asks about unsaved changes first, the same as the window's own close button.
  ipcMain.on('window:requestClose', (event) => {
    stateOf(event)?.win.close();
  });
  ipcMain.on('window:close', (event) => {
    const state = stateOf(event);
    if (!state) return;
    state.closeApproved = true;
    state.win.close();
  });
  ipcMain.handle('settings:openIn', () => openMode());
  ipcMain.handle('settings:setOpenIn', (_event, mode) => {
    if (mode !== 'window' && mode !== 'tab') return;
    settings.openIn = mode;
    persistSettings();
    for (const { win } of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('settings:openInChanged', mode);
    }
  });
  ipcMain.handle('settings:twoPage', () => settings.twoPage === true);
  ipcMain.handle('settings:setTwoPage', (_event, on) => {
    settings.twoPage = on === true;
    persistSettings();
    sendToAllWindows('settings:twoPageChanged', settings.twoPage);
  });
  ipcMain.handle('print:saveSetup', (_event, setup) => {
    const result = addSetup(settings.printSetups, setup);
    if (result.ok) {
      settings.printSetups = result.setups;
      persistSettings();
    }
    return result;
  });
  ipcMain.handle('print:deleteSetup', (_event, name) => {
    settings.printSetups = removeSetup(settings.printSetups, name);
    persistSettings();
    return settings.printSetups;
  });
  ipcMain.handle('recent:list', () => recent.sanitizeRecent(settings.recent).map((entry) => entry.path));
  ipcMain.on('recent:opened', (_event, filePath) => changeRecent((list) => recent.noteOpened(list, filePath)));
  ipcMain.on('recent:page', (_event, filePath, page) => changeRecent((list) => recent.notePage(list, filePath, page)));
  ipcMain.handle('recent:pageOf', (_event, filePath) => recent.pageOf(settings.recent, filePath));
  ipcMain.handle('recent:clear', () => changeRecent(() => []));
  // A file that has gone since is taken off the list instead.
  ipcMain.handle('recent:open', async (event, filePath) => {
    if (!recent.usablePath(filePath)) return false;
    const exists = await fs.promises.stat(filePath).then((stat) => stat.isFile(), () => false);
    if (!exists) {
      changeRecent((list) => recent.forget(list, filePath));
      return false;
    }
    placeFiles([filePath], stateOf(event));
    return true;
  });
  ipcMain.handle('update:check', () => updates.check());
  ipcMain.handle('update:download', (event) => {
    updateListener = event.sender;
    return updates.download();
  });
  ipcMain.handle('update:install', () => updates.install());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:openDefaultApps', () => shell.openExternal(DEFAULT_APPS_URI));
  ipcMain.handle('print:options', (event) => printOptions(event.sender));
  ipcMain.handle('print:run', (_event, request) => runPrintJob(request));
  ipcMain.on('renderer:ready', (event) => {
    const state = stateOf(event);
    if (!state) return;
    state.rendererReady = true;
    const paths = state.pendingPaths;
    state.pendingPaths = [];
    sendPaths(state, paths);
  });
}

function start() {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const paths = pdfPathsFromArgv(argv, workingDirectory);
    if (paths.length > 0) placeFiles(paths);
    else if (lastActive) bringForward(lastActive);
  });

  app.whenReady().then(() => {
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    settings = loadSettings(settingsFile);
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    protocol.handle('app', serveRenderer);
    registerIpc();
    placeFiles(pdfPathsFromArgv(process.argv.slice(1)), createWindow());
    removeOldTempFiles(printTempDir());
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    pdfFiles.closeAll();
  });
}

if (app.requestSingleInstanceLock()) start();
else app.quit();
