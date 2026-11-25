// Version 1.4, driven in the real app with its window hidden: saved print setups, printing
// files that need a password, recent files, bookmarks, two pages side by side, document
// information, and pictures made into a PDF. Called from run.js, which catches the start
// of Sumatra (nothing is printed) and answers the file and Save As windows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const { PDFDocument } = require('@cantoo/pdf-lib');

module.exports = async function runFeatures14Tests(ctx) {
  const {
    app, check, click, fixture, js, openFiles, pause, press, printCalls, setPicked, setSaveTarget, shot, tabCount,
    tempPrefix, text, updater, userData, value, waitFor,
  } = ctx;

  const settings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  const setSelect = (id, v) => js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const setCheck = (id, on) => js(`(() => { const c = document.getElementById(${JSON.stringify(id)}); c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const hidden = (id) => js(`document.getElementById(${JSON.stringify(id)}).hidden`);
  const disabled = (id) => js(`document.getElementById(${JSON.stringify(id)}).disabled`);
  const showTab = async (name) => {
    openFiles([fixture(name)]);
    await waitFor(`document.title.startsWith(${JSON.stringify(name)}) && !document.getElementById('btn-print').disabled`, `tab ${name}`);
  };
  const closeTab = async () => {
    const before = await tabCount();
    await press('w', { ctrlKey: true });
    await waitFor(`document.querySelectorAll('.tab').length === ${before - 1}`, 'closing a tab');
  };
  const openPrint = async () => {
    await click('btn-print');
    await waitFor(`document.getElementById('print-dialog').open && document.getElementById('print-printer').options.length > 0 && document.querySelectorAll('.sheet-item').length > 0`, 'print dialog ready');
  };
  const closePrint = async () => {
    await click('print-cancel');
    await waitFor(`!document.getElementById('print-dialog').open`, 'print dialog closed');
  };
  const openBatch = async () => {
    await press('p', { ctrlKey: true, shiftKey: true });
    await waitFor(`document.getElementById('batch-dialog').open && document.getElementById('batch-printer').options.length > 0`, 'batch dialog ready');
  };
  const closeBatch = async () => {
    await click('batch-close');
    await waitFor(`!document.getElementById('batch-dialog').open`, 'batch dialog closed');
  };
  const addToBatch = async (files, count) => {
    setPicked(files);
    await click('batch-add');
    await waitFor(`document.querySelectorAll('#batch-list .file-row').length === ${count} && !document.getElementById('batch-summary').textContent.includes('還剩')`, `batch list of ${count}`, 40000);
  };
  const batchRows = () => js(`[...document.querySelectorAll('#batch-list .file-row')].map((row) => ({
    name: row.querySelector('.file-name').textContent,
    detail: row.querySelector('.file-detail').textContent,
    notes: row.querySelector('.file-notes').textContent,
    action: row.querySelector('.file-action').hidden ? '' : row.querySelector('.file-action').title,
  }))`);
  const answerPassword = async (password) => {
    await waitFor(`document.getElementById('password-dialog').open`, 'password prompt');
    await js(`document.getElementById('password-input').value = ${JSON.stringify(password)}; document.getElementById('password-ok').click()`);
  };
  const printTemp = path.join(app.getPath('temp'), 'pdf-reader-print');
  const tempFiles = () => (fs.existsSync(printTemp) ? fs.readdirSync(printTemp).filter((name) => /^print-.*\.pdf$/.test(name)) : []);
  const nextPrintCall = async (after, label) => {
    const start = Date.now();
    while (printCalls.length <= after) {
      if (Date.now() - start > 20000) {
        check(`waited for ${label}`, false, 'timed out');
        return null;
      }
      await pause(50);
    }
    return printCalls[after];
  };

  const tabsAtStart = await tabCount();
  await showTab('mixed.pdf');

  // ---- Saved print setups ---------------------------------------------------
  await openPrint();
  await waitFor(`document.getElementById('print-setup').options.length === 1`, 'the empty list of setups');
  check('setups: the list starts empty and says so', (await js(`document.getElementById('print-setup').options[0].textContent`)) === '（還沒有常用設定）');
  check('setups: nothing to delete yet', await disabled('print-setup-delete'));
  check('setups: save and delete are pictures that say what they are', await js(`['print-setup-save', 'print-setup-delete', 'batch-setup-save', 'batch-setup-delete'].every((id) => {
    const b = document.getElementById(id);
    return b.querySelector('svg') && b.textContent.trim() === '' && b.title.length > 4 && b.getAttribute('aria-label').length > 4;
  })`));
  await setSelect('print-per-sheet', '2');
  await setSelect('print-duplex', 'duplexshort');
  await setCheck('print-border', true);
  await click('print-setup-save');
  check('setups: saving asks for a name', !(await hidden('print-setup-form')) && (await hidden('print-setup-actions')));
  const suggested = await value('print-setup-name');
  check('setups: and suggests one from the settings', suggested.endsWith('每張 2 頁、雙面短邊'), suggested);
  check('setups: the name box has the keyboard', (await js('document.activeElement.id')) === 'print-setup-name');
  check('setups: saving and giving up are a tick and a cross', await js(`['print-setup-ok', 'print-setup-cancel', 'batch-setup-ok', 'batch-setup-cancel'].every((id) => {
    const b = document.getElementById(id);
    return b.querySelector('svg') && b.textContent.trim() === '' && b.title.length > 2 && b.getAttribute('aria-label').length > 1;
  })`));
  await click('print-setup-cancel');
  check('setups: the cross closes the name box', (await hidden('print-setup-form')) && !(await hidden('print-setup-actions')));
  await click('print-setup-save');
  await js(`document.getElementById('print-setup-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  check('setups: Esc in the name box closes only that box', (await hidden('print-setup-form')) && (await js(`document.getElementById('print-dialog').open`)));
  await click('print-setup-save');
  await js(`document.getElementById('print-setup-name').value = '  發票雙面 '`);
  await js(`document.getElementById('print-setup-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await waitFor(`document.getElementById('print-setup').value === '發票雙面'`, 'the saved setup');
  check('setups: the new setup is chosen and can be deleted', !(await disabled('print-setup-delete')) && (await hidden('print-setup-form')));
  check('setups: says it was saved', (await text('print-setup-note')).includes('已存成「發票雙面」'), await text('print-setup-note'));
  const saved = settings().printSetups;
  check('setups: kept in the settings file', saved.length === 1 && saved[0].name === '發票雙面' && saved[0].perSheet === 2 && saved[0].duplex === 'duplexshort' && saved[0].border === true && typeof saved[0].printer === 'string', JSON.stringify(saved));
  check('setups: copies and page range are not part of it', !('copies' in saved[0]) && !('pages' in saved[0]));

  await setSelect('print-duplex', 'simplex');
  check('setups: changing a setting shows no setup as chosen', (await value('print-setup')) === '' && (await disabled('print-setup-delete')));
  await setSelect('print-per-sheet', '1');
  await setSelect('print-setup', '發票雙面');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 2 && document.getElementById('print-summary').textContent.includes('雙面印')`, 'the setup applied');
  check('setups: choosing one puts every setting back', (await value('print-per-sheet')) === '2' && (await value('print-duplex')) === 'duplexshort' && (await js(`document.getElementById('print-border').checked`)) && !(await hidden('print-border-row')));
  check('setups: and the preview follows', (await text('print-summary')).startsWith('共 4 頁，每張紙印 2 頁，雙面印，要用 1 張紙'), await text('print-summary'));
  check('setups: it stays chosen', (await value('print-setup')) === '發票雙面');
  await shot('80-setup-print');
  await closePrint();

  await openPrint();
  check('setups: pages per sheet still start at one on the next print', (await value('print-per-sheet')) === '1' && (await value('print-setup')) === '');
  check('setups: the list is there the next time', (await js(`document.getElementById('print-setup').options.length`)) === 2);
  await closePrint();

  await openBatch();
  await waitFor(`document.getElementById('batch-setup').options.length === 2`, 'setups in batch print');
  await setSelect('batch-setup', '發票雙面');
  check('setups: batch print shares them', (await value('batch-per-sheet')) === '2' && (await value('batch-duplex')) === 'duplexshort' && (await js(`document.getElementById('batch-border').checked`)) && !(await hidden('batch-per-sheet-hint')));
  await setCheck('batch-grayscale', true);
  check('setups: batch shows none chosen after a change', (await value('batch-setup')) === '');
  await click('batch-setup-save');
  await js(`document.getElementById('batch-setup-name').value = '發票雙面'`);
  await click('batch-setup-ok');
  await waitFor(`document.getElementById('batch-setup-note').textContent.includes('已更新')`, 'replacing a setup');
  check('setups: the same name replaces the old one', settings().printSetups.length === 1 && settings().printSetups[0].grayscale === true);
  await click('batch-setup-delete');
  check('setups: deleting asks once more, the bin turning red', (await js(`document.getElementById('batch-setup-delete').classList.contains('danger') && document.getElementById('batch-setup-delete').title.includes('確定刪除')`)) && (await text('batch-setup-note')).includes('再按一次') && settings().printSetups.length === 1);
  await click('batch-setup-delete');
  await waitFor(`document.getElementById('batch-setup').options.length === 1`, 'the setup deleted');
  check('setups: then it is gone', settings().printSetups.length === 0 && !(await js(`document.getElementById('batch-setup-delete').classList.contains('danger')`)) && (await text('batch-setup-note')).includes('已刪除'));
  await setCheck('batch-grayscale', false);
  await setSelect('batch-per-sheet', '1');
  await setSelect('batch-duplex', 'simplex');
  await closeBatch();

  await js(`window.api.savePrintSetup({ name: '別台印表機', printer: '已經不在的印表機', duplex: 'duplexlong', perSheet: 4 })`);
  await openPrint();
  const printerBefore = await value('print-printer');
  await setSelect('print-setup', '別台印表機');
  await waitFor(`document.getElementById('print-setup-note').textContent.includes('找不到印表機')`, 'the note about a missing printer');
  check('setups: a printer that is gone keeps the current one, with a word', (await value('print-printer')) === printerBefore && (await value('print-duplex')) === 'duplexlong' && (await value('print-per-sheet')) === '4', await text('print-setup-note'));
  await setSelect('print-duplex', 'simplex');
  await setSelect('print-per-sheet', '1');
  await closePrint();
  await js(`window.api.deletePrintSetup('別台印表機')`);

  // ---- One file or many: each print window leads to the other -------------------
  await showTab('mixed.pdf');
  await openPrint();
  check('switch: the print window shows it is for one file', await js(`document.getElementById('print-mode-single').classList.contains('on') && !document.getElementById('print-mode-batch').classList.contains('on') && !document.getElementById('print-mode-batch').disabled`));
  await click('print-mode-batch');
  await waitFor(`document.getElementById('batch-dialog').open && document.querySelectorAll('#batch-list .file-row').length === 1 && !document.getElementById('batch-summary').textContent.includes('還剩')`, 'batch print from the print window');
  check('switch: batch print opens with this file on its list', !(await js(`document.getElementById('print-dialog').open`)) && (await batchRows())[0].name === 'mixed.pdf');
  check('switch: batch print shows it is for many', await js(`document.getElementById('batch-mode-batch').classList.contains('on') && !document.getElementById('batch-mode-single').disabled`));
  await click('batch-mode-single');
  await waitFor(`document.getElementById('print-dialog').open && document.querySelectorAll('.sheet-item').length === 4`, 'the print window from batch print');
  check('switch: and back to printing the one file', !(await js(`document.getElementById('batch-dialog').open`)) && (await text('print-all-label')) === '全部（共 4 頁）');
  await closePrint();
  check('switch: nothing was printed by switching', printCalls.every((one) => typeof one.finish === 'function'));

  // ---- Printing a file that needs a password ----------------------------------
  openFiles([fixture('enc-aes-password.pdf')]);
  await answerPassword('test1234');
  await waitFor(`document.title.startsWith('enc-aes-password') && document.getElementById('page-total').textContent === '/ 2'`, 'the locked file open');
  await openPrint();
  await waitFor(`!document.getElementById('print-start').disabled`, 'print ready for the locked file');
  check('locked: the print button works for a file opened with its password', !(await disabled('print-start')));
  check('locked: nothing says to remove the password first', !(await js(`document.getElementById('print-notices').textContent`)).includes('密碼'));
  check('locked: it turns one way only, like other protected files', await js(`document.querySelector('input[name="print-direction"][value="clockwise"]').disabled`));
  let callsBefore = printCalls.length;
  const leftBefore = tempFiles().length;
  await click('print-start');
  let call = await nextPrintCall(callsBefore, 'printing the locked file');
  if (call) {
    const sent = call.args.at(-1);
    check('locked: Sumatra gets a temporary copy, not the locked file', path.dirname(sent) === printTemp && /^print-.*\.pdf$/.test(path.basename(sent)), sent);
    const copy = await PDFDocument.load(fs.readFileSync(sent)).catch((err) => err);
    check('locked: the copy opens without a password and has every page', copy instanceof PDFDocument && copy.getPageCount() === 2, String(copy?.message ?? ''));
    check('locked: the copy carries no lock', !fs.readFileSync(sent).toString('latin1').includes('/Encrypt'));
    call.finish(0);
    await waitFor(`!document.getElementById('print-dialog').open`, 'the locked file printed');
    check('locked: says it was sent', (await text('toast')).includes('已送出到印表機'), await text('toast'));
    check('locked: the copy is deleted afterwards', !fs.existsSync(sent) && tempFiles().length === leftBefore);
  }

  await openPrint();
  await setSelect('print-per-sheet', '2');
  await waitFor(`document.querySelectorAll('.sheet-item').length === 1 && !document.getElementById('print-start').disabled`, 'two per sheet for the locked file');
  callsBefore = printCalls.length;
  await click('print-start');
  call = await nextPrintCall(callsBefore, 'printing the locked file two per sheet');
  if (call) {
    const sheets = await PDFDocument.load(fs.readFileSync(call.args.at(-1))).catch((err) => err);
    check('locked: several pages per sheet work too', sheets instanceof PDFDocument && sheets.getPageCount() === 1, String(sheets?.message ?? ''));
    call.finish(0);
    await waitFor(`!document.getElementById('print-dialog').open`, 'the locked sheets printed');
  }

  // Batch print: the password of a file open in the window is used without asking.
  await openBatch();
  await addToBatch([fixture('enc-aes-password.pdf')], 1);
  let rows = await batchRows();
  check('locked: batch print takes the password from the open file', rows[0].action === '' && rows[0].detail.startsWith('2 頁') && !rows[0].notes.includes('密碼'), JSON.stringify(rows[0]));
  await closeBatch();
  await closeTab();

  // With the file closed, the list asks; one password opens every file that shares it.
  await openBatch();
  await addToBatch([fixture('enc-aes-password.pdf'), fixture('enc-open-password.pdf'), fixture('mixed.pdf')], 3);
  rows = await batchRows();
  check('locked: a file that needs a password waits with a button', rows[0].action === '輸入密碼' && rows[1].action === '輸入密碼' && rows[2].action === '' && rows[0].notes.includes('有開啟密碼'), JSON.stringify(rows));
  await shot('81-batch-locked');
  check('locked: the button is a key that says what it is for', await js(`(() => {
    const b = document.querySelector('#batch-list .file-row .file-action');
    return b.querySelector('use').getAttribute('href') === '#i-key' && b.textContent.trim() === '' && b.getAttribute('aria-label') === '輸入密碼：enc-aes-password.pdf';
  })()`));
  check('locked: adding files is a plus, with its words on the pointer', await js(`['batch-add', 'batch-add-open', 'merge-add', 'merge-add-open'].every((id) => {
    const b = document.getElementById(id);
    return b.querySelector('svg') && b.textContent.trim() === '' && b.title.startsWith('加入') && b.getAttribute('aria-label') === b.title;
  })`));
  check('locked: and is left out of the count until then', (await text('batch-summary')) === '共 1 個檔案、4 頁，其中 2 頁橫向已自動轉向；另有 2 個不能印', await text('batch-summary'));
  await js(`document.querySelector('#batch-list .file-row .file-action').click()`);
  await waitFor(`document.getElementById('password-dialog').open`, 'the password prompt over batch print');
  check('locked: the prompt names the file', (await text('password-file')) === 'enc-aes-password.pdf');
  await js(`document.getElementById('password-cancel').click()`);
  await pause(150);
  check('locked: giving up leaves it waiting', (await batchRows())[0].action === '輸入密碼' && !(await js(`document.getElementById('password-dialog').open`)));
  await js(`document.querySelector('#batch-list .file-row .file-action').click()`);
  await answerPassword('wrong');
  await waitFor(`document.getElementById('password-dialog').open && !document.getElementById('password-error').hidden`, 'the wrong password said');
  check('locked: a wrong password asks again', !(await hidden('password-error')));
  await answerPassword('test1234');
  await waitFor(`[...document.querySelectorAll('#batch-list .file-action')].every((b) => b.hidden) && !document.getElementById('batch-summary').textContent.includes('還剩')`, 'both locked files open');
  rows = await batchRows();
  check('locked: the right password opens the file', rows[0].detail.startsWith('2 頁') && rows[0].notes === '', JSON.stringify(rows[0]));
  check('locked: and the other file with the same password', rows[1].action === '' && rows[1].detail.startsWith('1 頁'), JSON.stringify(rows[1]));
  check('locked: the count takes them in', (await text('batch-summary')).startsWith('共 3 個檔案、7 頁'), await text('batch-summary'));
  await js(`document.querySelector('#batch-list .file-row').click()`);
  await waitFor(`document.querySelectorAll('#batch-sheets .sheet-item').length === 2`, 'the preview of the unlocked file');
  check('locked: the preview shows the unlocked file', (await js(`document.querySelectorAll('#batch-sheets .sheet-item').length`)) === 2);
  callsBefore = printCalls.length;
  await click('batch-start');
  const sentFiles = [];
  for (let i = 0; i < 3; i++) {
    const job = await nextPrintCall(callsBefore + i, `batch job ${i + 1}`);
    if (!job) break;
    sentFiles.push(job.args.at(-1));
    if (i < 2) {
      const copy = await PDFDocument.load(fs.readFileSync(job.args.at(-1))).catch((err) => err);
      check(`locked: batch job ${i + 1} is an unlocked copy`, copy instanceof PDFDocument && path.dirname(job.args.at(-1)) === printTemp, String(copy?.message ?? ''));
    }
    job.finish(0);
  }
  await waitFor(`!document.getElementById('batch-dialog').open`, 'the batch with locked files printed');
  check('locked: a file without a password still goes as it is', sentFiles[2] === fixture('mixed.pdf'), String(sentFiles[2]));
  check('locked: no unlocked copy is left behind', tempFiles().length === leftBefore, tempFiles().join());

  // ---- Bookmarks in the left column -----------------------------------------
  await showTab('outline.pdf');
  const OUTLINE = `document.querySelector('.outline-pane.active')`;
  const shownEntries = () => js(`[...${OUTLINE}.querySelectorAll('.outline-go')].filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).visibility === 'visible').map((b) => b.textContent)`);
  check('outline: the column starts on thumbnails', !(await js(`document.body.classList.contains('show-outline')`)) && (await js(`document.getElementById('side-thumbs').classList.contains('on')`)));
  await click('side-outline');
  await waitFor(`${OUTLINE}.querySelectorAll('.outline-go').length === 6`, 'the bookmarks');
  check('outline: the tab shows which is on', (await js(`document.getElementById('side-outline').getAttribute('aria-selected')`)) === 'true' && (await js(`getComputedStyle(document.querySelector('.thumb-pane.active')).visibility`)) === 'hidden');
  let entries = await shownEntries();
  check('outline: chapters show, with sections open or folded as the file says', JSON.stringify(entries) === JSON.stringify(['第一章 總則', '1.1 目的', '1.2 範圍', '第二章 內容', '附錄']), JSON.stringify(entries));
  const clickEntry = (title) => js(`[...${OUTLINE}.querySelectorAll('.outline-go')].find((b) => b.textContent === ${JSON.stringify(title)}).click()`);
  await clickEntry('第二章 內容');
  await waitFor(`document.getElementById('page-input').value === '3'`, 'going to chapter 2');
  check('outline: clicking a chapter goes to its page', (await value('page-input')) === '3');
  check('outline: and marks it', (await js(`${OUTLINE}.querySelector('.outline-go.current').textContent`)) === '第二章 內容');
  await js(`[...${OUTLINE}.querySelectorAll('.outline-entry')].find((e) => e.querySelector('.outline-go').textContent === '第二章 內容').querySelector('.outline-fold').click()`);
  entries = await shownEntries();
  check('outline: a folded chapter opens', entries.includes('2.1 細節'), JSON.stringify(entries));
  await shot('82-outline');
  await clickEntry('2.1 細節');
  await waitFor(`document.getElementById('page-input').value === '4'`, 'going to section 2.1');
  check('outline: a section goes to its page', (await value('page-input')) === '4');
  await clickEntry('第一章 總則');
  await waitFor(`document.getElementById('page-input').value === '1'`, 'back to chapter 1');
  await showTab('mixed.pdf');
  await waitFor(`${OUTLINE}.querySelector('.outline-empty') !== null`, 'a file without bookmarks');
  check('outline: a file without bookmarks says so', (await js(`${OUTLINE}.textContent`)).includes('沒有目錄'));
  await click('side-thumbs');
  check('outline: thumbnails come back', (await js(`getComputedStyle(document.querySelector('.thumb-pane.active')).visibility`)) === 'visible' && !(await js(`document.body.classList.contains('show-outline')`)));

  // ---- Two pages side by side -------------------------------------------------
  await showTab('outline.pdf');
  const spreads = () => js(`document.querySelectorAll('.viewer-host.active .spread').length`);
  check('two pages: off to begin with', (await spreads()) === 0 && !(await js(`document.getElementById('btn-two-page').classList.contains('on')`)));
  await click('btn-two-page');
  await waitFor(`document.querySelectorAll('.viewer-host.active .spread').length === 2`, 'two pages side by side');
  check('two pages: the button shows it is on', await js(`document.getElementById('btn-two-page').classList.contains('on') && document.getElementById('btn-two-page').getAttribute('aria-pressed') === 'true'`));
  // pdf.js lets the invisible borders of the two pages overlap a little, so centres are compared.
  check('two pages: pages 1 and 2 sit next to each other, 3 and 4 below', await js(`(() => {
    const box = (n) => document.querySelector('.viewer-host.active .page[data-page-number="' + n + '"]').getBoundingClientRect();
    const middle = (n) => (box(n).left + box(n).right) / 2;
    return middle(2) - middle(1) > box(1).width * 0.9 && Math.abs(box(2).top - box(1).top) < 2
      && box(3).top > box(1).bottom - 20 && Math.abs(middle(3) - middle(1)) < 2 && Math.abs(box(4).top - box(3).top) < 2;
  })()`));
  check('two pages: the toolbar still fits the window with the new button', await js(`document.getElementById('toolbar').scrollWidth <= document.getElementById('toolbar').clientWidth`), await js(`window.innerWidth + ' wide, toolbar needs ' + document.getElementById('toolbar').scrollWidth`));
  check('two pages: both fit the window at whole-page zoom', await js(`(() => {
    const host = document.querySelector('.viewer-host.active').getBoundingClientRect();
    const right = document.querySelector('.viewer-host.active .page[data-page-number="2"]').getBoundingClientRect().right;
    return right <= host.right + 1;
  })()`));
  check('two pages: remembered', settings().twoPage === true);
  await shot('83-two-page');
  await showTab('mixed.pdf');
  check('two pages: every open file follows', (await spreads()) === 2);
  await click('btn-two-page');
  await waitFor(`document.querySelectorAll('.viewer-host.active .spread').length === 0`, 'one page again');
  check('two pages: pressing again goes back to one page', settings().twoPage === false && !(await js(`document.getElementById('btn-two-page').classList.contains('on')`)));

  // ---- Document information ---------------------------------------------------
  const infoRows = () => js(`(() => { const out = {}; const list = document.getElementById('info-list'); const terms = list.querySelectorAll('dt'); const cells = list.querySelectorAll('dd'); terms.forEach((t, i) => { out[t.textContent] = cells[i].textContent; }); return out; })()`);
  await showTab('outline.pdf');
  await press('d', { ctrlKey: true });
  await waitFor(`document.getElementById('info-dialog').open && document.querySelectorAll('#info-list dt').length > 5`, 'document information');
  await waitFor(`[...document.querySelectorAll('#info-list dd')].some((d) => d.textContent.includes('A4'))`, 'the page sizes');
  let info = await infoRows();
  check('info: file, pages and paper', info['檔名'] === 'outline.pdf' && info['頁數'] === '4 頁' && info['頁面大小'] === 'A4 直式（全部 4 頁）', JSON.stringify(info));
  check('info: where the file is, and how big', info['位置'] === path.dirname(fixture('outline.pdf')) && info['檔案大小'].includes(`${fs.statSync(fixture('outline.pdf')).size.toLocaleString('en-US')} 位元組`), `${info['位置']} ${info['檔案大小']}`);
  check('info: bookmarks, password and permissions', info['書籤目錄'] === '有' && info['開啟密碼'] === '沒有' && info['作者設定的權限'] === '沒有限制', JSON.stringify(info));
  check('info: dates read as dates', /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(info['建立日期'] ?? '') && /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(info['檔案修改時間'] ?? ''), `${info['建立日期']} ${info['檔案修改時間']}`);
  check('info: leaves out what the file does not say', !('作者' in info) && !('關鍵字' in info));
  await shot('84-info');
  const pageBeforeKey = await value('page-input');
  await press('PageDown');
  check('info: keys do not reach the page behind', (await value('page-input')) === pageBeforeKey);
  await click('info-close');
  check('info: closes', !(await js(`document.getElementById('info-dialog').open`)));
  // This file is already open in a tab from the earlier tests, and stays open.
  await showTab('enc-owner-no-print.pdf');
  await click('btn-file');
  await click('menu-info');
  await waitFor(`document.getElementById('info-dialog').open && document.querySelectorAll('#info-list dt').length > 5`, 'information on a protected file');
  info = await infoRows();
  check('info: says what the author forbids', info['作者設定的權限'].includes('列印：禁止') && info['開啟密碼'] === '沒有' && info['書籤目錄'] === '沒有', JSON.stringify(info['作者設定的權限']));
  await js(`document.getElementById('info-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  check('info: Esc closes it too', !(await js(`document.getElementById('info-dialog').open`)));

  // ---- Recent files -----------------------------------------------------------
  const recentNames = async () => (await js('window.api.recentFiles()')).map((file) => path.basename(file));
  await showTab('outline.pdf');
  let names = await recentNames();
  check('recent: files that were opened are listed, newest first', names[0] === 'outline.pdf' && names[1] === 'enc-aes-password.pdf' && names.includes('enc-open-password.pdf'), names.join());
  check('recent: the list stops at twenty', names.length <= 20, String(names.length));
  check('recent: each file once', new Set(names).size === names.length);
  await click('btn-file');
  await waitFor(`!document.getElementById('menu-recent').hidden && document.querySelectorAll('#menu-recent-list .recent-item').length > 0`, 'recent files in the menu');
  const menuNames = await js(`[...document.querySelectorAll('#menu-recent-list .recent-item')].map((b) => b.textContent)`);
  check('recent: the file menu shows the latest few', menuNames.length <= 6 && menuNames[0] === names[0], menuNames.join());
  await shot('85-menu-recent');
  check('recent: a row says where the file is', (await js(`document.querySelector('#menu-recent-list .recent-item').title`)) === fixture('outline.pdf'));
  await js(`document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);

  const typePage = (n) => js(`(() => { const i = document.getElementById('page-input'); i.focus(); i.value = '${n}'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await typePage(3);
  await waitFor(`document.getElementById('page-input').value === '3'`, 'page 3 of the outline file');
  await pause(1200);
  check('recent: the page is remembered once it has stayed put', (await js(`window.api.rememberedPage(${JSON.stringify(fixture('outline.pdf'))})`)) === 3);
  await typePage(4);
  await waitFor(`document.getElementById('page-input').value === '4'`, 'page 4 of the outline file');
  const tabsBeforeReopen = await tabCount();
  await closeTab();
  check('recent: closing a file remembers its page at once', (await js(`window.api.rememberedPage(${JSON.stringify(fixture('outline.pdf'))})`)) === 4);
  await click('btn-file');
  await waitFor(`[...document.querySelectorAll('#menu-recent-list .recent-item')].some((b) => b.textContent === 'outline.pdf')`, 'outline.pdf among the recent files');
  await js(`[...document.querySelectorAll('#menu-recent-list .recent-item')].find((b) => b.textContent === 'outline.pdf').click()`);
  await waitFor(`document.title.startsWith('outline.pdf') && document.getElementById('page-total').textContent === '/ 4'`, 'outline.pdf from the recent files');
  check('recent: the menu closes and the file opens', (await js(`document.getElementById('file-menu').hidden`)) && (await tabCount()) === tabsBeforeReopen);
  await waitFor(`document.getElementById('page-input').value === '4'`, 'the page it was left at');
  check('recent: it opens at the page it was left at', (await value('page-input')) === '4');
  await typePage(1);
  await waitFor(`document.getElementById('page-input').value === '1'`, 'back to page 1');

  const gone = path.join(os.tmpdir(), `${tempPrefix}gone.pdf`);
  fs.copyFileSync(fixture('small-page.pdf'), gone);
  openFiles([gone]);
  await waitFor(`document.title.startsWith(${JSON.stringify(path.basename(gone))}) && !document.getElementById('btn-print').disabled`, 'a file that will go');
  await closeTab();
  fs.rmSync(gone, { force: true });
  await js(`document.getElementById('toast').textContent = ''`);
  await click('btn-file');
  await waitFor(`[...document.querySelectorAll('#menu-recent-list .recent-item')].some((b) => b.textContent === ${JSON.stringify(path.basename(gone))})`, 'the gone file among the recent files');
  await js(`[...document.querySelectorAll('#menu-recent-list .recent-item')].find((b) => b.textContent === ${JSON.stringify(path.basename(gone))}).click()`);
  await waitFor(`document.getElementById('toast').textContent.includes('找不到')`, 'the message for a file that has gone');
  check('recent: a file that has gone is said plainly and taken off', (await text('toast')).includes(path.basename(gone)) && !(await recentNames()).includes(path.basename(gone)), await text('toast'));
  await click('btn-file');
  await click('menu-recent-clear');
  await waitFor(`window.api.recentFiles().then((list) => list.length === 0)`, 'the list cleared');
  check('recent: the list can be cleared', (await recentNames()).length === 0);
  await click('btn-file');
  await pause(150);
  check('recent: an empty list takes no room in the menu', await hidden('menu-recent'));
  await js(`document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);

  // ---- Pictures made into a PDF -------------------------------------------------
  const pictures = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}pictures-`));
  // A wide photo, red along its top edge, stored with a note that it must be turned a
  // quarter clockwise to look right, the way a phone held upright saves it.
  const bitmap = (width, height, isRed) => {
    const data = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const red = isRed(x, y);
        data[at] = red ? 0 : 230;
        data[at + 1] = red ? 0 : 230;
        data[at + 2] = red ? 255 : 230;
      }
    }
    return nativeImage.createFromBitmap(data, { width, height });
  };
  const withOrientation = (jpeg, orientation) => {
    const tiff = Buffer.alloc(26);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const head = Buffer.from([0xFF, 0xE1, 0, 0]);
    head.writeUInt16BE(exif.length + 2, 2);
    return Buffer.concat([jpeg.subarray(0, 2), head, exif, jpeg.subarray(2)]);
  };
  const photo = path.join(pictures, 'photo.jpg');
  const drawing = path.join(pictures, 'shot.png');
  const bad = path.join(pictures, 'bad.jpg');
  fs.writeFileSync(photo, withOrientation(bitmap(300, 200, (_x, y) => y < 50).toJPEG(92), 6));
  fs.writeFileSync(drawing, bitmap(120, 200, () => false).toPNG());
  fs.writeFileSync(bad, 'this is not a picture');

  const mergeRows = () => js(`[...document.querySelectorAll('#merge-list .file-row')].map((row) => ({
    name: row.querySelector('.file-name').textContent,
    detail: row.querySelector('.file-detail').textContent,
    notes: row.querySelector('.file-notes').textContent,
    thumb: row.querySelector('.file-thumb').hidden ? '' : row.querySelector('.file-thumb').dataset.shape,
  }))`);
  const addToMerge = async (files, count) => {
    setPicked(files);
    await click('merge-add');
    await waitFor(`document.querySelectorAll('#merge-list .file-row').length === ${count} && !document.getElementById('merge-summary').textContent.includes('還剩')`, `merge list of ${count}`, 40000);
  };
  const closeMerge = async () => {
    await click('merge-close');
    await waitFor(`!document.getElementById('merge-dialog').open`, 'merge dialog closed');
  };

  await click('btn-file');
  await click('menu-images');
  await waitFor(`document.getElementById('merge-dialog').open`, 'pictures to PDF');
  check('pictures: the window says what it is for', (await text('merge-title')) === '圖片轉 PDF' && (await text('merge-start')) === '轉成 PDF 並存檔' && (await text('merge-empty')).includes('圖片'));
  check('pictures: open PDFs are not offered here', await hidden('merge-add-open'));
  await addToMerge([photo, drawing], 2);
  await waitFor(`[...document.querySelectorAll('#merge-list .file-thumb')].every((c) => !c.hidden)`, 'the small pictures');
  let pictureRows = await mergeRows();
  check('pictures: a photo stored sideways counts the way it is seen', pictureRows[0].detail === '圖片，200 × 300' && pictureRows[1].detail === '圖片，120 × 200', JSON.stringify(pictureRows));
  check('pictures: the small picture is turned upright too', pictureRows[0].thumb === 'tall' && pictureRows[1].thumb === 'tall', JSON.stringify(pictureRows));
  check('pictures: the summary counts pictures', (await text('merge-summary')) === '共 2 張圖片，會變成 2 頁', await text('merge-summary'));
  check('pictures: the paper can be chosen, and the note about bookmarks goes', !(await hidden('merge-paper-row')) && !(await hidden('merge-image-hint')) && (await hidden('merge-limits')) && (await value('merge-image-paper')) === 'A4');
  check('pictures: ready to save', !(await disabled('merge-start')));
  await shot('86-pictures');
  const picturesOut = path.join(pictures, 'pictures.pdf');
  setSaveTarget(picturesOut);
  await click('merge-start');
  await waitFor(`document.getElementById('merge-status').textContent.includes('已轉成')`, 'the pictures saved');
  check('pictures: says what it made', (await text('merge-status')) === '已轉成「pictures.pdf」，共 2 頁。', await text('merge-status'));
  const made = await PDFDocument.load(fs.readFileSync(picturesOut));
  const sizes = made.getPages().map((page) => page.getSize()).map(({ width, height }) => [Math.round(width), Math.round(height)]);
  check('pictures: a page for each, on upright A4', JSON.stringify(sizes) === '[[595,842],[595,842]]', JSON.stringify(sizes));

  await setSelect('merge-image-paper', 'fit');
  const fitOut = path.join(pictures, 'fit.pdf');
  setSaveTarget(fitOut);
  await click('merge-start');
  await waitFor(`document.getElementById('merge-status').textContent.includes('fit.pdf')`, 'the pictures saved without margins');
  const fitSizes = (await PDFDocument.load(fs.readFileSync(fitOut))).getPages().map((page) => page.getSize()).map(({ width, height }) => [Math.round(width), Math.round(height)]);
  check('pictures: or a page the shape of each picture', JSON.stringify(fitSizes) === '[[561,842],[505,842]]', JSON.stringify(fitSizes));
  const tabsBeforeResult = await tabCount();
  await click('merge-open');
  await waitFor(`document.title.startsWith('fit.pdf') && document.getElementById('page-total').textContent === '/ 2'`, 'the made PDF open');
  check('pictures: the result opens in a tab', (await tabCount()) === tabsBeforeResult + 1 && !(await js(`document.getElementById('merge-dialog').open`)));
  // The page is white until the photo is drawn; its grey middle shows it has been.
  await waitFor(`(() => { const c = document.querySelector('.viewer-host.active .page[data-page-number="1"] canvas'); if (!c || !c.width) return false; const [r, , , a] = c.getContext('2d').getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data; return a > 0 && r < 245; })()`, 'the photo painted');
  await pause(300);
  const colours = await js(`(() => {
    const c = document.querySelector('.viewer-host.active .page[data-page-number="1"] canvas');
    const at = (fx, fy) => [...c.getContext('2d').getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data].slice(0, 3);
    return { right: at(0.92, 0.5), left: at(0.08, 0.5), top: at(0.4, 0.05), bottom: at(0.4, 0.95) };
  })()`);
  const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
  check('pictures: the photo is the right way up, its top edge now on the right', isRed(colours.right) && !isRed(colours.left) && !isRed(colours.top) && !isRed(colours.bottom), JSON.stringify(colours));
  await closeTab();

  // Merging takes pictures as well.
  await click('btn-merge');
  await waitFor(`document.getElementById('merge-dialog').open`, 'merge with pictures');
  check('pictures: merging still calls itself merging', (await text('merge-title')) === '合併 PDF' && (await text('merge-start')) === '合併並存檔' && (await value('merge-image-paper')) === 'A4');
  await addToMerge([fixture('mixed.pdf'), photo], 2);
  check('pictures: the merge summary names both kinds', (await text('merge-summary')) === '共 1 個 PDF、1 張圖片，合起來 5 頁', await text('merge-summary'));
  check('pictures: the note about bookmarks stays when PDFs are merged', !(await hidden('merge-limits')) && !(await hidden('merge-paper-row')));
  const mixedOut = path.join(pictures, 'mixed-with-photo.pdf');
  setSaveTarget(mixedOut);
  await click('merge-start');
  await waitFor(`document.getElementById('merge-status').textContent.includes('已合併成')`, 'the PDF and the picture merged');
  const mixedDoc = await PDFDocument.load(fs.readFileSync(mixedOut));
  check('pictures: the picture becomes the last page', mixedDoc.getPageCount() === 5 && Math.round(mixedDoc.getPage(4).getSize().width) === 595, String(mixedDoc.getPageCount()));
  await addToMerge([bad], 3);
  pictureRows = await mergeRows();
  check('pictures: a file that is not a picture is said plainly', pictureRows[2].notes === '不是能用的 JPG 或 PNG 圖片' && (await disabled('merge-start')), JSON.stringify(pictureRows[2]));
  check('pictures: and counted apart', (await text('merge-summary')).endsWith('有 1 個不能合併，請先從清單移除'), await text('merge-summary'));
  await closeMerge();

  // A single PDF is still not enough to merge; a single picture is enough to convert.
  await click('btn-merge');
  await waitFor(`document.getElementById('merge-dialog').open`, 'merge again');
  await addToMerge([fixture('mixed.pdf')], 1);
  check('pictures: one PDF alone cannot be merged', await disabled('merge-start'));
  await closeMerge();
  await click('btn-file');
  await click('menu-images');
  await waitFor(`document.getElementById('merge-dialog').open`, 'pictures to PDF again');
  await addToMerge([drawing], 1);
  check('pictures: one picture alone is enough', !(await disabled('merge-start')) && (await text('merge-summary')) === '共 1 張圖片，會變成 1 頁');
  await closeMerge();

  // Pictures dropped on the window go straight to this dialog.
  await js(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'holiday.jpg', { type: 'image/jpeg' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(`document.getElementById('merge-dialog').open`, 'pictures dropped on the window');
  check('pictures: dropping pictures on the window opens it', (await text('merge-title')) === '圖片轉 PDF');
  await closeMerge();
  setSaveTarget(null);
  fs.rmSync(pictures, { recursive: true, force: true });

  // ---- Updating, only when asked ----------------------------------------------
  check('update: the program has not looked for a new version by itself', updater.checks === 0 && updater.downloads === 0);
  await click('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open && document.getElementById('update-current').textContent !== ''`, 'settings for the update checks');
  check('update: settings show the version and say nothing is checked until asked', (await text('update-current')) === app.getVersion() && (await js(`document.getElementById('update-check').closest('section').textContent`)).includes('平常不會自己連網路'));
  check('update: only the check button shows at first', !(await hidden('update-check')) && (await hidden('update-download')) && (await hidden('update-install')) && (await hidden('update-status')) && (await hidden('update-bar')));
  updater.version = app.getVersion();
  await click('update-check');
  await waitFor(`document.getElementById('update-status').textContent.includes('已經是最新版')`, 'the answer when up to date');
  check('update: says when this is the latest', (await text('update-status')) === `已經是最新版（${app.getVersion()}）。` && (await hidden('update-download')) && updater.checks === 1);
  updater.fails = true;
  await click('update-check');
  await waitFor(`document.getElementById('update-status').textContent.includes('檢查不到')`, 'the answer without a network');
  check('update: says plainly when GitHub cannot be reached', (await text('update-status')).includes('請確認網路有連線') && (await js(`document.getElementById('update-status').classList.contains('error')`)));
  updater.fails = false;
  updater.version = '99.9.9';
  await click('update-check');
  await waitFor(`document.getElementById('update-status').textContent.includes('有新版 99.9.9')`, 'a newer version found');
  check('update: a newer version is offered, not downloaded', !(await hidden('update-download')) && (await hidden('update-install')) && updater.downloads === 0, await text('update-status'));
  await click('update-download');
  await waitFor(`!document.getElementById('update-bar').hidden && document.getElementById('update-bar').value === 42`, 'the download progress');
  check('update: the download shows how far it is', (await text('update-status')) === '正在下載新版… 42%' && (await disabled('update-check')), await text('update-status'));
  await waitFor(`document.getElementById('update-status').textContent.includes('下載好了')`, 'the download finished');
  check('update: then offers to restart and install', !(await hidden('update-install')) && (await hidden('update-download')) && (await hidden('update-bar')) && updater.downloads === 1 && updater.installs.length === 0);
  await shot('88-update');
  await click('settings-close');
  await click('btn-settings');
  await waitFor(`document.getElementById('settings-dialog').open`, 'settings again for the update checks');
  await click('update-check');
  await waitFor(`document.getElementById('update-status').textContent.includes('已經下載好了')`, 'the update already downloaded');
  check('update: a download is not asked for twice', !(await hidden('update-install')) && updater.downloads === 1);
  await click('update-install');
  await waitFor(`document.getElementById('update-status').textContent.includes('正在關閉程式')`, 'the install starting');
  await pause(100);
  check('update: installing closes, installs quietly and starts the program again', updater.installs.length === 1 && updater.installs[0][0] === true && updater.installs[0][1] === true, JSON.stringify(updater.installs));
  await click('settings-close');
  check('update: settings close', !(await js(`document.getElementById('settings-dialog').open`)));

  await showTab('outline.pdf');
  await closeTab();
  check('1.4: nothing this part opened is left open', (await tabCount()) <= tabsAtStart + 1, `${await tabCount()} tabs, ${tabsAtStart} at the start`);
};
