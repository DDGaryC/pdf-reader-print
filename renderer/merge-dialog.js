import { FileList } from './file-list.js';

const $ = (id) => document.getElementById(id);

const PROBLEM_PROTECTED = '此檔案受保護，無法整理頁面';
const FAILURES = {
  PROTECTED: (file) => `「${file}」受保護，無法整理頁面。`,
  BAD_IMAGE: (file) => `「${file}」不是能用的 JPG 或 PNG 圖片。`,
  CANNOT_READ: (file) => (file ? `無法讀取「${file}」，檔案可能已損毀或被移動。` : '無法合併這些檔案。'),
  SAME_FILE: () => '不能存到要合併的檔案上，請換一個檔名。',
  IN_USE: () => '這個檔案正在被其他程式使用，請先關閉後再試，或換一個檔名。',
  CANNOT_WRITE: () => '無法存檔，請確認資料夾可以寫入。',
};

let session = null;

function showStatus(message, isError = false) {
  const status = $('merge-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', isError);
}

const isImage = (item) => item.kind === 'image';

function summary(items) {
  if (items.length === 0) return '還沒有加入檔案';
  const checking = items.filter((item) => item.state === 'checking').length;
  if (checking > 0) return `正在檢查檔案，還剩 ${checking} 個…`;
  const good = items.filter((item) => !item.problem);
  const bad = items.length - good.length;
  const pictures = good.filter(isImage).length;
  const pdfs = good.length - pictures;
  const pages = good.reduce((sum, item) => sum + item.pages, 0);
  let total = `共 ${good.length} 個檔案、${pages} 頁`;
  if (pictures > 0) total = pdfs === 0 ? `共 ${pictures} 張圖片，會變成 ${pages} 頁` : `共 ${pdfs} 個 PDF、${pictures} 張圖片，合起來 ${pages} 頁`;
  if (bad === 0) return total;
  return `${total}；有 ${bad} 個不能${session?.mode === 'images' ? '轉換' : '合併'}，請先從清單移除`;
}

// A picture alone is enough to make a PDF; PDFs alone need at least two to merge.
function refresh() {
  if (!session) return;
  const { items } = files;
  $('merge-summary').textContent = summary(items);
  const enough = items.length >= 2 || (items.length === 1 && isImage(items[0]));
  const ready = enough && items.every((item) => item.state === 'ready' && !item.problem);
  $('merge-start').disabled = session.busy || !ready;
  const pictures = items.some(isImage);
  $('merge-paper-row').hidden = !pictures;
  $('merge-image-hint').hidden = !pictures;
  $('merge-limits').hidden = !items.some((item) => !isImage(item)) && session.mode === 'images';
}

function describeImage(item) {
  if (item.state === 'checking') return '檢查中…';
  if (item.problem) return '';
  return `圖片，${item.image.width} × ${item.image.height}`;
}

const files = new FileList({
  dialog: $('merge-dialog'),
  list: $('merge-list'),
  empty: $('merge-empty'),
  passwordProblem: PROBLEM_PROTECTED,
  acceptImages: true,
  describe: (item) => ({
    detail: isImage(item) ? describeImage(item) : item.state === 'checking' ? '檢查中…' : item.problem ? '' : `${item.pages} 頁`,
    notes: item.problem ? [{ text: item.problem, kind: 'error' }] : [],
  }),
  // Only the page count is needed. Leaving out a protected file without saying so
  // would give a merged file with pages missing, so it has to come off the list first.
  examine: (item) => {
    if (item.isProtected) item.problem = PROBLEM_PROTECTED;
  },
  isLocked: () => !session || session.busy,
  showStatus,
  onChange: refresh,
});

function setBusy(current, busy) {
  current.busy = busy;
  $('merge-add').disabled = busy;
  $('merge-add-open').disabled = busy;
  $('merge-close').disabled = busy;
  $('merge-image-paper').disabled = busy;
  files.setLocked(busy);
  refresh();
}

async function startMerge() {
  if (!session || $('merge-start').disabled) return;
  const current = session;
  current.resultPath = null;
  $('merge-open').hidden = true;
  setBusy(current, true);
  showStatus('處理中，請稍候…');
  const onlyImages = files.items.every(isImage);
  const result = await window.api.merge(
    files.items.map((item) => (isImage(item) ? { image: item.path } : item.file.id)),
    { imagePaper: $('merge-image-paper').value },
  );
  setBusy(current, false);
  if (result.ok) {
    current.resultPath = result.path;
    $('merge-open').hidden = false;
    showStatus(onlyImages ? `已轉成「${result.name}」，共 ${result.pages} 頁。` : `已合併成「${result.name}」，共 ${result.pages} 頁。`);
  } else if (result.reason === 'CANCELED') {
    showStatus('');
  } else {
    showStatus(FAILURES[result.reason]?.(result.file) ?? '無法合併這些檔案。', true);
  }
}

function closeDialog() {
  if (!session || session.busy) return;
  const current = session;
  files.reset();
  session = null;
  $('merge-dialog').close();
  current.onClose();
}

// mode 'merge' for PDFs (pictures allowed too), 'images' for making a PDF of pictures.
// paths: files to start with, such as pictures dropped on the window.
export function openMergeDialog({ mode = 'merge', paths = [], openFiles, onOpenResult, onClose }) {
  if (session) return;
  session = { mode, busy: false, resultPath: null, openFiles, onOpenResult, onClose };
  files.reset();
  const images = mode === 'images';
  $('merge-title').textContent = images ? '圖片轉 PDF' : '合併 PDF';
  $('merge-empty').textContent = images
    ? '把圖片（JPG、PNG）拖到這裡，或按右上角的「＋」加入。一張圖片一頁，可以拖曳調整順序'
    : '把 PDF 或圖片拖到這裡，或按右上角的「＋」加入檔案。可以拖曳調整順序';
  $('merge-start').textContent = images ? '轉成 PDF 並存檔' : '合併並存檔';
  $('merge-open').textContent = images ? '開啟轉好的 PDF' : '開啟合併結果';
  $('merge-add-open').hidden = images || openFiles().length === 0;
  $('merge-open').hidden = true;
  $('merge-image-paper').value = 'A4';
  showStatus('');
  setBusy(session, false);
  $('merge-dialog').showModal();
  if (paths.length > 0) files.add(paths);
}

function wire() {
  $('merge-close').addEventListener('click', closeDialog);
  $('merge-start').addEventListener('click', startMerge);
  $('merge-open').addEventListener('click', () => {
    if (!session?.resultPath) return;
    const { resultPath, onOpenResult } = session;
    closeDialog();
    onOpenResult(resultPath);
  });
  $('merge-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  $('merge-add').addEventListener('click', async () => {
    const paths = await window.api.pickPdfs(session?.mode === 'images' ? 'images' : 'both');
    if (session && !session.busy) files.add(paths);
  });
  $('merge-add-open').addEventListener('click', () => {
    if (session) files.add(session.openFiles());
  });
}

wire();
