import { openBatchDialog } from './batch-dialog.js';
import { CompareSession, showCompareBar } from './compare.js';
import { gatherInfo } from './doc-info.js';
import { DocView, LOAD_ERRORS, REGISTER_ERRORS, pdfjsLib } from './doc-view.js';
import { wireFileMenu } from './file-menu.js';
import { wireImeAnchor } from './ime-anchor.js';
import { openMergeDialog } from './merge-dialog.js';
import { ORGANIZE_PROTECTED, OrganizeSession, leaveAllowed, showOrganizeBar } from './organize.js';
import { openPrintDialog } from './print-dialog.js';
import { wireRecentFiles } from './recent-files.js';
import { openSettingsDialog } from './settings-dialog.js';
import { isResizingSidebar, wireSidebarWidth } from './sidebar-width.js';
import { openSplitDialog } from './split-dialog.js';

const $ = (id) => document.getElementById(id);

const APP_TITLE = 'PDF閱讀列印';
const DOCUMENT_CONTROLS = ['btn-save', 'menu-save', 'btn-print', 'menu-print', 'btn-split', 'menu-split', 'btn-organize', 'btn-zoom-out', 'zoom-select', 'btn-zoom-in', 'btn-prev', 'page-input', 'btn-next',
  'btn-rotate-left', 'btn-rotate-right', 'btn-two-page', 'btn-find', 'btn-compare', 'menu-compare', 'btn-thumbs', 'btn-pdfgear', 'menu-info'];
const IMAGE_FILE = /\.(jpe?g|png)$/i;
// How long the page must stay put before it is remembered for next time.
const REMEMBER_PAGE_DELAY_MS = 800;

const SAVE_ERRORS = {
  PROTECTED: '這份檔案受保護，無法存成旋轉後的版本。把畫面轉回原本方向就可以另存。',
  CANNOT_ROTATE: '這份檔案無法存成旋轉後的版本。把畫面轉回原本方向就可以另存。',
  SAME_FILE: '不能存到正在開啟的原檔上，請換一個檔名。',
  IN_USE: '這個檔案正在被其他程式使用，請先關閉後再試，或換一個檔名。',
  CANNOT_WRITE: '無法存檔，請確認原檔還在，而且資料夾可以寫入。',
};

const tabs = [];
let active = null;
let saving = false;
let toastTimer = null;
let toldMainUnsaved = false;
let closing = false;
let openIn = 'tab';
let reportedTabs = null;
let twoPage = false;
let sidebarMode = 'thumbs';

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

// ---- Password prompt ------------------------------------------------------

function askPassword(fileName, wrongPassword) {
  const dialog = $('password-dialog');
  const input = $('password-input');
  $('password-file').textContent = fileName;
  $('password-error').hidden = !wrongPassword;
  input.value = '';
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      $('password-ok').removeEventListener('click', onOk);
      $('password-cancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(value);
    };
    const onOk = () => finish(input.value);
    const onCancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    const onKey = (event) => {
      if (event.key === 'Enter') onOk();
    };
    $('password-ok').addEventListener('click', onOk);
    $('password-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    dialog.addEventListener('cancel', onCancel);
  });
}

// ---- Tabs -----------------------------------------------------------------

function samePath(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function nameTab({ view, element }) {
  element.title = view.file.path;
  element.querySelector('.tab-name').textContent = view.file.name;
  element.querySelector('.tab-close').setAttribute('aria-label', `關閉 ${view.file.name}`);
}

function addTab(view) {
  const element = document.createElement('div');
  element.className = 'tab';
  element.setAttribute('role', 'tab');
  const name = document.createElement('span');
  name.className = 'tab-name';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.title = '關閉';
  close.innerHTML = '<svg><use href="#i-close"/></svg>';
  element.append(name, close);
  element.addEventListener('mousedown', (event) => {
    if (event.button === 1) {
      event.preventDefault();
      requestCloseTab(tab);
    }
  });
  element.addEventListener('click', () => activate(tab));
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    requestCloseTab(tab);
  });
  $('tabbar').append(element);
  const tab = { view, element, organize: null, compare: null };
  nameTab(tab);
  tabs.push(tab);
  return tab;
}

function activate(tab) {
  if (active === tab) return;
  closeFindBar();
  active?.view.setActive(false);
  active?.element.setAttribute('aria-selected', 'false');
  active = tab;
  tab?.view.setActive(true);
  tab?.element.setAttribute('aria-selected', 'true');
  tab?.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (sidebarMode === 'outline') tab?.view.showOutline();
  refresh();
  tab?.compare?.focusTarget().focus({ preventScroll: true });
}

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  rememberPageNow(tab.view);
  tabs.splice(index, 1);
  tab.element.remove();
  if (active === tab) {
    active = null;
    activate(tabs[index] ?? tabs[index - 1] ?? null);
  }
  tab.organize?.destroy();
  tab.organize = null;
  tab.compare?.destroy();
  tab.compare = null;
  tab.view.destroy();
  refresh();
  // The start screen lists the files just closed.
  if (tabs.length === 0) recentFiles.reload().then(refresh);
}

// What the user does to close a tab: anything unsaved gets asked about first.
async function requestCloseTab(tab) {
  if (tab.organize) {
    if (tab.organize.dirty) activate(tab);
    if (!await leaveAllowed(tab.organize)) return;
  }
  if (tabs.includes(tab)) closeTab(tab);
}

function stepTab(direction) {
  if (tabs.length < 2) return;
  const index = tabs.indexOf(active);
  activate(tabs[(index + direction + tabs.length) % tabs.length]);
}

// ---- Opening files --------------------------------------------------------

function onViewChange(view) {
  if (view === active?.view) refresh();
  rememberPageSoon(view);
}

// The page each file is left at, so it opens there next time.
const pageTimers = new WeakMap();
const rememberedPages = new WeakMap();
function rememberPageNow(view) {
  clearTimeout(pageTimers.get(view));
  if (!view.ready || !view.remembered) return;
  const page = view.pageNumber;
  if (rememberedPages.get(view) === page) return;
  rememberedPages.set(view, page);
  window.api.rememberPage(view.file.path, page);
}
function rememberPageSoon(view) {
  if (!view.ready || !view.remembered) return;
  clearTimeout(pageTimers.get(view));
  pageTimers.set(view, setTimeout(() => rememberPageNow(view), REMEMBER_PAGE_DELAY_MS));
}

function onReadError(view) {
  showToast(`讀取「${view.file.name}」時發生問題，檔案可能已被移動或刪除。`);
}

function newView(file) {
  return new DocView(file, {
    stage: $('stage'),
    sidebar: $('sidebar-panes'),
    askPassword,
    onChange: onViewChange,
    onReadError,
    twoPage,
  });
}

async function openPath(filePath) {
  const existing = tabs.find((tab) => samePath(tab.view.file.path, filePath));
  if (existing) {
    activate(existing);
    return;
  }
  const result = await window.api.registerPdf(filePath);
  if (!result.ok) {
    showToast(`無法開啟「${baseName(filePath)}」：${REGISTER_ERRORS[result.code] ?? '發生未知的問題'}`);
    return;
  }
  const view = newView(result.file);
  view.startPage = await window.api.rememberedPage(result.file.path).catch(() => null);
  const tab = addTab(view);
  activate(tab);
  try {
    await view.load();
    // Only files that really opened go on the list of recent files.
    view.remembered = true;
    window.api.noteRecent(result.file.path);
    rememberedPages.set(view, view.startPage ?? 1);
    if (sidebarMode === 'outline' && active === tab) view.showOutline();
    refresh();
  } catch (err) {
    if (!view.canceled && tabs.includes(tab)) {
      showToast(`無法開啟「${result.file.name}」：${LOAD_ERRORS[err?.name] ?? '無法讀取這個檔案'}`);
    }
    closeTab(tab);
  }
}

function baseName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

// Files are opened one after another so password prompts never overlap.
let openQueue = Promise.resolve();
function openPaths(paths) {
  for (const filePath of paths) {
    openQueue = openQueue.then(() => openPath(filePath)).catch((err) => console.error(err)).then(() => reportTabs(true));
  }
  return openQueue;
}

// Whether these open here or in new windows is up to the setting.
async function pickAndOpen() {
  const paths = await window.api.pickPdfs();
  if (paths.length > 0) window.api.placeFiles(paths);
}

// The main program needs to know, to send a file that is already open to the right window.
// After trying to open a file it hears again in any case, as it was told to expect that file.
function reportTabs(always = false) {
  const paths = tabs.map((tab) => tab.view.file.path);
  const text = paths.join('\n');
  if (!always && text === reportedTabs) return;
  reportedTabs = text;
  window.api.setOpenTabs(paths);
}

// ---- Toolbar state --------------------------------------------------------

function showOrganizing() {
  const session = active?.organize ?? null;
  document.body.classList.toggle('organizing', session !== null);
  for (const tab of tabs) {
    tab.organize?.setActive(tab === active);
    tab.element.classList.toggle('dirty', Boolean(tab.organize?.dirty));
  }
  showOrganizeBar(session);
  // The window asks before closing only while there is something to lose.
  const unsaved = tabs.some((tab) => tab.organize?.dirty);
  if (unsaved !== toldMainUnsaved) {
    toldMainUnsaved = unsaved;
    window.api.setUnsaved(unsaved);
  }
}

function showComparing() {
  const session = active?.compare ?? null;
  document.body.classList.toggle('comparing', session !== null);
  for (const tab of tabs) tab.compare?.setActive(tab === active);
  showCompareBar(session);
}

function refresh() {
  const view = active?.view;
  const ready = Boolean(view?.ready);
  for (const id of DOCUMENT_CONTROLS) $(id).disabled = !ready;
  $('empty-state').hidden = tabs.length > 0;
  $('empty-state').classList.toggle('with-recent', !$('recent-start').hidden);
  $('btn-two-page').classList.toggle('on', twoPage);
  $('btn-two-page').setAttribute('aria-pressed', String(twoPage));
  // With one window for each file, a single tab would only repeat the title bar.
  $('tabbar').hidden = tabs.length === 0 || (openIn === 'window' && tabs.length === 1);
  reportTabs();
  document.body.classList.toggle('no-doc', tabs.length === 0);
  const name = active?.compare?.title ?? `${active?.organize?.dirty ? '● ' : ''}${view?.file.name}`;
  document.title = view ? `${name} - ${APP_TITLE}` : APP_TITLE;
  showOrganizing();
  showComparing();
  imeAnchor.restIfInactive();

  if (!ready) {
    $('page-input').value = '';
    $('page-total').textContent = '/ 0';
    $('zoom-select').value = 'page-fit';
    return;
  }
  if (document.activeElement !== $('page-input')) $('page-input').value = view.pageNumber;
  $('page-total').textContent = `/ ${view.pageCount}`;
  $('btn-prev').disabled = view.pageNumber <= 1;
  $('btn-next').disabled = view.pageNumber >= view.pageCount;
  showScale(view);
  if (!$('findbar').hidden) showFindCount(view);
}

function showScale(view) {
  const select = $('zoom-select');
  const value = String(view.scaleValue);
  if ([...select.options].some((option) => option.value === value && !option.hidden)) {
    select.value = value;
    return;
  }
  const custom = select.options[0];
  custom.textContent = `${Math.round(view.scale * 100)}%`;
  select.value = custom.value;
}

// ---- Search ---------------------------------------------------------------

function openFindBar() {
  if (!active?.view.ready) return;
  $('findbar').hidden = false;
  $('find-input').focus();
  $('find-input').select();
  if ($('find-input').value) active.view.find($('find-input').value);
}

function closeFindBar() {
  if ($('findbar').hidden) return;
  $('findbar').hidden = true;
  $('find-count').textContent = '';
  active?.view.closeFind();
  active?.view.host.focus({ preventScroll: true });
}

function showFindCount(view) {
  const count = $('find-count');
  const hasQuery = $('find-input').value !== '';
  count.classList.toggle('none', hasQuery && view.findNotFound);
  if (!hasQuery) count.textContent = '';
  else if (view.findNotFound) count.textContent = '找不到';
  else count.textContent = view.findTotal ? `${view.findCurrent} / ${view.findTotal}` : '';
}

function findAgain(previous) {
  if (!$('find-input').value) return;
  active?.view.find($('find-input').value, { again: true, previous });
}

// ---- Wiring ---------------------------------------------------------------

const imeAnchor = wireImeAnchor($('ime-anchor'), () => active?.compare?.focusTarget() ?? active?.view.host ?? null);

function isTyping(target) {
  if (imeAnchor.isAnchor(target)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement
    || target instanceof HTMLTextAreaElement;
}

function printActive() {
  const view = active?.view;
  if (!view?.ready) return;
  // Switching to batch printing starts its list with this file.
  openPrintDialog(view, { onDone: showToast, onSwitch: () => openBatch([view.file.path]) });
}

async function saveActiveAs() {
  const view = active?.view;
  if (!view?.ready || saving) return;
  saving = true;
  try {
    const { rotation } = view;
    // Protected files can only be copied as they are, so don't ask where to save first.
    if (rotation !== 0) {
      const info = await view.printInfo();
      if (info.isProtected || info.needsOpenPassword) {
        showToast(SAVE_ERRORS.PROTECTED);
        return;
      }
    }
    const result = await window.api.saveAs(view.file.id, rotation);
    if (result.ok) {
      showToast(rotation === 0 ? `已另存成「${result.name}」。` : `已另存成「${result.name}」，裡面是旋轉後的方向。`);
    } else if (result.reason !== 'CANCELED') {
      showToast(SAVE_ERRORS[result.reason] ?? '無法存檔。');
    }
  } finally {
    saving = false;
  }
}

const openFilePaths = () => tabs.filter((tab) => tab.view.ready).map((tab) => tab.view.file.path);
const isDialogOpen = () => document.querySelector('dialog[open]') !== null;

function afterDialog(message) {
  active?.view.host.focus({ preventScroll: true });
  if (message) showToast(message);
}

function openBatch(paths = []) {
  openBatchDialog({
    paths,
    // Back to printing the one file on screen, when there is one.
    onSwitch: active?.view.ready && !active.organize && !active.compare ? printActive : null,
    openFiles: openFilePaths,
    onClose: afterDialog,
    askPassword,
    openPasswords: () => tabs.map((tab) => tab.view.openPassword()).filter((password) => typeof password === 'string'),
  });
}

function openMerge(mode = 'merge', paths = []) {
  openMergeDialog({
    mode,
    paths,
    openFiles: openFilePaths,
    onOpenResult: (filePath) => window.api.placeFiles([filePath]),
    onClose: afterDialog,
  });
}

// ---- Document information --------------------------------------------------

async function showInfo() {
  const view = active?.view;
  if (!view?.ready || isDialogOpen()) return;
  const list = $('info-list');
  list.replaceChildren();
  $('info-dialog').showModal();
  // The page sizes may come before or after the rest is on screen.
  let sizes = null;
  let sizesCell = null;
  const rows = await gatherInfo(view, pdfjsLib, (text) => {
    sizes = text;
    if (sizesCell) sizesCell.textContent = text;
  });
  if (!$('info-dialog').open) return;
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = label === '頁面大小' && sizes ? sizes : value;
    if (label === '頁面大小') sizesCell = detail;
    list.append(term, detail);
  }
}

function closeInfo() {
  $('info-dialog').close();
  afterDialog();
}

// ---- Two pages side by side, and the left column ---------------------------

function applyTwoPage(on) {
  twoPage = on;
  for (const tab of tabs) {
    tab.view.setTwoPage(on);
  }
  refresh();
}

function setSidebarMode(mode) {
  sidebarMode = mode;
  document.body.classList.toggle('show-outline', mode === 'outline');
  for (const [id, name] of [['side-thumbs', 'thumbs'], ['side-outline', 'outline']]) {
    $(id).classList.toggle('on', mode === name);
    $(id).setAttribute('aria-selected', String(mode === name));
  }
  if (mode === 'outline') active?.view.showOutline();
}

function openSplit() {
  if (active?.view.ready) openSplitDialog(active.view, { onClose: afterDialog });
}

// ---- Page organizing --------------------------------------------------------

// ---- Comparing with another file ---------------------------------------------------

function enterCompare() {
  const tab = active;
  if (!tab?.view.ready || tab.organize || tab.compare) return;
  closeFindBar();
  tab.compare = new CompareSession(tab.view, {
    stage: $('stage'),
    askPassword,
    showToast,
    onChange: () => {
      if (tab === active) refresh();
    },
    onExit: () => leaveCompare(tab),
  });
  refresh();
  tab.compare.focusTarget().focus({ preventScroll: true });
}

function leaveCompare(tab) {
  if (!tab.compare) return;
  tab.compare.destroy();
  tab.compare = null;
  refresh();
  if (active === tab) tab.view.host.focus({ preventScroll: true });
}

async function enterOrganize() {
  const tab = active;
  if (!tab?.view.ready || tab.organize || tab.compare) return;
  const info = await tab.view.printInfo();
  if (active !== tab || !tab.view.ready || tab.organize) return;
  if (info.isProtected || info.needsOpenPassword) {
    showToast(ORGANIZE_PROTECTED);
    return;
  }
  closeFindBar();
  tab.organize = new OrganizeSession(tab.view, {
    stage: $('stage'),
    onChange: refresh,
    onReopen: (filePath) => reopenInTab(tab, filePath),
    onSplit: () => openSplitDialog(tab.view, { onClose: afterDialog }),
    onExit: () => leaveOrganize(tab),
    showToast,
  });
  refresh();
}

async function leaveOrganize(tab) {
  if (!tab.organize || !await leaveAllowed(tab.organize)) return;
  tab.organize.destroy();
  tab.organize = null;
  refresh();
  if (active === tab) tab.view.host.focus({ preventScroll: true });
}

// After saving, the tab shows the saved file. The old view only goes once the new one
// works, so a problem opening it leaves everything on screen as it was.
async function reopenInTab(tab, filePath) {
  const result = await window.api.registerPdf(filePath);
  if (!result.ok) return false;
  const view = newView(result.file);
  try {
    await view.load();
  } catch {
    view.destroy();
    return false;
  }
  if (!tabs.includes(tab)) {
    view.destroy();
    return false;
  }
  const old = tab.view;
  tab.view = view;
  nameTab(tab);
  tab.organize?.rebase(view);
  if (active === tab) {
    old.setActive(false);
    view.setActive(true);
  }
  await old.destroy();
  refresh();
  return true;
}

// The window's close button: every tab with unsaved changes gets asked about in turn.
async function closeWindowWhenAllowed() {
  if (closing) return;
  closing = true;
  try {
    for (const tab of [...tabs]) {
      if (!tab.organize?.dirty) continue;
      activate(tab);
      if (!await leaveAllowed(tab.organize)) return;
    }
    window.api.closeWindow();
  } finally {
    closing = false;
  }
}

function onKeyDown(event) {
  if (isDialogOpen()) return;
  const view = active?.view.ready ? active.view : null;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  // Printing, searching and zooming belong to the reading view, not to the list of pages.
  if (active?.organize) {
    if (ctrl && key === 'o') pickAndOpen();
    else if (ctrl && key === 'w') requestCloseTab(active);
    else if (ctrl && key === 'tab') stepTab(event.shiftKey ? -1 : 1);
    else if (!active.organize.handleKey(event)) return;
    event.preventDefault();
    return;
  }

  // Keys move both sides of a comparison together.
  if (active?.compare) {
    if (ctrl && key === 'o') pickAndOpen();
    else if (ctrl && key === 'w') requestCloseTab(active);
    else if (ctrl && key === 'tab') stepTab(event.shiftKey ? -1 : 1);
    else if (isTyping(event.target) && !ctrl) return;
    else if (!active.compare.handleKey(event)) return;
    event.preventDefault();
    return;
  }

  if (ctrl) {
    if (key === 'o') pickAndOpen();
    else if (key === 's') saveActiveAs();
    else if (key === 'd') showInfo();
    else if (key === 'p' && event.shiftKey) openBatch();
    else if (key === 'p') printActive();
    else if (key === 'f') openFindBar();
    else if (key === 'w' && active) requestCloseTab(active);
    else if (key === 'tab') stepTab(event.shiftKey ? -1 : 1);
    else if ((key === '=' || key === '+') && view) view.zoomIn();
    else if (key === '-' && view) view.zoomOut();
    else if (key === '0' && view) view.setScale('page-fit');
    else return;
    event.preventDefault();
    return;
  }

  if (key === 'escape' && !$('findbar').hidden) {
    closeFindBar();
    event.preventDefault();
    return;
  }
  if (isTyping(event.target) || !view) return;

  // Up and Down keep scrolling normally so a zoomed page can be read line by line.
  if (key === 'pagedown' || key === 'arrowright') view.nextPage();
  else if (key === 'pageup' || key === 'arrowleft') view.previousPage();
  else if (key === 'home') view.goToPage(1);
  else if (key === 'end') view.goToPage(view.pageCount);
  else return;
  event.preventDefault();
}

function wireToolbar() {
  const withView = (action) => () => {
    if (active?.view.ready) action(active.view);
  };
  $('btn-open').addEventListener('click', pickAndOpen);
  $('empty-state').addEventListener('click', pickAndOpen);
  $('btn-save').addEventListener('click', saveActiveAs);
  $('btn-print').addEventListener('click', printActive);
  $('btn-merge').addEventListener('click', () => openMerge());
  $('btn-split').addEventListener('click', openSplit);
  $('btn-organize').addEventListener('click', enterOrganize);
  $('btn-compare').addEventListener('click', enterCompare);
  wireFileMenu({
    button: $('btn-file'),
    menu: $('file-menu'),
    onOpen: () => recentFiles.reload(),
    actions: {
      recent: openRecent,
      'menu-open': pickAndOpen,
      'menu-save': saveActiveAs,
      'menu-info': showInfo,
      'menu-merge': () => openMerge(),
      'menu-images': () => openMerge('images'),
      'menu-split': openSplit,
      'menu-compare': enterCompare,
      'menu-print': printActive,
      'btn-batch': () => openBatch(),
      'btn-settings': () => openSettingsDialog(afterDialog),
      'menu-close': () => window.api.requestCloseWindow(),
    },
  });
  $('btn-zoom-in').addEventListener('click', withView((view) => view.zoomIn()));
  $('btn-zoom-out').addEventListener('click', withView((view) => view.zoomOut()));
  $('btn-next').addEventListener('click', withView((view) => view.nextPage()));
  $('btn-prev').addEventListener('click', withView((view) => view.previousPage()));
  $('btn-rotate-left').addEventListener('click', withView((view) => view.rotateView(-90)));
  $('btn-rotate-right').addEventListener('click', withView((view) => view.rotateView(90)));
  // Every window follows; the main program tells the others.
  $('btn-two-page').addEventListener('click', () => window.api.setTwoPage(!twoPage));
  $('side-thumbs').addEventListener('click', () => setSidebarMode('thumbs'));
  $('side-outline').addEventListener('click', () => setSidebarMode('outline'));
  $('info-close').addEventListener('click', closeInfo);
  $('info-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeInfo();
  });
  $('btn-find').addEventListener('click', openFindBar);
  $('btn-pdfgear').addEventListener('click', withView(async (view) => {
    if (await window.api.openInPdfgear(view.file.id)) return;
    showToast('找不到 PDFgear，無法開啟。');
    // It was there when the program started, but it is not any more.
    $('btn-pdfgear').hidden = true;
  }));
  const toggleThumbs = () => {
    const hidden = document.body.classList.toggle('thumbs-hidden');
    $('btn-thumbs').classList.toggle('on', !hidden);
  };
  $('btn-thumbs').addEventListener('click', toggleThumbs);
  $('sidebar-close').addEventListener('click', toggleThumbs);
  $('btn-thumbs').classList.add('on');

  $('zoom-select').addEventListener('change', (event) => {
    if (active?.view.ready) active.view.setScale(event.target.value);
    event.target.blur();
    active?.view.host.focus({ preventScroll: true });
  });

  const pageInput = $('page-input');
  const commitPage = () => {
    const view = active?.view;
    if (!view?.ready) return;
    const text = pageInput.value.trim();
    if (/^\d+$/.test(text) && !view.goToPage(Number(text))) {
      showToast(`頁碼要在 1 到 ${view.pageCount} 之間。`);
    }
    refresh();
  };
  pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      active?.view.host.focus({ preventScroll: true });
      commitPage();
    } else if (event.key === 'Escape') {
      pageInput.value = active?.view.pageNumber ?? '';
      active?.view.host.focus({ preventScroll: true });
    }
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  pageInput.addEventListener('blur', commitPage);

  const findInput = $('find-input');
  findInput.addEventListener('input', () => {
    if (!active?.view.ready) return;
    active.view.find(findInput.value);
    showFindCount(active.view);
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findAgain(event.shiftKey);
    }
  });
  $('find-next').addEventListener('click', () => findAgain(false));
  $('find-prev').addEventListener('click', () => findAgain(true));
  $('find-close').addEventListener('click', closeFindBar);
}

function wireDragAndDrop() {
  const hint = $('drop-hint');
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.types.includes('Files') && !isDialogOpen()) {
      event.dataTransfer.dropEffect = 'copy';
      hint.firstElementChild.textContent = active?.compare ? '放開滑鼠，用這個檔案來比對' : '放開滑鼠即可開啟 PDF';
      hint.hidden = false;
    }
  });
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) hint.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    hint.hidden = true;
    if (isDialogOpen()) return;
    const files = [...(event.dataTransfer?.files ?? [])];
    const pdfs = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'));
    const paths = pdfs.map((file) => window.api.pathForDroppedFile(file)).filter(Boolean);
    // While comparing, a file dropped on the comparison becomes the one on the right.
    if (active?.compare?.takesDrop(event.target)) {
      if (pdfs.length === 0 && files.length > 0) showToast('只能用 PDF 檔案來比對。');
      else if (paths.length > 1) showToast('一次只能比對一個檔案，已使用第一個。');
      if (paths.length > 0) active.compare.setRight(paths[0]);
      return;
    }
    // Pictures dropped on their own go into a new PDF.
    const pictures = files.filter((file) => IMAGE_FILE.test(file.name));
    if (pdfs.length === 0 && pictures.length > 0) {
      openMerge('images', pictures.map((file) => window.api.pathForDroppedFile(file)).filter(Boolean));
      return;
    }
    if (pdfs.length < files.length) showToast('只能開啟 PDF 檔案，其他檔案已略過。圖片可以用「檔案」→「圖片轉 PDF」。');
    openPaths(paths);
  });
}

// ---- Recent files ------------------------------------------------------------

async function openRecent(filePath) {
  if (await window.api.openRecent(filePath)) return;
  showToast(`找不到「${filePath.split(/[\\/]/).pop()}」，可能已被移動或刪除，已從最近開啟的清單移除。`);
  recentFiles.reload();
}

const recentFiles = wireRecentFiles({
  menuSection: $('menu-recent'),
  menuList: $('menu-recent-list'),
  startSection: $('recent-start'),
  startList: $('recent-start-list'),
  clearButton: $('menu-recent-clear'),
  open: openRecent,
});

window.addEventListener('keydown', onKeyDown);
window.addEventListener('wheel', (event) => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false });
const refitAll = () => {
  for (const tab of tabs) {
    tab.view.refit();
    tab.compare?.refit();
  }
};
// Pages are fitted once when the column is let go, so dragging it stays smooth.
new ResizeObserver(() => {
  if (!isResizingSidebar()) refitAll();
}).observe($('stage'));
wireSidebarWidth({ sidebar: $('sidebar'), handle: $('sidebar-handle'), onResized: refitAll });

wireToolbar();
wireDragAndDrop();
refresh();

window.api.hasPdfgear().then((available) => {
  $('btn-pdfgear').hidden = !available;
});
window.api.onOpenFiles(openPaths);
window.api.onCloseRequested(closeWindowWhenAllowed);
const applyOpenIn = (mode) => {
  openIn = mode;
  refresh();
};
window.api.onOpenInChanged(applyOpenIn);
window.api.openIn().then(applyOpenIn);
window.api.onTwoPageChanged(applyTwoPage);
window.api.twoPage().then(applyTwoPage);
recentFiles.reload().then(refresh);
window.api.rendererReady();
