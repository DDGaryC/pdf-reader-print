import { batchMessage, batchSummary, runBatch } from './batch-run.js';
import { openDocumentTask } from './doc-view.js';
import { FileList } from './file-list.js';
import { planSheets, printablePlan, sheetsOfPaper } from './n-up.js';
import {
  applyPrintSettings, fillPrinters, PAPER_POINTS, readPrintSettings, scanPages, SheetPreview, sidewaysDuplexHint,
  validCopies,
} from './print-shared.js';
import { SetupPicker } from './print-setups.js';

const $ = (id) => document.getElementById(id);

const PROBLEM_UNREADABLE = '無法讀取這個檔案';
const OUTCOME_NOTES = {
  failed: { text: '列印失敗，請確認印表機可以使用，以及檔案是否正常。', kind: 'error' },
  canceled: { text: '已取消存檔，沒有印出。', kind: 'warning' },
};
const NOTE_CANNOT_ARRANGE = { text: '沒辦法排成一張多頁，請把「每張紙」改成印 1 頁再印這個檔案。', kind: 'error' };
const NOTE_CANNOT_UNLOCK = { text: '沒辦法用密碼解開來列印，請先用 PDFgear 移除密碼。', kind: 'error' };
const PROBLEM_LOCKED = '有開啟密碼，按右邊的鑰匙輸入密碼才會列印';

let session = null;

const readSettings = () => readPrintSettings('batch');
const sheetPreview = new SheetPreview($('batch-sheets'), readSettings, 'batch');
const selectedPrinter = () => session.printers.find((printer) => printer.name === $('batch-printer').value) ?? null;
const perSheet = () => Number($('batch-per-sheet').value);
const twoSided = () => $('batch-duplex').value !== 'simplex';

// Several pages per sheet are only for files with more than one page; the rest print as usual.
// A file's plan is kept until a setting it depends on changes.
function planFor(item) {
  if (perSheet() === 1 || item.problem || !item.shapes) return null;
  const { paper, direction } = readSettings();
  const key = `${perSheet()}|${paper}|${direction}`;
  if (item.layout?.key !== key) {
    item.layout = { key, plan: planSheets(item.shapes, { perSheet: perSheet(), paper: PAPER_POINTS[paper], direction }) };
  }
  return item.layout.plan;
}

// Each page's visible part and rotation, for laying a file out several pages to a sheet.
async function pageShapes(doc) {
  const shapes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    shapes.push({ number: n, view: [...page.view], rotate: page.rotate });
  }
  return shapes;
}

// With several pages per sheet, the paper all the files take, for the summary.
function paperNeeded(items) {
  if (perSheet() === 1) return null;
  let merged = 0;
  let sheets = 0;
  for (const item of items.filter((one) => !one.problem && one.state === 'ready')) {
    const plan = planFor(item);
    if (plan) merged++;
    // Each file is its own print job, so two-sided files never share a sheet.
    sheets += sheetsOfPaper(plan ? plan.sheets.length : item.pages, twoSided());
  }
  return { perSheet: perSheet(), merged, sheets, twoSided: twoSided(), perCopy: (validCopies($('batch-copies')) ?? 1) > 1 };
}

function updateLayoutFields(items) {
  const several = perSheet() > 1;
  $('batch-per-sheet-hint').hidden = !several;
  $('batch-border-row').hidden = !several;
  const duplex = $('batch-duplex').value;
  const sideways = items.some((item) => planFor(item)?.landscape);
  $('batch-duplex-hint').hidden = !(sideways && duplex !== 'simplex');
  $('batch-duplex-hint').textContent = sidewaysDuplexHint(duplex);
}

function showStatus(message, isError = false) {
  const status = $('batch-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', isError);
}

function refresh() {
  if (!session) return;
  const { busy, ready } = session;
  const { items } = files;
  $('batch-summary').textContent = batchSummary(items, paperNeeded(items));
  updateLayoutFields(items);
  const checked = items.every((item) => item.state === 'ready');
  const printable = items.some((item) => !item.problem);
  $('batch-start').disabled = busy || !ready || !checked || !printable
    || !validCopies($('batch-copies')) || !selectedPrinter();
}

// ---- File list ------------------------------------------------------------

function rowDetail(item) {
  if (item.state === 'checking') return '檢查中…';
  if (item.problem) return '';
  const plan = planFor(item);
  if (plan) {
    const paper = sheetsOfPaper(plan.sheets.length, twoSided());
    return `${item.pages} 頁，每張紙印 ${plan.perSheet} 頁，${twoSided() ? '雙面' : ''}用 ${paper} 張紙${plan.landscape ? '，要橫著看' : ''}`;
  }
  return item.landscape > 0 ? `${item.pages} 頁，其中 ${item.landscape} 頁橫向` : `${item.pages} 頁，沒有橫向頁`;
}

function rowNotes(item) {
  if (item.locked) return [{ text: `${PROBLEM_LOCKED}。`, kind: 'warning' }];
  if (item.problem) return [{ text: `不會列印：${item.problem}`, kind: 'error' }];
  const notes = [];
  if (item.outcome === 'failed' && item.outcomeReason === 'CANNOT_ARRANGE') notes.push(NOTE_CANNOT_ARRANGE);
  else if (item.outcome === 'failed' && item.outcomeReason === 'CANNOT_UNLOCK') notes.push(NOTE_CANNOT_UNLOCK);
  else if (OUTCOME_NOTES[item.outcome]) notes.push(OUTCOME_NOTES[item.outcome]);
  if (item.printForbidden) notes.push({ text: '作者設定為禁止列印，一樣會印出。', kind: 'warning' });
  if (item.hiddenAnnotations > 0) notes.push({ text: `有 ${item.hiddenAnnotations} 個註解沒有設定為可列印，不會印出。`, kind: 'warning' });
  // Sheets are a new file, so a protected file laid out several to a sheet can turn clockwise.
  if (item.isProtected && readSettings().direction === 'clockwise' && !planFor(item)) notes.push({ text: '受保護，會用逆時針轉向。', kind: 'warning' });
  return notes;
}

const files = new FileList({
  dialog: $('batch-dialog'),
  list: $('batch-list'),
  empty: $('batch-empty'),
  passwordProblem: PROBLEM_LOCKED,
  // The same prompt as opening a file; the password is only kept while the dialog is open.
  askPassword: (name, wrong) => session.askPassword(name, wrong),
  describe: (item) => ({
    detail: rowDetail(item),
    notes: rowNotes(item),
    action: item.locked ? { label: '輸入密碼', icon: 'i-key', run: () => files.unlock(item) } : null,
  }),
  examine: async (item, doc) => {
    const scan = scanPages(doc);
    await scan.done.catch((err) => {
      // The directions are only shown for information; Sumatra can still print the file.
      if (!item.removed) console.warn('page check failed:', err);
    });
    item.landscape = scan.landscape.filter(Boolean).length;
    item.hiddenAnnotations = scan.hiddenAnnotations.reduce((sum, count) => sum + count, 0);
    item.shapes = null;
    if (doc.numPages > 1) {
      try {
        item.shapes = await pageShapes(doc);
      } catch (err) {
        // Without the shapes the file still prints, one page per sheet.
        if (!item.removed) console.warn('reading page sizes failed:', err);
      }
    }
  },
  isLocked: () => !session || session.busy,
  showStatus,
  onChange: refresh,
  onAdded: () => {
    if (!session.selected && files.items.length > 0) selectItem(session, files.items[0]);
  },
  onReady: (item) => {
    if (session?.selected === item) showPreview(session, item);
  },
  onRemoved: (item, index) => {
    if (session.selected === item) selectItem(session, files.items[index] ?? files.items[index - 1] ?? null);
  },
  onRowClick: (item) => selectItem(session, item),
});

// ---- Preview --------------------------------------------------------------

function selectItem(current, item) {
  current.selected?.row.classList.remove('selected');
  current.selected = item;
  item?.row.classList.add('selected');
  showPreview(current, item);
}

function closePreview(current) {
  current.preview.clear();
  const task = current.previewTask;
  current.previewTask = null;
  current.previewDoc = null;
  task?.destroy().catch(() => {});
}

function showPreviewNote(message) {
  const note = $('batch-preview-note');
  note.textContent = message;
  note.hidden = !message;
}

function rebuildPreview(current) {
  const doc = current.previewDoc;
  if (!doc) return;
  const plan = current.selected ? planFor(current.selected) : null;
  if (plan) current.preview.showSheets(doc, plan, { border: $('batch-border').checked, twoSided: twoSided() });
  else current.preview.show(doc, Array.from({ length: doc.numPages }, (_v, i) => i + 1));
}

async function showPreview(current, item) {
  closePreview(current);
  $('batch-preview-name').textContent = item?.name ?? '';
  showPreviewNote('');
  if (!item) return;
  if (item.locked) {
    showPreviewNote(`${PROBLEM_LOCKED}。`);
    return;
  }
  if (item.problem) {
    showPreviewNote(`不會列印：${item.problem}`);
    return;
  }
  if (item.state === 'checking') {
    showPreviewNote('檢查中…');
    return;
  }
  const task = openDocumentTask(item.file, () => {
    if (current.previewTask === task) showPreviewNote(PROBLEM_UNREADABLE);
  }, item.password ?? undefined);
  current.previewTask = task;
  try {
    const doc = await task.promise;
    if (current.previewTask !== task) return;
    current.previewDoc = doc;
    rebuildPreview(current);
  } catch (err) {
    if (current.previewTask === task) {
      console.warn('batch preview failed:', err);
      showPreviewNote('無法顯示預覽。');
    }
  }
}

// ---- Printing -------------------------------------------------------------

function setBusy(current, busy) {
  current.busy = busy;
  $('batch-fields').disabled = busy;
  $('batch-add').disabled = busy;
  $('batch-add-open').disabled = busy;
  $('batch-close').hidden = busy;
  $('batch-mode-single').disabled = busy || !current.onSwitch;
  $('batch-stop').hidden = !busy;
  $('batch-stop').disabled = false;
  $('batch-progress').hidden = !busy;
  files.setLocked(busy);
  refresh();
}

function showProgress(current, item, position, total) {
  current.printing?.row.classList.remove('printing');
  current.printing = item;
  item.row.classList.add('printing');
  item.row.scrollIntoView({ block: 'nearest' });
  $('batch-bar').max = total;
  $('batch-bar').value = position - 1;
  $('batch-progress-text').textContent = `正在列印 ${position} / ${total}：${item.name}`;
}

async function startBatch() {
  if (!session || $('batch-start').disabled) return;
  const current = session;
  const settings = readSettings();
  const copies = validCopies($('batch-copies'));
  const printer = selectedPrinter();
  const border = $('batch-border').checked;
  current.stopRequested = false;
  for (const item of files.items) {
    item.outcome = null;
    item.outcomeReason = null;
    files.updateRow(item);
  }
  setBusy(current, true);
  showStatus(printer.asksForFile
    ? '每個檔案都會跳出「另存列印輸出」視窗，請選擇存檔位置。在那個視窗按取消，批次會先停下來。'
    : '');

  const result = await runBatch(files.items, {
    print: (item) => {
      const plan = planFor(item);
      return window.api.print({
        fileId: item.file.id,
        settings,
        pages: '',
        copies,
        isProtected: item.isProtected,
        sheets: plan ? printablePlan(plan, border) : null,
        password: item.password ?? null,
      });
    },
    shouldStop: () => current.stopRequested,
    stopOnCancel: printer.asksForFile,
    onStart: (item, position, total) => showProgress(current, item, position, total),
  });

  current.printing?.row.classList.remove('printing');
  current.printing = null;
  setBusy(current, false);
  const message = batchMessage(result);
  const statuses = [...result.outcomes.values()].map((outcome) => outcome.status);
  if (statuses.every((status) => status === 'sent')) {
    closeDialog(message);
    return;
  }
  // Files already sent leave the list, so pressing print again cannot print them twice.
  for (const [item, outcome] of result.outcomes) {
    if (outcome.status === 'sent') {
      files.remove(item);
    } else {
      item.outcome = outcome.status;
      item.outcomeReason = outcome.reason ?? null;
      files.updateRow(item);
    }
  }
  refresh();
  showStatus(message, !result.stopped && (statuses.includes('failed') || statuses.includes('skipped')));
}

// ---- Dialog ---------------------------------------------------------------

function closeDialog(message = null) {
  if (!session || session.busy) return;
  const current = session;
  closePreview(current);
  files.reset();
  session = null;
  $('batch-dialog').close();
  current.onClose(message);
}

// Everything that changes how pages go on paper.
function relayout() {
  if (!session) return;
  files.updateAllRows();
  rebuildPreview(session);
  refresh();
}

// A saved setup chosen from the list. Its printer may be gone; then the current one stays.
function applySetup(setup) {
  const printerFound = !setup.printer || session.printers.some((printer) => printer.name === setup.printer);
  applyPrintSettings('batch', { ...setup, printer: printerFound && setup.printer ? setup.printer : $('batch-printer').value });
  $('batch-per-sheet').value = String(setup.perSheet);
  $('batch-border').checked = setup.border;
  $('batch-printer-hint').hidden = !selectedPrinter()?.asksForFile;
  $('batch-sheets').classList.toggle('gray', $('batch-grayscale').checked);
  session.preview.setTwoSided(twoSided());
  relayout();
  return printerFound;
}

const setupPicker = new SetupPicker('batch', {
  current: () => ({ ...readSettings(), perSheet: perSheet(), border: $('batch-border').checked }),
  apply: applySetup,
  printerLabel: () => (session ? selectedPrinter()?.displayName ?? '' : ''),
  ignoreDirection: () => false,
});

// openPasswords(): the passwords of files open in the window, tried on locked files first.
// paths: files to start the list with. onSwitch: the user wants to print the one open
// file instead, called once this dialog has closed; null when no file is open.
export async function openBatchDialog({ openFiles, onClose, askPassword, openPasswords = () => [], paths = [], onSwitch = null }) {
  if (session) return;
  session = {
    printers: [],
    ready: false,
    busy: false,
    stopRequested: false,
    selected: null,
    printing: null,
    preview: sheetPreview,
    previewTask: null,
    previewDoc: null,
    openFiles,
    onClose,
    askPassword,
    onSwitch,
  };
  const current = session;

  files.reset();
  files.rememberPasswords(openPasswords());
  sheetPreview.resetZoom();
  $('batch-copies').value = 1;
  // Not remembered: a forgotten "4 per sheet" would shrink the next printout without warning.
  $('batch-per-sheet').value = '1';
  $('batch-border').checked = false;
  $('batch-printer').replaceChildren();
  $('batch-printer-hint').hidden = true;
  $('batch-add-open').hidden = openFiles().length === 0;
  $('batch-preview-name').textContent = '';
  showPreviewNote('');
  showStatus('');
  setupPicker.reset([]);
  setBusy(current, false);
  $('batch-mode-single').title = onSwitch ? '改成只印目前開著的那份檔案，可以選頁碼' : '要先開啟一份檔案，才能單獨印它';
  $('batch-dialog').showModal();
  if (paths.length > 0) files.add(paths);

  const options = await window.api.printOptions();
  if (session !== current) return;
  current.printers = options.printers;
  current.ready = true;
  fillPrinters($('batch-printer'), options.printers);
  applyPrintSettings('batch', options.settings);
  $('batch-printer-hint').hidden = !selectedPrinter()?.asksForFile;
  $('batch-sheets').classList.toggle('gray', $('batch-grayscale').checked);
  if (options.printers.length === 0) showStatus('找不到印表機，請先在 Windows 設定中新增。', true);
  files.updateAllRows();
  rebuildPreview(current);
  refresh();
  setupPicker.reset(options.setups);
}

function wire() {
  $('batch-close').addEventListener('click', () => closeDialog());
  $('batch-mode-single').addEventListener('click', () => {
    if (!session || session.busy || !session.onSwitch) return;
    const { onSwitch } = session;
    closeDialog();
    onSwitch();
  });
  $('batch-start').addEventListener('click', startBatch);
  $('batch-stop').addEventListener('click', () => {
    if (!session?.busy) return;
    session.stopRequested = true;
    $('batch-stop').disabled = true;
    showStatus('目前這個檔案處理完就停止。');
  });
  $('batch-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  $('batch-add').addEventListener('click', async () => {
    const paths = await window.api.pickPdfs();
    if (session && !session.busy) files.add(paths);
  });
  $('batch-add-open').addEventListener('click', () => {
    if (session) files.add(session.openFiles());
  });
  $('batch-printer').addEventListener('change', () => {
    if (!session) return;
    $('batch-printer-hint').hidden = !selectedPrinter()?.asksForFile;
    refresh();
  });
  $('batch-copies').addEventListener('input', refresh);
  for (const id of ['batch-scale', 'batch-paper', 'batch-per-sheet']) $(id).addEventListener('change', relayout);
  for (const input of document.querySelectorAll('input[name="batch-direction"]')) input.addEventListener('change', relayout);
  $('batch-duplex').addEventListener('change', () => {
    if (!session) return;
    session.preview.setTwoSided(twoSided());
    files.updateAllRows();
    refresh();
  });
  $('batch-border').addEventListener('change', () => {
    if (session) session.preview.setBorder($('batch-border').checked);
  });
  $('batch-grayscale').addEventListener('change', () => {
    $('batch-sheets').classList.toggle('gray', $('batch-grayscale').checked);
  });
  // The saved setup shown follows every change to the settings.
  $('batch-fields').addEventListener('change', () => {
    if (session?.ready) setupPicker.sync();
  });
}

wire();
