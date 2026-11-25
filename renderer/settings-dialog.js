const $ = (id) => document.getElementById(id);

let onClosed = null;

function close() {
  const closed = onClosed;
  onClosed = null;
  $('settings-dialog').close();
  closed?.();
}

// ---- Updating: only ever started by these buttons ---------------------------

let updating = false;

function showUpdate(message, { isError = false, download = false, install = false, progress = null } = {}) {
  const status = $('update-status');
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', isError);
  $('update-download').hidden = !download;
  $('update-install').hidden = !install;
  $('update-bar').hidden = progress === null;
  if (progress !== null) $('update-bar').value = progress;
}

function setUpdating(busy) {
  updating = busy;
  for (const id of ['update-check', 'update-download', 'update-install']) $(id).disabled = busy;
}

async function checkForUpdate() {
  if (updating) return;
  setUpdating(true);
  showUpdate('正在檢查…');
  const result = await window.api.checkForUpdate().catch(() => ({ status: 'FAILED' }));
  setUpdating(false);
  if (result.status === 'AVAILABLE' && result.downloaded) {
    showUpdate(`新版 ${result.version} 已經下載好了。按「重新啟動並安裝」，程式會關掉、裝好新版再自己打開。`, { install: true });
  } else if (result.status === 'AVAILABLE') {
    showUpdate(`有新版 ${result.version} 可以更新（目前是 ${result.current}）。`, { download: true });
  } else if (result.status === 'LATEST') {
    showUpdate(`已經是最新版（${result.current}）。`);
  } else if (result.status === 'NOT_INSTALLED') {
    showUpdate('這份不是用安裝程式裝的，沒辦法自己更新。', { isError: true });
  } else {
    showUpdate('檢查不到，請確認網路有連線後再試一次。', { isError: true });
  }
}

async function downloadUpdate() {
  if (updating) return;
  setUpdating(true);
  showUpdate('正在下載新版…', { progress: 0 });
  const result = await window.api.downloadUpdate().catch(() => ({ ok: false }));
  setUpdating(false);
  if (result.ok) {
    showUpdate(`新版 ${result.version} 下載好了。按「重新啟動並安裝」，程式會關掉、裝好新版再自己打開。`, { install: true });
  } else {
    showUpdate('下載失敗，請確認網路有連線後再試一次。', { isError: true, download: true });
  }
}

async function installUpdate() {
  if (updating) return;
  const result = await window.api.installUpdate().catch(() => ({ ok: false }));
  if (result.ok) {
    setUpdating(true);
    showUpdate('正在關閉程式並安裝新版，裝好會自己打開…');
  } else if (result.reason === 'UNSAVED') {
    showUpdate('頁面整理還有沒儲存的變更。請先儲存或放棄，再按一次「重新啟動並安裝」。', { isError: true, install: true });
  } else {
    showUpdate('還不能安裝，請再按一次「檢查更新」。', { isError: true });
  }
}

export async function openSettingsDialog(onClose) {
  if (onClosed) return;
  onClosed = onClose;
  if (!updating) showUpdate('');
  $('settings-dialog').showModal();
  const mode = await window.api.openIn();
  document.querySelector(`input[name="settings-open-in"][value="${mode}"]`).checked = true;
  const version = await window.api.appVersion();
  $('settings-version').textContent = version;
  $('update-current').textContent = version;
}

function wire() {
  $('settings-close').addEventListener('click', close);
  $('settings-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  $('settings-default-apps').addEventListener('click', () => window.api.openDefaultApps());
  $('update-check').addEventListener('click', checkForUpdate);
  $('update-download').addEventListener('click', downloadUpdate);
  $('update-install').addEventListener('click', installUpdate);
  window.api.onUpdateProgress((percent) => {
    if (!updating || $('update-bar').hidden) return;
    $('update-bar').value = percent;
    $('update-status').textContent = `正在下載新版… ${percent}%`;
  });
  for (const input of document.querySelectorAll('input[name="settings-open-in"]')) {
    input.addEventListener('change', () => window.api.setOpenIn(input.value));
  }
}

wire();
