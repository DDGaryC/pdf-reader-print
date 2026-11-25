import { leftOutPages, splitPlan } from './split-plan.js';

const $ = (id) => document.getElementById(id);

const NAMES_SHOWN = 6;
const FAILURES = {
  PROTECTED: '此檔案受保護，無法整理頁面。',
  CANNOT_READ: '無法讀取這個檔案，它可能已損毀或被移動。',
  CANNOT_WRITE: '無法寫入這個資料夾，請換一個資料夾。',
};
// Only the numbering a taken name gets can come right before the extension like this.
const NUMBERED_NAME = / \(\d+\)\.pdf$/;

let session = null;

const stemOf = (name) => name.replace(/\.pdf$/i, '');
const folderOf = (filePath) => filePath.slice(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')));

function showStatus(message, isError = false) {
  const status = $('split-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', isError);
}

function currentPlan() {
  const { view } = session;
  const mode = document.querySelector('input[name="split-mode"]:checked').value;
  const value = mode === 'every' ? $('split-every').value : $('split-ranges').value;
  return splitPlan(mode, value, view.pageCount);
}

function refresh() {
  if (!session) return;
  const { view, blocked, busy } = session;
  const plan = currentPlan();
  session.plan = plan;
  $('split-error').textContent = plan.ok ? '' : plan.message;
  $('split-error').hidden = plan.ok;
  $('split-start').disabled = busy || blocked || !plan.ok;

  const names = $('split-plan-names');
  names.replaceChildren();
  if (!plan.ok) {
    $('split-plan-count').textContent = '';
    return;
  }
  const leftOut = leftOutPages(plan.parts, view.pageCount);
  $('split-plan-count').textContent = `會拆成 ${plan.parts.length} 個檔案${leftOut > 0 ? `，有 ${leftOut} 頁不在範圍內，不會輸出` : ''}`;
  const stem = stemOf(view.file.name);
  for (const part of plan.parts.slice(0, NAMES_SHOWN)) {
    const name = document.createElement('li');
    name.textContent = `${stem}_${part.suffix}.pdf`;
    names.append(name);
  }
  if (plan.parts.length > NAMES_SHOWN) {
    const more = document.createElement('li');
    more.textContent = `…還有 ${plan.parts.length - NAMES_SHOWN} 個`;
    names.append(more);
  }
}

function setBusy(current, busy) {
  current.busy = busy;
  $('split-fields').disabled = busy;
  $('split-close').disabled = busy;
  $('split-progress').hidden = !busy;
  refresh();
}

function showResult(result, total) {
  if (result.ok) {
    const renamed = result.names.filter((name) => NUMBERED_NAME.test(name)).length;
    showStatus(`已拆成 ${result.names.length} 個檔案。${renamed > 0 ? `其中 ${renamed} 個檔名已存在，自動加了編號，原本的檔案沒有被覆蓋。` : ''}`);
    $('split-open-folder').hidden = false;
    return;
  }
  const reason = FAILURES[result.reason] ?? '無法拆分這個檔案。';
  showStatus(result.written > 0 ? `${reason}已存出 ${total} 個裡的 ${result.written} 個。` : reason, true);
  $('split-open-folder').hidden = !(result.written > 0);
}

async function startSplit() {
  if (!session || $('split-start').disabled) return;
  const current = session;
  const { parts } = current.plan;
  $('split-open-folder').hidden = true;
  $('split-bar').max = parts.length;
  $('split-bar').value = 0;
  $('split-progress-text').textContent = `正在拆分 0 / ${parts.length}`;
  showStatus('');
  setBusy(current, true);
  const result = await window.api.split({ fileId: current.view.file.id, parts, folder: current.folder });
  setBusy(current, false);
  showResult(result, parts.length);
}

function closeDialog() {
  if (!session || session.busy) return;
  const current = session;
  session = null;
  $('split-dialog').close();
  current.onClose();
}

export async function openSplitDialog(view, { onClose }) {
  if (session || !view?.ready) return;
  session = { view, onClose, busy: false, blocked: true, folder: null, plan: null };
  const current = session;

  document.querySelector('input[name="split-mode"][value="each"]').checked = true;
  $('split-every').value = 2;
  $('split-ranges').value = '';
  $('split-file').textContent = `${view.file.name}（共 ${view.pageCount} 頁）`;
  $('split-file').title = view.file.path;
  $('split-folder-path').textContent = folderOf(view.file.path);
  $('split-folder-path').title = folderOf(view.file.path);
  $('split-open-folder').hidden = true;
  $('split-progress').hidden = true;
  $('split-notice').hidden = true;
  $('split-rotation-note').hidden = view.rotation === 0;
  $('split-fields').disabled = false;
  showStatus('');
  refresh();
  $('split-dialog').showModal();

  const info = await view.printInfo();
  if (session !== current) return;
  current.blocked = info.isProtected || info.needsOpenPassword;
  $('split-notice').textContent = FAILURES.PROTECTED;
  $('split-notice').hidden = !current.blocked;
  refresh();
}

function wire() {
  $('split-close').addEventListener('click', closeDialog);
  $('split-start').addEventListener('click', startSplit);
  $('split-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  $('split-open-folder').addEventListener('click', () => window.api.openOutputFolder());
  $('split-folder-pick').addEventListener('click', async () => {
    if (!session) return;
    const shown = $('split-folder-path').textContent;
    const folder = await window.api.pickFolder(shown);
    if (session && folder) {
      session.folder = folder;
      $('split-folder-path').textContent = folder;
      $('split-folder-path').title = folder;
    }
  });
  for (const input of document.querySelectorAll('input[name="split-mode"]')) {
    input.addEventListener('change', refresh);
  }
  // Typing in a box means that way of splitting.
  for (const [id, mode] of [['split-every', 'every'], ['split-ranges', 'ranges']]) {
    const select = () => {
      document.querySelector(`input[name="split-mode"][value="${mode}"]`).checked = true;
      refresh();
    };
    $(id).addEventListener('focus', select);
    $(id).addEventListener('input', select);
  }
  window.api.onSplitProgress((done, total) => {
    if (!session?.busy) return;
    $('split-bar').max = total;
    $('split-bar').value = done;
    $('split-progress-text').textContent = `正在拆分 ${done} / ${total}`;
  });
}

wire();
