// Updating from GitHub, only when the user asks: the program never looks for a new
// version by itself. Checking, downloading and installing are three separate steps,
// each started by a button in the settings window.
//   load()            gives electron-updater's autoUpdater; only called on first use
//   isPackaged        false for a copy that was not installed, which cannot update itself
//   currentVersion    the version running now
//   canQuit()         false while closing would lose unsaved changes
//   onProgress(n)     download progress, 0 to 100

// "1.10.0" is newer than "1.9.3": compared number by number.
function isNewer(candidate, current) {
  const parts = (version) => String(version ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function createUpdater({ load, isPackaged, currentVersion, canQuit, onProgress }) {
  let updater = null;
  let found = null;
  let downloaded = null;
  let working = false;

  function get() {
    if (!updater) {
      updater = load();
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.on('download-progress', (progress) => onProgress(Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)))));
      // Failures are reported by the calls below; without a listener they would be thrown again.
      updater.on('error', () => {});
    }
    return updater;
  }

  async function check() {
    if (!isPackaged) return { status: 'NOT_INSTALLED', current: currentVersion };
    if (working) return { status: 'BUSY', current: currentVersion };
    working = true;
    try {
      const result = await get().checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!version || !isNewer(version, currentVersion)) return { status: 'LATEST', current: currentVersion };
      if (found !== version) downloaded = null;
      found = version;
      return { status: 'AVAILABLE', current: currentVersion, version, downloaded: downloaded === version };
    } catch (err) {
      console.warn('checking for an update failed:', err?.message ?? err);
      return { status: 'FAILED', current: currentVersion };
    } finally {
      working = false;
    }
  }

  async function download() {
    if (!found) return { ok: false, reason: 'NOTHING' };
    if (working) return { ok: false, reason: 'BUSY' };
    working = true;
    try {
      await get().downloadUpdate();
      downloaded = found;
      return { ok: true, version: found };
    } catch (err) {
      console.warn('downloading the update failed:', err?.message ?? err);
      return { ok: false, reason: 'FAILED' };
    } finally {
      working = false;
    }
  }

  // Closes the program, installs without asking anything more, and starts it again.
  function install() {
    if (!downloaded) return { ok: false, reason: 'NOT_READY' };
    if (!canQuit()) return { ok: false, reason: 'UNSAVED' };
    setImmediate(() => get().quitAndInstall(true, true));
    return { ok: true };
  }

  return { check, download, install };
}

module.exports = { createUpdater, isNewer };
