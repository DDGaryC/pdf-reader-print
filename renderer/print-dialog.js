import { planSheets, printablePlan, sheetsOfPaper } from './n-up.js';
import { parsePageRange } from './page-range.js';
import { SetupPicker } from './print-setups.js';
import {
  applyPrintSettings, fillPrinters, PAPER_POINTS, readPrintSettings, scanPages, SheetPreview, sidewaysDuplexHint, validCopies,
} from './print-shared.js';

const $ = (id) => document.getElementById(id);

const MESSAGE_PRINT_FAILED = '列印失敗，請確認印表機可以使用後再試一次。';
const MESSAGE_CANNOT_ARRANGE = '這份檔案沒辦法排成一張多頁，請改成每張紙印 1 頁。';
const MESSAGE_CANNOT_UNLOCK = '這份檔案沒辦法用密碼解開來列印，請先用 PDFgear 移除密碼再列印。';

// Page directions and unprintable annotations, worked out once per open document.
const scans = new WeakMap();

function scanDocument(view) {
  let scan = scans.get(view);
  if (!scan) {
    scan = scanPages(view.doc);
    scans.set(view, scan);
  }
  return scan;
}

// Each page's visible part and rotation setting, for laying several out on a sheet.
const shapes = new WeakMap();

async function shapesOf(view, numbers) {
  if (!shapes.has(view)) shapes.set(view, new Map());
  const known = shapes.get(view);
  await Promise.all(numbers.filter((n) => !known.has(n)).map(async (n) => {
    const page = await view.doc.getPage(n);
    known.set(n, { number: n, view: [...page.view], rotate: page.rotate });
  }));
  return numbers.map((n) => known.get(n));
}

const perSheet = () => Number($('print-per-sheet').value);
const twoSided = () => $('print-duplex').value !== 'simplex';

let session = null;

const readSettings = () => readPrintSettings('print');
const sheetPreview = new SheetPreview($('print-sheets'), readSettings, 'print');

function applySettings(settings) {
  applyPrintSettings('print', session.info.isProtected ? { ...settings, direction: 'counterclockwise' } : settings);
}

// A saved setup chosen from the list. Its printer may be gone; then the current one stays.
function applySetup(setup) {
  const printerFound = !setup.printer || session.printers.some((printer) => printer.name === setup.printer);
  applySettings({ ...setup, printer: printerFound && setup.printer ? setup.printer : $('print-printer').value });
  $('print-per-sheet').value = String(setup.perSheet);
  $('print-border').checked = setup.border;
  updatePrinterHint();
  $('print-sheets').classList.toggle('gray', $('print-grayscale').checked);
  rebuildPreview();
  return printerFound;
}

const setupPicker = new SetupPicker('print', {
  current: () => ({ ...readSettings(), perSheet: perSheet(), border: $('print-border').checked }),
  apply: applySetup,
  printerLabel: () => (session ? selectedPrinter()?.displayName ?? '' : ''),
  ignoreDirection: () => Boolean(session?.info.isProtected),
});

// Which pages will print. Returns null while the custom range is not valid.
function resolvePages() {
  const { view } = session;
  const mode = document.querySelector('input[name="print-range"]:checked').value;
  $('print-range-error').hidden = true;
  if (mode === 'all') {
    return { pages: Array.from({ length: view.pageCount }, (_v, i) => i + 1), range: '' };
  }
  if (mode === 'current') {
    return { pages: [session.currentPage], range: String(session.currentPage) };
  }
  const parsed = parsePageRange($('print-custom').value, view.pageCount);
  if (!parsed.ok) {
    $('print-range-error').textContent = parsed.message;
    $('print-range-error').hidden = false;
    return null;
  }
  return { pages: parsed.pages, range: parsed.normalized };
}

function selectedPrinter() {
  return session.printers.find((printer) => printer.name === $('print-printer').value) ?? null;
}

function updatePrintButton() {
  const { resolved, info, busy, ready, plan } = session;
  $('print-start').disabled = busy || !ready || !resolved || !validCopies($('print-copies'))
    || !selectedPrinter() || (perSheet() > 1 && !plan);
}

// Several pages per sheet are always shrunk to fit their space, and may have frames.
function updateLayoutFields() {
  const several = perSheet() > 1;
  $('print-border-row').hidden = !several;
  $('print-scale').disabled = several;
  $('print-scale').title = several ? '每張紙印多頁時，會自動縮小到放得下。' : '';
}

function updatePrinterHint() {
  const hint = $('print-printer-hint');
  hint.hidden = !selectedPrinter()?.asksForFile;
  hint.textContent = '選這台印表機會跳出存檔視窗，要選擇存檔位置。';
}

function addNotice(text, kind) {
  const notice = document.createElement('p');
  notice.className = `print-notice ${kind}`;
  notice.textContent = text;
  $('print-notices').append(notice);
}

function updateNotices() {
  const { info, scanned } = session;
  $('print-notices').replaceChildren();
  if (info.printForbidden) addNotice('此檔案的作者設定為禁止列印。', 'warning');
  const hidden = scanned && session.resolved
    ? session.resolved.pages.reduce((sum, n) => sum + (session.scan.hiddenAnnotations[n] ?? 0), 0)
    : 0;
  if (hidden > 0) addNotice(`有 ${hidden} 個註解沒有設定為可列印，不會印出。`, 'warning');
}

function updateDuplexHint() {
  const hint = $('print-duplex-hint');
  const duplex = $('print-duplex').value;
  hint.hidden = !(session?.plan?.landscape && duplex !== 'simplex');
  hint.textContent = sidewaysDuplexHint(duplex);
}

function updateSummary() {
  updateDuplexHint();
  const { resolved, scanned, scan, plan } = session;
  if (!resolved) {
    $('print-summary').textContent = '';
    return;
  }
  const total = resolved.pages.length;
  if (perSheet() > 1) {
    if (!plan) {
      $('print-summary').textContent = `共 ${total} 頁，正在排版…`;
      return;
    }
    const turned = plan.sheets.reduce((sum, { slots }) => sum + slots.filter((slot) => slot.turned).length, 0);
    const copies = validCopies($('print-copies')) ?? 1;
    $('print-summary').textContent = [
      `共 ${total} 頁，每張紙印 ${plan.perSheet} 頁`,
      ...(twoSided() ? ['雙面印'] : []),
      `${copies > 1 ? '每份' : ''}要用 ${sheetsOfPaper(plan.sheets.length, twoSided())} 張紙`,
      ...(turned > 0 ? [`${turned} 頁已轉向`] : []),
      ...(plan.landscape ? ['印出來要橫著看'] : []),
    ].join('，');
    return;
  }
  if (!scanned) {
    $('print-summary').textContent = `共 ${total} 頁，正在檢查頁面方向…`;
    return;
  }
  const turned = resolved.pages.filter((n) => scan.landscape[n]).length;
  $('print-summary').textContent = turned > 0
    ? `共 ${total} 頁，其中 ${turned} 頁橫向已自動轉向`
    : `共 ${total} 頁，沒有橫向頁`;
}

// ---- Preview --------------------------------------------------------------

function rebuildPreview() {
  const current = session;
  current.preview.clear();
  current.plan = null;
  current.layoutToken++;
  current.resolved = resolvePages();
  if ($('print-status').textContent === MESSAGE_CANNOT_ARRANGE) showStatus('');
  updateLayoutFields();
  updateSummary();
  updateNotices();
  updatePrintButton();
  const { resolved, view } = current;
  if (!resolved) return;
  if (perSheet() === 1) {
    current.preview.show(view.doc, resolved.pages);
    return;
  }
  // The print button waits for the plan: what is printed is what the preview shows.
  const token = current.layoutToken;
  shapesOf(view, resolved.pages).then((pages) => {
    if (session !== current || current.layoutToken !== token) return;
    const settings = readSettings();
    current.plan = planSheets(pages, { perSheet: perSheet(), paper: PAPER_POINTS[settings.paper], direction: settings.direction });
    current.preview.showSheets(view.doc, current.plan, { border: $('print-border').checked, twoSided: twoSided() });
    updateSummary();
    updatePrintButton();
  }, (err) => {
    if (session !== current || current.layoutToken !== token) return;
    console.warn('laying out the sheets failed:', err);
    showStatus(MESSAGE_CANNOT_ARRANGE, true);
  });
}

// ---- Dialog ---------------------------------------------------------------

function setBusy(busy, message = '') {
  session.busy = busy;
  $('print-mode-batch').disabled = busy;
  $('print-fields').disabled = busy;
  $('print-cancel').disabled = busy;
  showStatus(message);
  updatePrintButton();
}

function showStatus(message, isError = false) {
  const status = $('print-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', isError);
}

function closeDialog() {
  if (!session || session.busy) return;
  const { view, preview } = session;
  preview.clear();
  session = null;
  $('print-dialog').close();
  view.host.focus({ preventScroll: true });
  view.releaseMemory();
}

async function startPrint() {
  if (!session || $('print-start').disabled) return;
  const current = session;
  const printer = selectedPrinter();
  setBusy(true, printer.asksForFile
    ? '請在跳出的「另存列印輸出」視窗選擇存檔位置。存好後還要處理每一頁，頁數多時要等一下。'
    : '處理中，請稍候…');
  const result = await window.api.print({
    fileId: current.view.file.id,
    settings: readSettings(),
    pages: current.resolved.range,
    copies: validCopies($('print-copies')),
    sheets: current.plan ? printablePlan(current.plan, $('print-border').checked) : null,
    // Sumatra cannot be given a password, so the main program unlocks a temporary copy.
    password: current.info.needsOpenPassword ? current.view.openPassword() : null,
  });
  setBusy(false);
  if (result.ok) {
    const onDone = current.onDone;
    closeDialog();
    onDone(result.fellBackToCounterclockwise
      ? '已送出到印表機。這份檔案無法改成順時針，已用逆時針列印。'
      : '已送出到印表機。');
    return;
  }
  if (result.reason === 'PRINT_FAILED' && printer.asksForFile) showStatus('已取消，沒有列印。');
  else if (result.reason === 'CANNOT_ARRANGE') showStatus(MESSAGE_CANNOT_ARRANGE, true);
  else if (result.reason === 'CANNOT_UNLOCK') showStatus(MESSAGE_CANNOT_UNLOCK, true);
  else showStatus(MESSAGE_PRINT_FAILED, true);
}

// onSwitch(): the user wants batch printing instead; called once this dialog has closed.
export async function openPrintDialog(view, { onDone, onSwitch = null }) {
  if (session || !view?.ready) return;
  const dialog = $('print-dialog');
  session = {
    view,
    onDone,
    onSwitch,
    currentPage: view.pageNumber,
    info: { needsOpenPassword: false, printForbidden: false, isProtected: false },
    printers: [],
    resolved: null,
    ready: false,
    busy: false,
    scan: scanDocument(view),
    scanned: false,
    preview: sheetPreview,
    plan: null,
    layoutToken: 0,
  };
  const current = session;

  sheetPreview.resetZoom();
  $('print-copies').value = 1;
  // Not remembered: a forgotten "4 per sheet" would shrink the next printout without warning.
  $('print-per-sheet').value = '1';
  $('print-border').checked = false;
  updateLayoutFields();
  document.querySelector('input[name="print-range"][value="all"]').checked = true;
  $('print-custom').value = '';
  // The total is shown so a custom range can be typed without guessing the last page.
  $('print-all-label').textContent = `全部（共 ${view.pageCount} 頁）`;
  $('print-current-label').textContent = `目前頁（第 ${view.pageNumber} 頁）`;
  $('print-printer').replaceChildren();
  $('print-direction-hint').hidden = true;
  document.querySelector('input[name="print-direction"][value="clockwise"]').disabled = false;
  showStatus('');
  $('print-summary').textContent = '';
  $('print-duplex-hint').hidden = true;
  $('print-notices').replaceChildren();
  $('print-sheets').replaceChildren();
  $('print-fields').disabled = false;
  $('print-mode-batch').disabled = false;
  setupPicker.reset([]);
  updatePrintButton();
  dialog.showModal();

  const [info, options] = await Promise.all([view.printInfo(), window.api.printOptions()]);
  if (session !== current) return;
  current.info = info;
  current.printers = options.printers;
  current.ready = true;

  fillPrinters($('print-printer'), options.printers);
  document.querySelector('input[name="print-direction"][value="clockwise"]').disabled = info.isProtected;
  $('print-direction-hint').hidden = !info.isProtected;
  applySettings(options.settings);
  updatePrinterHint();
  if (options.printers.length === 0) showStatus('找不到印表機，請先在 Windows 設定中新增。', true);
  $('print-sheets').classList.toggle('gray', $('print-grayscale').checked);
  rebuildPreview();
  setupPicker.reset(options.setups);

  current.scan.done.then(() => {
    if (session !== current) return;
    current.scanned = true;
    updateSummary();
    updateNotices();
  }, (err) => console.warn('page check failed:', err));
}

function wire() {
  let rangeTimer = null;
  const rebuildSoon = () => {
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => {
      if (session) rebuildPreview();
    }, 200);
  };

  $('print-cancel').addEventListener('click', closeDialog);
  $('print-mode-batch').addEventListener('click', () => {
    if (!session || session.busy) return;
    const { onSwitch } = session;
    closeDialog();
    onSwitch?.();
  });
  $('print-start').addEventListener('click', startPrint);
  $('print-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  $('print-border').addEventListener('change', () => {
    if (session) session.preview.setBorder($('print-border').checked);
  });
  for (const id of ['print-scale', 'print-paper', 'print-per-sheet']) {
    $(id).addEventListener('change', () => {
      if (session) rebuildPreview();
    });
  }
  for (const input of document.querySelectorAll('input[name="print-range"], input[name="print-direction"]')) {
    input.addEventListener('change', () => {
      if (session) rebuildPreview();
    });
  }
  $('print-printer').addEventListener('change', () => {
    if (!session) return;
    updatePrinterHint();
    updatePrintButton();
  });
  $('print-copies').addEventListener('input', () => {
    if (!session) return;
    updatePrintButton();
    updateSummary();
  });
  $('print-duplex').addEventListener('change', () => {
    if (!session) return;
    session.preview.setTwoSided(twoSided());
    updateSummary();
  });
  $('print-custom').addEventListener('focus', () => {
    const custom = document.querySelector('input[name="print-range"][value="custom"]');
    if (!custom.checked) {
      custom.checked = true;
      if (session) rebuildPreview();
    }
  });
  $('print-custom').addEventListener('input', rebuildSoon);
  $('print-grayscale').addEventListener('change', () => {
    $('print-sheets').classList.toggle('gray', $('print-grayscale').checked);
  });
  // The saved setup shown follows every change to the settings.
  $('print-fields').addEventListener('change', () => {
    if (session?.ready) setupPicker.sync();
  });
}

wire();
