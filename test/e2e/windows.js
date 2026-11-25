// One window for each file, driven in the real app. Every window stays hidden. A file opened
// from outside is simulated by the event a second copy of the program would cause.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function runWindowTests(ctx) {
  const { app, BrowserWindow, check, click, fixture, heldFiles, js, openFiles, pause, saveParent, setPicked, setSaveTarget, tabCount, userData, waitFor, win } = ctx;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `${ctx.tempPrefix}windows-`));
  const copy = (from, name) => {
    fs.copyFileSync(fixture(from), path.join(folder, name));
    return path.join(folder, name);
  };
  const [fileA, fileB, fileC, fileD, fileE, fileF] = [
    copy('mixed.pdf', 'a.pdf'), copy('square.pdf', 'b.pdf'), copy('small-page.pdf', 'c.pdf'),
    copy('prerotated.pdf', 'd.pdf'), copy('square.pdf', 'e.pdf'), copy('mixed.pdf', 'f.pdf'),
  ];

  const pageErrors = [];
  const watch = (_event, created) => created.webContents.on('console-message', (details) => {
    if (details.level === 'error') pageErrors.push(details.message);
  });
  app.on('browser-window-created', watch);

  const heldBefore = heldFiles.size;
  const tabsBefore = await tabCount();
  const all = () => BrowserWindow.getAllWindows();
  const jsIn = (target, code) => target.webContents.executeJavaScript(code);
  const waitIn = async (target, code, label, timeout = 20000) => {
    const start = Date.now();
    for (;;) {
      const answer = await jsIn(target, code).catch(() => false);
      if (answer) return answer;
      if (Date.now() - start > timeout) {
        check(`waited for ${label}`, false, 'timed out');
        return false;
      }
      await pause(80);
    }
  };
  const waitCount = async (count, label) => {
    const start = Date.now();
    while (all().length !== count) {
      if (Date.now() - start > 20000) {
        check(`waited for ${label}`, false, `${all().length} windows, wanted ${count}`);
        return;
      }
      await pause(80);
    }
  };
  const showing = async (name) => {
    for (const candidate of all()) {
      if ((await jsIn(candidate, `[...document.querySelectorAll('.tab-name')].map((n) => n.textContent)`)).includes(name)) return candidate;
    }
    return null;
  };
  const waitShowing = async (name) => {
    const start = Date.now();
    for (;;) {
      const found = await showing(name);
      if (found) return found;
      if (Date.now() - start > 20000) {
        check(`waited for a window with ${name}`, false, 'timed out');
        return win;
      }
      await pause(80);
    }
  };
  const tabsIn = (target) => jsIn(target, `document.querySelectorAll('.tab').length`);
  const titleIn = (target) => jsIn(target, 'document.title');
  const openFromOutside = (file) => app.emit('second-instance', {}, ['PDF閱讀列印.exe', file], process.cwd());
  const pressIn = (target, key, extra = {}) => jsIn(target, `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, ...extra })}))`);
  const savedMode = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).openIn;
  const setMode = async (target, mode) => {
    await jsIn(target, `document.getElementById('btn-settings').click()`);
    await waitIn(target, `document.getElementById('settings-dialog').open && document.getElementById('settings-version').textContent !== ''`, 'settings');
    await jsIn(target, `document.querySelector('input[name="settings-open-in"][value="${mode}"]').click()`);
    await pause(150);
    await jsIn(target, `document.getElementById('settings-close').click()`);
  };

  // ---- The setting
  await click('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open && document.querySelector('input[name="settings-open-in"]:checked')`, 'the setting');
  check('windows: the setting shows the current choice', (await js(`document.querySelector('input[name="settings-open-in"]:checked').value`)) === 'tab');
  await click('settings-close');
  await setMode(win, 'window');
  check('windows: the choice is saved', savedMode() === 'window', String(savedMode()));

  // ---- Files from outside
  openFromOutside(fileA);
  await waitCount(2, 'a window for the first file');
  const windowA = await waitShowing('a.pdf');
  check('windows: a file gets its own window', windowA !== win && all().length === 2);
  check('windows: it stays out of the other window', (await tabCount()) === tabsBefore);
  check('windows: test windows stay hidden', !windowA.isVisible());
  await waitIn(windowA, `!document.getElementById('btn-organize').disabled`, 'the file to load');
  check('windows: the file shows', (await titleIn(windowA)).startsWith('a.pdf'), await titleIn(windowA));
  check('windows: no tab bar for a single file', await jsIn(windowA, `document.getElementById('tabbar').hidden && !document.body.classList.contains('no-doc')`));

  openFromOutside(fileB);
  await waitCount(3, 'a window for the second file');
  const windowB = await waitShowing('b.pdf');
  check('windows: another file gets another window', windowB !== windowA);

  openFromOutside(fileA);
  await pause(300);
  check('windows: a file already open does not get a second window', all().length === 3 && (await tabsIn(windowA)) === 1);
  openFromOutside(fileA.toUpperCase());
  await pause(300);
  check('windows: whatever the case of its name', all().length === 3 && (await tabsIn(windowA)) === 1);

  // A file showing in a tab of the first window goes to that tab.
  openFiles([fixture('mixed.pdf')]);
  await waitFor(`document.title.startsWith('mixed.pdf')`, 'mixed.pdf in the first window');
  openFiles([fixture('square.pdf')]);
  await waitFor(`document.title.startsWith('square.pdf')`, 'square.pdf in the first window');
  await pause(100);
  openFromOutside(fixture('mixed.pdf'));
  await waitFor(`document.title.startsWith('mixed.pdf')`, 'the tab holding it');
  check('windows: a file in a tab goes to that tab', all().length === 3 && (await js('document.title')).startsWith('mixed.pdf'));

  // ---- The Open button
  setPicked([fileC]);
  await jsIn(windowA, `document.getElementById('btn-open').click()`);
  await waitCount(4, 'a window from the Open button');
  const windowC = await waitShowing('c.pdf');
  check('windows: Open makes a new window too', windowC !== windowA && (await tabsIn(windowA)) === 1);
  await waitIn(windowC, `!document.getElementById('btn-print').disabled`, 'the third file');

  await pressIn(windowC, 'w', { ctrlKey: true });
  await waitIn(windowC, `!document.getElementById('empty-state').hidden`, 'an empty window');
  await pause(100);
  setPicked([fileD]);
  await jsIn(windowC, `document.getElementById('btn-open').click()`);
  await waitIn(windowC, `document.title.startsWith('d.pdf')`, 'the empty window being used');
  check('windows: an empty window is used instead of making another', all().length === 4);
  await pressIn(windowC, 'w', { ctrlKey: true });
  await waitIn(windowC, `!document.getElementById('empty-state').hidden`, 'empty again');
  await pause(100);
  openFromOutside(fileD);
  await waitIn(windowC, `document.title.startsWith('d.pdf')`, 'the empty window being used from outside');
  check('windows: from outside too', all().length === 4);

  // A file that cannot open leaves its window empty, ready for the next file.
  openFromOutside(fixture('corrupt.pdf'));
  await waitCount(5, 'a window for the bad file');
  const windowBad = all().find((candidate) => ![win, windowA, windowB, windowC].includes(candidate));
  await waitIn(windowBad, `document.getElementById('toast').textContent.includes('無法開啟')`, 'the reason');
  check('windows: a bad file explains itself in its window', (await jsIn(windowBad, `document.getElementById('toast').textContent`)).includes('corrupt.pdf'));
  await pause(200);
  openFromOutside(fileE);
  await waitIn(windowBad, `document.title.startsWith('e.pdf')`, 'the next file in that window');
  check('windows: that window is then used for the next file', all().length === 5);
  await waitIn(windowBad, `!document.getElementById('btn-print').disabled`, 'the next file to load');

  // ---- Each window on its own
  setSaveTarget(path.join(folder, 'saved.pdf'));
  await jsIn(windowC, `document.getElementById('btn-save').click()`);
  await waitIn(windowC, `document.getElementById('toast').textContent.includes('saved.pdf')`, 'saving from another window');
  check('windows: Save As belongs to the window that asked', saveParent() === windowC);
  check('windows: and the file is written', fs.existsSync(path.join(folder, 'saved.pdf')));
  await jsIn(windowC, `document.getElementById('btn-print').click()`);
  await waitIn(windowC, `document.getElementById('print-dialog').open && document.getElementById('print-printer').options.length > 0`, 'printing from another window', 40000);
  check('windows: printing works from another window', true);
  await jsIn(windowC, `document.getElementById('print-cancel').click()`);
  await waitIn(windowC, `!document.getElementById('print-dialog').open`, 'print dialog closed');

  // Closing a window lets go of its files and leaves the others alone.
  const heldWithB = heldFiles.size;
  windowB.close();
  await waitCount(4, 'one window closing');
  await pause(200);
  check('windows: closing one lets go of its file', heldFiles.size === heldWithB - 1, `${heldWithB} -> ${heldFiles.size}`);
  check('windows: the others stay', !win.isDestroyed() && !windowA.isDestroyed() && (await titleIn(windowA)).startsWith('a.pdf'));
  openFromOutside(fileB);
  await waitCount(5, 'the file opening again');
  const windowB2 = await waitShowing('b.pdf');
  check('windows: a closed file can open again', windowB2 !== win && !windowB.isDestroyed === false);
  await waitIn(windowB2, `!document.getElementById('btn-print').disabled`, 'the file loading again');

  // On a computer without PDFgear the button is simply not there, and nothing else changes.
  ctx.setNoPdfgear(true);
  openFromOutside(fileF);
  await waitCount(6, 'a window on a computer without PDFgear');
  const windowNoGear = await waitShowing('f.pdf');
  ctx.setNoPdfgear(false);
  await waitIn(windowNoGear, `!document.getElementById('btn-print').disabled`, 'the file loading without PDFgear');
  await pause(300);
  check('no pdfgear: no button', await jsIn(windowNoGear, `document.getElementById('btn-pdfgear').hidden && document.getElementById('btn-pdfgear').offsetWidth === 0`));
  windowNoGear.setSize(1280, 800);
  await waitIn(windowNoGear, 'window.innerWidth > 1200', 'the wider window');
  const noGearLayout = await jsIn(windowNoGear, `(() => {
    const r = document.querySelector('#toolbar .bar-center').getBoundingClientRect();
    return { middle: (r.left + r.right) / 2, screen: document.documentElement.clientWidth / 2 };
  })()`);
  check('no pdfgear: the main tools stay in the middle', Math.abs(noGearLayout.middle - noGearLayout.screen) < 3, JSON.stringify(noGearLayout));
  check('no pdfgear: everything else is ready', await jsIn(windowNoGear, `['btn-open', 'btn-save', 'btn-print', 'btn-rotate-left', 'btn-rotate-right', 'btn-find', 'btn-organize', 'btn-merge', 'btn-split'].every((id) => !document.getElementById(id).disabled)`));
  windowNoGear.close();
  await waitCount(5, 'that window closing');

  // Unsaved changes ask only in the window that has them.
  await jsIn(windowA, `document.getElementById('btn-organize').click()`);
  await waitIn(windowA, `document.body.classList.contains('organizing') && document.querySelectorAll('.organize-pane.active .organize-cell').length === 4`, 'organizing in another window');
  await pressIn(windowA, 'a', { ctrlKey: true });
  await jsIn(windowA, `document.getElementById('org-right').click()`);
  check('windows: the mark shows in the title without a tab bar', (await titleIn(windowA)).startsWith('● '), await titleIn(windowA));
  await pause(100);
  windowA.close();
  await waitIn(windowA, `document.getElementById('organize-dialog').open`, 'asked in that window');
  check('windows: closing it asks there', !windowA.isDestroyed() && all().length === 5);
  check('windows: not in the others', !(await js(`document.getElementById('organize-dialog').open`)));
  await jsIn(windowA, `document.getElementById('org-dialog-cancel').click()`);
  await pause(200);
  check('windows: cancel keeps it', !windowA.isDestroyed());
  await jsIn(windowA, `document.getElementById('org-exit').click()`);
  await waitIn(windowA, `document.getElementById('organize-dialog').open`, 'asked when leaving');
  await jsIn(windowA, `document.getElementById('org-dialog-discard').click()`);
  await waitIn(windowA, `!document.body.classList.contains('organizing')`, 'left without saving');

  // The menu closes only its own window.
  await jsIn(windowBad, `document.getElementById('menu-close').click()`);
  await waitCount(4, 'the menu closing a window');
  check('windows: the menu closes that window only', !win.isDestroyed() && !windowC.isDestroyed());

  // ---- Back to tabs, with windows open
  await setMode(windowC, 'tab');
  await waitIn(windowC, `!document.getElementById('tabbar').hidden`, 'the tab bar coming back');
  check('windows: the choice reaches every window', savedMode() === 'tab' && (await jsIn(windowA, `!document.getElementById('tabbar').hidden`)));
  const countBefore = all().length;
  openFromOutside(fileF);
  await waitShowing('f.pdf');
  const holder = await showing('f.pdf');
  check('windows: with tabs chosen, a file joins an open window', all().length === countBefore && (await tabsIn(holder)) >= 2, `${all().length} windows, ${await tabsIn(holder)} tabs`);
  await waitIn(holder, `!document.getElementById('btn-print').disabled`, 'the new tab loading');
  await jsIn(holder, `[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'f.pdf').querySelector('.tab-close').click()`);

  // ---- Leaving things as they were
  for (const other of all().filter((candidate) => candidate !== win)) other.close();
  await waitCount(1, 'only the first window left');
  await pause(300);
  app.off('browser-window-created', watch);
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'square.pdf')?.click()`);
  const tabsAfter = await tabCount();
  check('windows: only the files in the first window stay open', heldFiles.size === heldBefore + (tabsAfter - tabsBefore), `${heldFiles.size - heldBefore} extra, ${tabsAfter - tabsBefore} tabs`);
  check('windows: no errors in the other windows', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};
