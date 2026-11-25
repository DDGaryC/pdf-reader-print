// The compare mode, driven in the real app with its window hidden. Called from run.js,
// which answers the file picker so that it never opens.
module.exports = async function runCompareTests(ctx) {
  const { check, click, fixture, heldFiles, js, openFiles, pause, press, setPicked, shot, tabCount, text, waitFor } = ctx;
  // Another file stays open in its own tab throughout.
  openFiles([fixture('mixed.pdf')]);
  await waitFor(`document.title.startsWith('mixed.pdf')`, 'mixed.pdf for the compare tests');
  const heldBefore = heldFiles.size;
  const tabsBefore = await tabCount();

  const PANE = `document.querySelector('.compare-pane.active')`;
  const side = (which) => `${PANE}.querySelector('.compare-side.${which}')`;
  const host = (which) => `${side(which)}.querySelector('.compare-host')`;
  const nameOn = (which) => js(`${side(which)}.querySelector('.compare-name').textContent`);
  const pagesOn = (which) => js(`${side(which)}.querySelector('.compare-pages').textContent`);
  const comparing = () => js(`document.body.classList.contains('comparing')`);
  const marksOn = (which, page, kind) => js(`${side(which)}.querySelectorAll('.page[data-page-number="${page}"] .compare-mark.${kind}').length`);
  const currentOn = (which) => js(`[...${side(which)}.querySelectorAll('.compare-mark.current')].map((m) => m.dataset.index).join()`);
  const status = () => text('cmp-status');
  const count = () => text('cmp-diff-count');
  const enter = async () => {
    await click('btn-compare');
    await waitFor(`document.body.classList.contains('comparing') && ${PANE} !== null`, 'compare mode');
  };
  const chooseRight = async (file, button = '.compare-choose') => {
    setPicked([fixture(file)]);
    await js(`${side('right')}.querySelector('${button}').click()`);
  };

  openFiles([fixture('compare-old.pdf')]);
  await waitFor(`document.title.startsWith('compare-old.pdf') && !document.getElementById('btn-compare').disabled`, 'compare-old.pdf');
  check('compare: the button sits with the main tools in the middle', await js(`document.getElementById('btn-compare').closest('.bar-center') !== null`));
  check('compare: and in the file menu', await js(`!document.getElementById('menu-compare').disabled`));

  // ---- Starting
  await enter();
  check('compare: the reading toolbar and the thumbnails make way', await js(`getComputedStyle(document.getElementById('toolbar')).display === 'none'
    && getComputedStyle(document.getElementById('sidebar')).display === 'none'
    && getComputedStyle(document.getElementById('compare-bar')).display === 'grid'
    && getComputedStyle(document.getElementById('compare-foot')).display === 'flex'`));
  check('compare: the open file is on the left', (await nameOn('left')) === 'compare-old.pdf');
  await waitFor(`${side('left')}.querySelector('.page[data-page-number="1"] canvas')?.width > 0`, 'the left page drawn');
  check('compare: the right side asks for a file', await js(`!${side('right')}.querySelector('.compare-pick').hidden`));
  check('compare: the title says what is compared', (await js('document.title')).startsWith('比對：compare-old.pdf ↔'), await js('document.title'));
  check('compare: nothing to step through or swap yet', await js(`document.getElementById('cmp-next-diff').disabled && document.getElementById('cmp-swap').disabled`));
  check('compare: it says to choose a file', (await status()).includes('請選擇'), await status());
  await waitFor(`${side('right')}.querySelectorAll('.compare-open-file').length > 0`, 'open files offered');
  const offered = await js(`[...${side('right')}.querySelectorAll('.compare-open-file')].map((b) => b.textContent)`);
  check('compare: files already open are offered, but not this one', offered.length > 0 && !offered.includes('compare-old.pdf'), offered.join());
  await shot('compare-01-choose');

  // ---- The other version
  await chooseRight('compare-new.pdf');
  await waitFor(`document.getElementById('cmp-status').textContent.startsWith('找到')`, 'the comparison');
  check('compare: six differences found', (await status()) === '找到 6 處不同。', await status());
  check('compare: the count shows them', (await count()) === '共 6 處', await count());
  check('compare: the other file is on the right', (await nameOn('right')) === 'compare-new.pdf' && await js(`${side('right')}.querySelector('.compare-pick').hidden`));
  check('compare: the colours are explained', await js(`!document.getElementById('cmp-legend').hidden`));
  check('compare: each side shows its pages', (await pagesOn('left')) === '第 1 / 2 頁' && (await pagesOn('right')) === '第 1 / 2 頁', `${await pagesOn('left')} ${await pagesOn('right')}`);
  await waitFor(`${side('left')}.querySelectorAll('.compare-mark').length > 0 && ${side('right')}.querySelectorAll('.compare-mark').length > 0`, 'marks on both sides');
  check('compare: on the left, the three old numbers on page 1', (await marksOn('left', 1, 'removed')) === 3, String(await marksOn('left', 1, 'removed')));
  check('compare: and where the added line belongs', (await marksOn('left', 1, 'gap')) === 1);
  check('compare: on the right, the three new numbers and the added line', (await marksOn('right', 1, 'added')) === 4, String(await marksOn('right', 1, 'added')));

  // The mark lies over the number in the text, not somewhere else on the line.
  await waitFor(`[...${side('left')}.querySelectorAll('.page[data-page-number="1"] .textLayer span')].some((s) => s.textContent.includes('650'))`, 'the left text layer');
  const placed = await js(`(() => {
    const mark = ${side('left')}.querySelector('.page[data-page-number="1"] .compare-mark[data-index="0"]').getBoundingClientRect();
    const span = [...${side('left')}.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find((s) => s.textContent.includes('650'));
    const line = span.getBoundingClientRect();
    const middle = (mark.top + mark.bottom) / 2;
    // The number is three of the characters in the piece of text that holds it.
    const share = 3 / [...span.textContent.replace(/\\s/g, '')].length;
    return {
      text: span.textContent,
      inLine: middle > line.top && middle < line.bottom,
      inside: mark.left >= line.left - 1 && mark.right <= line.right + 1,
      share: Math.round((mark.width / line.width) * 100) / 100,
      expected: Math.round(share * 100) / 100,
    };
  })()`);
  check('compare: the mark sits on the number', placed.inLine && placed.inside && Math.abs(placed.share - placed.expected) < 0.12, JSON.stringify(placed));
  await shot('compare-02-found');

  // ---- Stepping through the differences
  await click('cmp-next-diff');
  check('compare: the first difference', (await count()) === '1 / 6' && (await currentOn('left')) === '0' && (await currentOn('right')) === '0', `${await count()} ${await currentOn('left')}`);
  await press('ArrowDown', { altKey: true });
  check('compare: Alt+Down goes to the next', (await count()) === '2 / 6');
  await click('cmp-next-diff');
  await click('cmp-next-diff');
  await click('cmp-next-diff');
  check('compare: the fifth is on page 2', (await count()) === '5 / 6');
  await waitFor(`${side('left')}.querySelector('.compare-pages').textContent === '第 2 / 2 頁' && ${side('right')}.querySelector('.compare-pages').textContent === '第 2 / 2 頁'`, 'both sides on page 2');
  await waitFor(`${side('right')}.querySelector('.page[data-page-number="2"] .compare-mark.current')`, 'the marks on page 2');
  check('compare: both sides went to page 2 and mark it', (await currentOn('left')) === '4' && (await currentOn('right')) === '4');
  check('compare: the removed line is marked on the left of page 2', (await marksOn('left', 2, 'removed')) === 2 && (await marksOn('right', 2, 'gap')) === 1, `${await marksOn('left', 2, 'removed')} ${await marksOn('right', 2, 'gap')}`);
  await press('F7', { shiftKey: true });
  check('compare: Shift+F7 goes back', (await count()) === '4 / 6');
  await click('cmp-next-diff');
  await click('cmp-next-diff');
  await click('cmp-next-diff');
  check('compare: after the last comes the first again', (await count()) === '1 / 6');
  await click('cmp-prev-diff');
  check('compare: and before the first, the last', (await count()) === '6 / 6');

  // ---- Moving both sides together
  await js(`(() => { const s = document.getElementById('cmp-zoom'); s.value = 'page-width'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(`Math.abs(${host('left')}.querySelector('.page').offsetWidth - ${host('left')}.clientWidth) < 60`, 'fit to width');
  check('compare: the zoom applies to both sides', await js(`Math.abs(${host('left')}.querySelector('.page').offsetWidth - ${host('right')}.querySelector('.page').offsetWidth) < 3`));
  await press('Home');
  await pause(300);
  const tops = () => js(`[${host('left')}.scrollTop, ${host('right')}.scrollTop]`);
  // A hidden window sends scroll events late, so the test sends one at once.
  const scrollBy = (which, amount) => js(`(() => {
    const h = ${host(which)};
    h.dispatchEvent(new WheelEvent('wheel', { deltaY: ${amount}, bubbles: true }));
    h.scrollTop += ${amount};
    h.dispatchEvent(new Event('scroll'));
  })()`);
  const [startLeft, startRight] = await tops();
  await scrollBy('left', 300);
  await pause(300);
  let [left, right] = await tops();
  check('compare: scrolling one side moves the other the same', left - startLeft > 250 && Math.abs((right - startRight) - (left - startLeft)) < 4, `${startLeft},${startRight} -> ${left},${right}`);
  // Chromium sends all but the first wheel event of a scroll late, after the side has moved.
  await js(`(() => {
    const h = ${host('left')};
    h.scrollTop += 150;
    h.dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true }));
    h.dispatchEvent(new Event('scroll'));
  })()`);
  await pause(300);
  const [lateLeft, lateRight] = await tops();
  check('compare: a wheel that arrives after the move still moves the other side', lateLeft - left > 100 && Math.abs((lateRight - right) - (lateLeft - left)) < 4, `${left},${right} -> ${lateLeft},${lateRight}`);
  [left, right] = [lateLeft, lateRight];
  await scrollBy('right', -120);
  await pause(300);
  const [backLeft, backRight] = await tops();
  check('compare: and the other way round', Math.abs((left - backLeft) - (right - backRight)) < 4 && right - backRight > 100, `${left},${right} -> ${backLeft},${backRight}`);
  await click('cmp-sync');
  check('compare: following can be turned off', await js(`document.getElementById('cmp-sync').getAttribute('aria-pressed') === 'false' && !document.getElementById('cmp-sync').classList.contains('on')`));
  [left, right] = await tops();
  await scrollBy('left', 200);
  await pause(300);
  const [aloneLeft, aloneRight] = await tops();
  check('compare: then the other side stays', aloneLeft - left > 150 && aloneRight === right, `${left},${right} -> ${aloneLeft},${aloneRight}`);
  await click('cmp-sync');

  await press('PageDown');
  await waitFor(`${side('left')}.querySelector('.compare-pages').textContent === '第 2 / 2 頁' && ${side('right')}.querySelector('.compare-pages').textContent === '第 2 / 2 頁'`, 'next page on both sides');
  check('compare: Page Down turns both', true);
  await press('=', { ctrlKey: true });
  await pause(300);
  check('compare: Ctrl++ zooms both the same', await js(`Math.abs(${host('left')}.querySelector('.page').offsetWidth - ${host('right')}.querySelector('.page').offsetWidth) < 3
    && document.getElementById('cmp-zoom').value === 'custom'`));
  await press('0', { ctrlKey: true });
  await pause(200);
  check('compare: Ctrl+0 shows whole pages again', (await js(`document.getElementById('cmp-zoom').value`)) === 'page-fit');

  // ---- Swapping sides
  await click('cmp-swap');
  await waitFor(`document.getElementById('cmp-status').textContent.startsWith('找到')`, 'the comparison after swapping');
  check('compare: the files swap sides', (await nameOn('left')) === 'compare-new.pdf' && (await nameOn('right')) === 'compare-old.pdf');
  check('compare: still six differences', (await status()) === '找到 6 處不同。' && (await count()) === '共 6 處', `${await status()} ${await count()}`);
  await press('Home');
  await waitFor(`${side('left')}.querySelectorAll('.page[data-page-number="1"] .compare-mark.removed').length === 4`, 'marks after swapping');
  check('compare: now the new numbers and the added line are marked on the left', (await marksOn('left', 1, 'removed')) === 4 && (await marksOn('right', 1, 'added')) === 3);
  await click('cmp-swap');
  await waitFor(`document.getElementById('cmp-status').textContent.startsWith('找到') && ${side('left')}.querySelector('.compare-name').textContent === 'compare-old.pdf'`, 'swapped back');

  // ---- Other files on the right
  await chooseRight('notes.txt', '.compare-change');
  await waitFor(`document.getElementById('toast').textContent.includes('notes.txt')`, 'the message about a file that is not a PDF');
  check('compare: a file that is not a PDF is refused', (await text('toast')).includes('只能開啟 PDF 檔案') && (await nameOn('right')) === 'compare-new.pdf');

  await chooseRight('compare-scan.pdf', '.compare-change');
  await waitFor(`document.getElementById('cmp-status').textContent.includes('沒有文字')`, 'the message about a scan');
  check('compare: a file without text is shown side by side, with the reason', (await status()).startsWith('右邊的檔案幾乎沒有文字') && (await nameOn('right')) === 'compare-scan.pdf', await status());
  check('compare: and nothing is marked', await js(`document.querySelectorAll('.compare-pane.active .compare-mark').length === 0 && document.getElementById('cmp-next-diff').disabled && document.getElementById('cmp-legend').hidden`));

  await chooseRight('enc-open-password.pdf', '.compare-change');
  await waitFor(`document.getElementById('password-dialog').open`, 'the password prompt');
  await click('password-cancel');
  await pause(300);
  check('compare: cancelling the password keeps what was there', (await nameOn('right')) === 'compare-scan.pdf');
  await chooseRight('enc-open-password.pdf', '.compare-change');
  await waitFor(`document.getElementById('password-dialog').open`, 'the password prompt again');
  await js(`document.getElementById('password-input').value = 'test1234'`);
  await click('password-ok');
  await waitFor(`${side('right')}.querySelector('.compare-name').textContent === 'enc-open-password.pdf'`, 'the protected file on the right');
  check('compare: a file with a password can be compared after typing it', true);

  // The picker gives nothing back when the user cancels it.
  setPicked([]);
  await js(`${side('right')}.querySelector('.compare-change').click()`);
  await pause(200);
  check('compare: cancelling the file picker changes nothing', (await nameOn('right')) === 'enc-open-password.pdf');

  // A file dropped on the comparison without a real path is ignored, and opens no tab.
  const tabsNow = await tabCount();
  await js(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'fake.pdf', { type: 'application/pdf' }));
    ${side('right')}.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`);
  await pause(200);
  check('compare: a drop without a file opens nothing', (await tabCount()) === tabsNow && (await nameOn('right')) === 'enc-open-password.pdf');

  // ---- Switching tabs keeps the comparison
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'mixed.pdf').click()`);
  await waitFor(`document.title.startsWith('mixed.pdf')`, 'another tab');
  check('compare: another tab reads normally', !(await comparing()) && await js(`getComputedStyle(document.getElementById('toolbar')).display !== 'none'`));
  await js(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'compare-old.pdf').click()`);
  await waitFor(`document.body.classList.contains('comparing')`, 'back to the comparison');
  check('compare: coming back finds the comparison as it was', (await nameOn('right')) === 'enc-open-password.pdf');

  // ---- Leaving
  await press('Escape');
  await waitFor(`!document.body.classList.contains('comparing')`, 'leaving with Esc');
  check('compare: Esc goes back to reading', await js(`getComputedStyle(document.querySelector('.viewer-host.active')).visibility === 'visible' && !document.querySelector('.compare-pane')`));
  check('compare: the title is the file again', (await js('document.title')) === 'compare-old.pdf - PDF閱讀列印');
  await waitFor(`document.querySelector('.viewer-host.active .page[data-page-number="1"] canvas')?.width > 0`, 'the reading view drawn');
  check('compare: reading still works', (await text('page-total')) === '/ 2');
  check('compare: the file on the right is let go', heldFiles.size === heldBefore + 1, String(heldFiles.size - heldBefore));

  // Choosing from the files already open, then closing the tab while comparing.
  await click('menu-compare');
  await waitFor(`document.body.classList.contains('comparing') && ${side('right')}.querySelectorAll('.compare-open-file').length > 0`, 'compare mode from the menu');
  await js(`[...${side('right')}.querySelectorAll('.compare-open-file')].find((b) => b.textContent === 'mixed.pdf').click()`);
  await waitFor(`${side('right')}.querySelector('.compare-name').textContent === 'mixed.pdf' && !document.getElementById('cmp-status').textContent.startsWith('正在')`, 'mixed.pdf on the right');
  check('compare: a file open in another tab can be chosen', (await nameOn('right')) === 'mixed.pdf', await status());
  await press('w', { ctrlKey: true });
  await waitFor(`!document.title.startsWith('比對')`, 'the tab closing');
  await pause(300);
  check('compare: closing the tab ends the comparison', !(await comparing()) && (await tabCount()) === tabsBefore);
  check('compare: and lets go of both files', heldFiles.size === heldBefore, String(heldFiles.size - heldBefore));
};
