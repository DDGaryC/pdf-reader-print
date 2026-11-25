// The organize mode, driven in the real app with its window hidden. Called from run.js,
// which replaces the Save As window and the file picker so that neither ever opens.
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('@cantoo/pdf-lib');

const TALL = '595x842';
const WIDE = '842x595';
const SQUARE = '500x500';

const PANE = `document.querySelector('.organize-pane.active')`;
const CELLS = `[...${PANE}.querySelectorAll('.organize-cell')]`;

// Node opens files so that others may still move them; many programs do not.
function lockLikeAnotherProgram(file) {
  const script = '$f = [IO.File]::Open($env:LOCK_PATH, "Open", "Read", "Read"); "ready"; [Console]::In.ReadLine() | Out-Null; $f.Close()';
  const child = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, LOCK_PATH: file },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve({
      release: () => new Promise((done) => {
        child.once('exit', done);
        child.stdin.end('\n');
      }),
    }));
    child.once('error', reject);
  });
}

async function pdfInfo(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return {
    sizes: doc.getPages().map((page) => {
      const { width, height } = page.getSize();
      return `${Math.round(width)}x${Math.round(height)}`;
    }),
    angles: doc.getPages().map((page) => page.getRotation().angle),
  };
}

module.exports = async function runOrganizeTests(ctx) {
  const { check, click, fixture, heldFiles, js, openFiles, pause, press, tabCount, text, waitFor, win } = ctx;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `${ctx.tempPrefix}organize-`));
  const inFolder = (name) => path.join(folder, name);
  const copy = (from, name = from) => {
    fs.copyFileSync(fixture(from), inFolder(name));
    return inFolder(name);
  };
  const heldBefore = heldFiles.size;
  const tabsBefore = await tabCount();

  const openCopy = async (file) => {
    openFiles([file]);
    await waitFor(`document.title.includes(${JSON.stringify(path.basename(file))}) && !document.getElementById('btn-organize').disabled`, `open ${path.basename(file)}`, 40000);
  };
  const organizing = () => js(`document.body.classList.contains('organizing')`);
  const enter = async (count) => {
    await click('btn-organize');
    await waitFor(`document.body.classList.contains('organizing') && ${CELLS}.length === ${count}`, 'organize mode');
  };
  const closeTabNamed = async (name) => {
    await js(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === ${JSON.stringify(name)}).querySelector('.tab-close').click()`);
    await pause(100);
  };
  const selectTab = async (name) => {
    await js(`[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === ${JSON.stringify(name)}).click()`);
    await waitFor(`document.title.includes(${JSON.stringify(name)})`, `tab ${name}`);
  };
  const order = () => js(`${CELLS}.map((c) => {
    const found = /(?:「(.*)」)?第 (\\d+) 頁/.exec(c.title);
    return found[1] ? found[1] + ':' + found[2] : Number(found[2]);
  })`);
  const numbers = () => js(`${CELLS}.map((c) => c.querySelector('.organize-number').textContent)`);
  const chosen = () => js(`${CELLS}.flatMap((c, i) => (c.classList.contains('selected') ? [i] : []))`);
  const disabled = (id) => js(`document.getElementById('${id}').disabled`);
  const isDirty = () => js(`document.querySelector('.tab[aria-selected="true"]').classList.contains('dirty')`);
  const clearToast = () => js(`document.getElementById('toast').textContent = ''`);
  const toast = () => text('toast');
  const waitToast = (part) => waitFor(`document.getElementById('toast').textContent.includes(${JSON.stringify(part)})`, `message "${part}"`);
  const notBusy = () => waitFor(`!document.getElementById('org-saveas').disabled`, 'not busy');

  const clickCell = (position, modifiers = {}) => js(`(() => {
    const pane = ${PANE};
    pane.setPointerCapture = () => {};
    const cell = ${CELLS}[${position}];
    const r = cell.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1, bubbles: true, ...${JSON.stringify(modifiers)} };
    cell.dispatchEvent(new PointerEvent('pointerdown', at));
    pane.dispatchEvent(new PointerEvent('pointerup', at));
    delete pane.setPointerCapture;
  })()`);
  // Starts on one page and moves over the left or right part of another.
  const drag = (from, to, { side = 'left', finish = 'pointerup' } = {}) => js(`(() => {
    const pane = ${PANE};
    pane.setPointerCapture = () => {};
    const list = ${CELLS};
    const a = list[${from}].getBoundingClientRect();
    const b = list[${to}].getBoundingClientRect();
    const start = { clientX: a.left + a.width / 2, clientY: a.top + a.height / 2, button: 0, pointerId: 1, bubbles: true };
    list[${from}].dispatchEvent(new PointerEvent('pointerdown', start));
    const end = { ...start, clientX: b.left + ('${side}' === 'right' ? b.width - 4 : 4), clientY: b.top + b.height / 2 };
    pane.dispatchEvent(new PointerEvent('pointermove', end));
    const line = pane.querySelector('.organize-drop-line');
    const ghost = document.querySelector('.organize-ghost');
    const seen = {
      line: !line.hidden,
      lineLeft: parseFloat(line.style.left),
      targetLeft: list[${to}].offsetLeft,
      ghost: ghost?.textContent ?? null,
      dragged: pane.querySelectorAll('.organize-cell.dragged').length,
    };
    if ('${finish}' !== 'none') pane.dispatchEvent(new PointerEvent('${finish}', end));
    delete pane.setPointerCapture;
    seen.ghostLeft = document.querySelector('.organize-ghost') !== null;
    return seen;
  })()`);

  // ---- Going in
  const source = copy('mixed.pdf', 'pages.pdf');
  const sourceBytes = fs.readFileSync(source);
  await openCopy(source);
  await enter(4);
  check('organize: the reading toolbar and thumbnails make way', await js(`document.getElementById('toolbar').offsetHeight === 0 && document.getElementById('organize-bar').offsetHeight > 0 && document.getElementById('sidebar').offsetHeight === 0`));
  check('organize: the reading page is out of sight', await js(`getComputedStyle(document.querySelector('.viewer-host.active')).visibility === 'hidden'`));
  check('organize: every page shows with its number', same(await numbers(), ['1', '2', '3', '4']), JSON.stringify(await numbers()));
  check('organize: the count is shown', (await text('org-count')) === '共 4 頁', await text('org-count'));
  check('organize: what may be lost is shown', (await text('org-limits')).includes('書籤'));
  await waitFor(`${CELLS}.every((c) => c.dataset.drawn)`, 'all pictures drawn');
  const inkOf = (position) => js(`(() => {
    const c = ${CELLS}[${position}].querySelector('canvas');
    if (!c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
    return ink;
  })()`);
  for (const position of [0, 1, 2, 3]) {
    check(`organize: picture ${position + 1} has its page on it`, (await inkOf(position)) > 100, String(await inkOf(position)));
  }
  const lastPage = await js(`(() => { const r = ${CELLS}[3].querySelector('canvas').getBoundingClientRect(); return r.width > r.height; })()`);
  check('organize: the last page has its own shape, not the shape it had before being read', lastPage);
  const pictureBox = (position) => js(`(() => { const r = ${CELLS}[${position}].querySelector('canvas').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  const tall = await pictureBox(0);
  const wide = await pictureBox(1);
  check('organize: tall and wide pages show as they are', tall.height > tall.width && wide.width > wide.height, JSON.stringify([tall, wide]));
  check('organize: pictures are at the chosen size', Math.abs(tall.height - 180) < 1 && Math.abs(wide.width - 180) < 1, JSON.stringify([tall, wide]));
  for (const id of ['org-undo', 'org-redo', 'org-save', 'org-left', 'org-right', 'org-delete', 'org-extract']) {
    check(`organize: ${id} waits until there is something to do`, await disabled(id));
  }
  for (const id of ['org-saveas', 'org-insert', 'org-split', 'org-exit']) check(`organize: ${id} is ready`, !(await disabled(id)));
  await ctx.shot('60-organize');

  await press('p', { ctrlKey: true });
  await press('f', { ctrlKey: true });
  await pause(100);
  check('organize: printing and searching wait for the reading view', await js(`!document.getElementById('print-dialog').open && document.getElementById('findbar').hidden`));

  // ---- Choosing pages
  await clickCell(1);
  check('choose: a click picks one page', same(await chosen(), [1]));
  check('choose: the count says so', (await text('org-count')).includes('已選 1 頁'), await text('org-count'));
  check('choose: buttons wake up', !(await disabled('org-delete')) && !(await disabled('org-right')) && !(await disabled('org-extract')));
  await clickCell(3, { ctrlKey: true });
  check('choose: Ctrl+click adds', same(await chosen(), [1, 3]));
  await clickCell(1, { ctrlKey: true });
  check('choose: Ctrl+click on a chosen page takes it off', same(await chosen(), [3]));
  await clickCell(1);
  await clickCell(3, { shiftKey: true });
  check('choose: Shift+click picks a run', same(await chosen(), [1, 2, 3]));
  await clickCell(0, { shiftKey: true });
  check('choose: Shift+click works backwards from the same page', same(await chosen(), [0, 1]));
  await press('a', { ctrlKey: true });
  check('choose: Ctrl+A picks all', same(await chosen(), [0, 1, 2, 3]));
  await clickCell(2);
  check('choose: a plain click on a chosen page narrows to it', same(await chosen(), [2]));
  await js(`(() => {
    const pane = ${PANE};
    const content = pane.querySelector('.organize-pages');
    const r = content.getBoundingClientRect();
    content.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 2, clientY: r.top + 2, button: 0, pointerId: 1, bubbles: true }));
  })()`);
  check('choose: a click between pages clears it', same(await chosen(), []));
  await clickCell(0);
  await press('Escape');
  check('choose: Esc clears it', same(await chosen(), []));

  // ---- Dragging
  await clickCell(3);
  const dragLast = await drag(3, 0);
  check('drag: shows where it will land, and how many', dragLast.line && dragLast.ghost === '1 頁' && dragLast.dragged === 1, JSON.stringify(dragLast));
  check('drag: the line sits just left of the page', dragLast.lineLeft < dragLast.targetLeft, JSON.stringify(dragLast));
  check('drag: nothing is left on screen afterwards', !dragLast.ghostLeft && (await js(`${PANE}.querySelector('.organize-drop-line').hidden && !${PANE}.querySelector('.organize-cell.dragged')`)));
  check('drag: the page moves to the front', same(await order(), [4, 1, 2, 3]), JSON.stringify(await order()));
  check('drag: the numbers follow the new order', same(await numbers(), ['1', '2', '3', '4']));
  check('drag: it stays chosen', same(await chosen(), [0]));
  check('dirty: the tab says there are changes', await isDirty());
  check('dirty: the window title says so too', (await js('document.title')).startsWith('● '), await js('document.title'));
  check('dirty: saving and undoing wake up', !(await disabled('org-save')) && !(await disabled('org-undo')));

  await press('z', { ctrlKey: true });
  check('undo: Ctrl+Z puts it back', same(await order(), [1, 2, 3, 4]));
  check('undo: back to where it was, nothing is unsaved', !(await isDirty()) && (await disabled('org-save')));
  check('undo: the title loses its mark', !(await js('document.title')).startsWith('● '));
  check('undo: the choice survives', same(await chosen(), [3]));
  await press('y', { ctrlKey: true });
  check('redo: Ctrl+Y does it again', same(await order(), [4, 1, 2, 3]) && (await isDirty()));
  await press('z', { ctrlKey: true });
  await press('z', { ctrlKey: true, shiftKey: true });
  check('redo: Ctrl+Shift+Z too', same(await order(), [4, 1, 2, 3]));
  await click('org-undo');
  check('undo: the button works', same(await order(), [1, 2, 3, 4]));
  await click('org-redo');
  check('redo: the button works', same(await order(), [4, 1, 2, 3]));
  await click('org-undo');

  await clickCell(1);
  await clickCell(2, { shiftKey: true });
  const dragTwo = await drag(1, 3, { side: 'right' });
  check('drag: several go together', dragTwo.ghost === '2 頁' && dragTwo.dragged === 2, JSON.stringify(dragTwo));
  check('drag: they land together, in order', same(await order(), [1, 4, 2, 3]), JSON.stringify(await order()));
  check('drag: all still chosen', same(await chosen(), [2, 3]));
  await click('org-undo');

  await clickCell(1);
  const undoable = await disabled('org-undo');
  await drag(1, 1, { side: 'right' });
  check('drag: letting go in the same place changes nothing', same(await order(), [1, 2, 3, 4]) && (await disabled('org-undo')) === undoable && !(await isDirty()));
  await drag(1, 3, { finish: 'lostpointercapture' });
  check('drag: losing the pointer cancels it', same(await order(), [1, 2, 3, 4]));
  check('drag: nothing is left on screen after that', await js(`document.querySelector('.organize-ghost') === null`));
  const held = await drag(1, 3, { finish: 'none' });
  check('drag: still going until let go', held.ghostLeft);
  await press('Escape');
  check('drag: Esc cancels it', same(await order(), [1, 2, 3, 4]) && (await js(`document.querySelector('.organize-ghost') === null`)));
  check('drag: and leaves the choice alone', same(await chosen(), [1]));
  await js(`${PANE}.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))`);

  // ---- Turning
  const turnOf = (position) => js(`${CELLS}[${position}].querySelector('canvas').style.transform`);
  await clickCell(0);
  await click('org-right');
  check('turn: right turns the picture', (await turnOf(0)) === 'rotate(90deg)', await turnOf(0));
  const turned = await pictureBox(0);
  check('turn: a tall page now shows wide', turned.width > turned.height, JSON.stringify(turned));
  check('turn: it still fits its place', turned.width < 181, JSON.stringify(turned));
  check('turn: other pages stay', (await turnOf(1)) === '');
  check('turn: counts as a change', await isDirty());
  await click('org-left');
  check('turn: left turns it back', (await turnOf(0)) === '');
  check('turn: back to the start is no change', !(await isDirty()));
  await click('org-left');
  check('turn: left goes the other way', (await turnOf(0)) === 'rotate(270deg)', await turnOf(0));
  for (let i = 0; i < 3; i++) await click('org-left');
  check('turn: all the way round is no change', !(await isDirty()) && (await turnOf(0)) === '');
  for (let i = 0; i < 4; i++) await press('z', { ctrlKey: true });
  await press('z', { ctrlKey: true });
  await press('z', { ctrlKey: true });
  check('undo: everything can be stepped back', await disabled('org-undo'));

  // ---- Deleting
  await clickCell(1);
  await press('Delete');
  check('delete: the Delete key removes it', same(await order(), [1, 3, 4]) && same(await numbers(), ['1', '2', '3']));
  check('delete: the count follows', (await text('org-count')) === '共 3 頁', await text('org-count'));
  await press('z', { ctrlKey: true });
  check('delete: undo brings it back', same(await order(), [1, 2, 3, 4]));
  await waitFor(`${CELLS}.every((c) => c.dataset.drawn)`, 'the page comes back with its picture');
  check('delete: and its picture', (await inkOf(1)) > 100);
  await clickCell(2);
  await click('org-delete');
  check('delete: the button works', same(await order(), [1, 2, 4]));
  await press('z', { ctrlKey: true });
  await press('a', { ctrlKey: true });
  await clearToast();
  await press('Delete');
  check('delete: all pages cannot go', same(await order(), [1, 2, 3, 4]) && (await toast()).includes('至少要留一頁'), await toast());

  // ---- Thumbnail size
  const setSize = (size) => js(`(() => { const s = document.getElementById('org-size'); s.value = ${size}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setSize(300);
  check('size: the slider changes the frames at once', await js(`Math.abs(${CELLS}[0].querySelector('.organize-frame').getBoundingClientRect().width - 300) < 1`));
  await waitFor(`Math.max(${CELLS}[0].querySelector('canvas').width, ${CELLS}[0].querySelector('canvas').height) >= 300`, 'sharper pictures after making them bigger');
  check('size: the pictures are drawn again, sharper', await js(`${CELLS}[0].querySelector('canvas').height >= 300`));
  await setSize(180);
  await waitFor(`${CELLS}.every((c) => c.dataset.drawn) && Math.abs(${CELLS}[0].querySelector('canvas').getBoundingClientRect().height - 180) < 1`, 'back to the first size');

  // Ctrl and the wheel do the same as the slider
  const wheel = (position, deltaY, ctrlKey = true) => js(`(() => {
    const cell = ${CELLS}[${position}];
    const r = cell.getBoundingClientRect();
    cell.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, ctrlKey: ${ctrlKey}, clientX: r.left + 20, clientY: r.top + 20, bubbles: true, cancelable: true }));
  })()`);
  const frameSize = () => js(`Math.round(${CELLS}[0].querySelector('.organize-frame').getBoundingClientRect().width)`);
  const sliderValue = () => js(`Number(document.getElementById('org-size').value)`);
  await wheel(0, -100);
  check('wheel: Ctrl+wheel up makes them bigger', (await frameSize()) === 200 && (await sliderValue()) === 200, `${await frameSize()} / ${await sliderValue()}`);
  await wheel(0, 100);
  await wheel(0, 100);
  check('wheel: Ctrl+wheel down makes them smaller', (await frameSize()) === 160 && (await sliderValue()) === 160, String(await frameSize()));
  await wheel(0, -100, false);
  check('wheel: without Ctrl it does not change the size', (await frameSize()) === 160);
  for (let i = 0; i < 2; i++) await wheel(0, -20);
  check('wheel: small touchpad movements wait until they add up', (await frameSize()) === 160);
  for (let i = 0; i < 2; i++) await wheel(0, -20);
  check('wheel: and then count as one step', (await frameSize()) === 180, String(await frameSize()));
  for (let i = 0; i < 20; i++) await wheel(0, -100);
  check('wheel: stops at the biggest size', (await frameSize()) === 320 && (await sliderValue()) === 320, String(await frameSize()));
  for (let i = 0; i < 20; i++) await wheel(0, 100);
  check('wheel: stops at the smallest size', (await frameSize()) === 100 && (await sliderValue()) === 100, String(await frameSize()));
  await press('=', { ctrlKey: true });
  check('wheel: Ctrl+= works too', (await frameSize()) === 120);
  await press('-', { ctrlKey: true });
  check('wheel: Ctrl+- works too', (await frameSize()) === 100);
  await press('0', { ctrlKey: true });
  check('wheel: Ctrl+0 goes back to the normal size', (await frameSize()) === 180 && (await sliderValue()) === 180);

  // The page under the pointer stays there, even in a list that has to scroll.
  await setSize(320);
  await pause(100);
  const anchored = await js(`(() => {
    const pane = ${PANE};
    pane.style.height = '300px';
    pane.scrollTop = 150;
    const cell = ${CELLS}[1];
    const before = cell.getBoundingClientRect();
    cell.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: before.left + 20, clientY: before.top + 100, bubbles: true, cancelable: true }));
    const after = cell.getBoundingClientRect();
    const share = 100 / before.height;
    const moved = Math.abs(after.top + share * after.height - (before.top + 100));
    pane.style.height = '';
    return { moved, scrollTop: pane.scrollTop };
  })()`);
  check('wheel: the page under the pointer stays put', anchored.moved < 2, JSON.stringify(anchored));
  await setSize(180);
  await js(`${PANE}.scrollTop = 0`);
  await waitFor(`${CELLS}.every((c) => c.dataset.drawn) && Math.abs(${CELLS}[0].querySelector('canvas').getBoundingClientRect().height - 180) < 1`, 'back to the first size after the wheel');

  // ---- Inserting
  ctx.setPicked([fixture('square.pdf')]);
  await clickCell(1);
  await click('org-insert');
  await waitFor(`${CELLS}.length === 5`, 'inserted page');
  await notBusy();
  check('insert: goes after the chosen page', same(await order(), [1, 2, 'square.pdf:1', 3, 4]), JSON.stringify(await order()));
  check('insert: the new pages are chosen', same(await chosen(), [2]));
  await waitFor(`${CELLS}[2].dataset.drawn`, 'picture of the inserted page');
  check('insert: its picture comes from the other file', (await inkOf(2)) > 50);
  await press('z', { ctrlKey: true });
  check('insert: undo takes it out', same(await order(), [1, 2, 3, 4]));
  await press('y', { ctrlKey: true });
  await press('Escape');
  ctx.setPicked([fixture('annotated.pdf')]);
  await click('org-insert');
  await waitFor(`${CELLS}.length === 6`, 'inserted at the end');
  await notBusy();
  check('insert: with nothing chosen it goes at the end', same(await order(), [1, 2, 'square.pdf:1', 3, 4, 'annotated.pdf:1']), JSON.stringify(await order()));
  await press('z', { ctrlKey: true });
  await press('z', { ctrlKey: true });
  for (const [name, expected] of [['enc-owner-no-print.pdf', '受保護'], ['enc-open-password.pdf', '受保護'], ['corrupt.pdf', '無法插入'], ['empty.pdf', '無法插入']]) {
    await clearToast();
    ctx.setPicked([fixture(name)]);
    await click('org-insert');
    await waitToast(expected);
    await notBusy();
    check(`insert: ${name} is refused with a reason`, (await toast()).includes(expected) && same(await order(), [1, 2, 3, 4]), await toast());
    check(`insert: ${name} never asks for a password`, await js(`!document.getElementById('password-dialog').open`));
  }
  ctx.setPicked([]);
  await click('org-insert');
  await pause(100);
  check('insert: cancelling the picker changes nothing', same(await order(), [1, 2, 3, 4]) && !(await disabled('org-insert')));

  // ---- Taking pages out
  const extracted = inFolder('extracted.pdf');
  await clickCell(1);
  await clickCell(2, { ctrlKey: true });
  await click('org-right');
  await clearToast();
  ctx.setSaveTarget(null);
  await click('org-extract');
  await pause(150);
  await notBusy();
  check('extract: cancelling Save As writes nothing', !fs.existsSync(extracted) && (await toast()) === '');
  check('extract: suggests a name', ctx.saveOptions().defaultPath === inFolder('pages_擷取.pdf'), ctx.saveOptions().defaultPath);
  ctx.setSaveTarget(extracted);
  await click('org-extract');
  await waitToast('已把 2 頁');
  await notBusy();
  const extractedInfo = await pdfInfo(extracted);
  check('extract: only the chosen pages, as they look now', same(extractedInfo.sizes, [WIDE, TALL]) && same(extractedInfo.angles, [90, 90]), JSON.stringify(extractedInfo));
  check('extract: nothing changes on screen', same(await order(), [1, 2, 3, 4]) && (await isDirty()) && same(await chosen(), [1, 2]));
  check('extract: the original is untouched', fs.readFileSync(source).equals(sourceBytes));
  await press('z', { ctrlKey: true });

  // ---- Save As: move, turn, delete and insert, then read the file back
  await clickCell(0);
  await click('org-right');
  await clickCell(3);
  await drag(3, 0);
  await clickCell(3);
  await press('Delete');
  check('save as: pages ready', same(await order(), [4, 1, 2]), JSON.stringify(await order()));
  ctx.setPicked([fixture('square.pdf')]);
  await press('Escape');
  await click('org-insert');
  await waitFor(`${CELLS}.length === 4`, 'inserted before saving');
  await notBusy();
  await js(`${PANE}.scrollTop = 40`);
  await clickCell(1);

  const saved = inFolder('saved.pdf');
  for (const [target, expected] of [[source, '不能另存到正在整理的檔案上'], [fixture('square.pdf'), '不能另存到正在整理的檔案上']]) {
    await clearToast();
    ctx.setSaveTarget(target);
    await click('org-saveas');
    await waitToast(expected);
    await notBusy();
    check('save as: not onto a file in use here', (await toast()).includes(expected) && (await isDirty()), await toast());
  }
  await clearToast();
  ctx.setSaveTarget(null);
  await click('org-saveas');
  await pause(150);
  await notBusy();
  check('save as: cancelling keeps everything', (await isDirty()) && same(await order(), [4, 1, 2, 'square.pdf:1']));
  check('save as: suggests a name', ctx.saveOptions().defaultPath === inFolder('pages_整理.pdf'), ctx.saveOptions().defaultPath);
  ctx.setSaveTarget(saved);
  await press('s', { ctrlKey: true });
  await waitToast('已另存成「saved.pdf」');
  await notBusy();
  const savedInfo = await pdfInfo(saved);
  check('save as: the file has the new order', same(savedInfo.sizes, [WIDE, TALL, WIDE, SQUARE]), JSON.stringify(savedInfo));
  check('save as: the turn is in the file', same(savedInfo.angles, [0, 90, 0, 0]), JSON.stringify(savedInfo));
  check('save as: the original is untouched', fs.readFileSync(source).equals(sourceBytes));
  check('save as: the tab now shows the new file', (await js(`document.querySelector('.tab[aria-selected="true"] .tab-name').textContent`)) === 'saved.pdf');
  check('save as: still organizing, nothing unsaved', (await organizing()) && !(await isDirty()) && (await disabled('org-save')));
  check('save as: the list starts over from the new file', same(await order(), [1, 2, 3, 4]) && (await disabled('org-undo')), JSON.stringify(await order()));
  check('save as: the same pages stay chosen', same(await chosen(), [1]), JSON.stringify(await chosen()));
  check('save as: the view keeps its place', (await js(`${PANE}.scrollTop`)) >= 0);
  await waitFor(`${CELLS}.every((c) => c.dataset.drawn)`, 'pictures of the new file');
  const afterSave = await pictureBox(1);
  check('save as: a turned page shows from its own rotation now', afterSave.width > afterSave.height && (await turnOf(1)) === '', JSON.stringify(afterSave));
  await pause(200);
  check('save as: the old file and the inserted one are let go', heldFiles.size === heldBefore + 1, String(heldFiles.size - heldBefore));
  check('save as: nothing is left beside it', same(fs.readdirSync(folder).sort(), ['extracted.pdf', 'pages.pdf', 'saved.pdf']), fs.readdirSync(folder).join());
  await ctx.shot('61-organize-saved');

  // ---- Saving over the original
  const savedBytes = fs.readFileSync(saved);
  await clickCell(0);
  await press('Delete');
  await click('org-save');
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked before overwriting');
  check('save: asks first, and says it cannot be undone', (await text('org-dialog-text')).includes('無法復原'), await text('org-dialog-text'));
  check('save: offers only to go ahead or not', await js(`document.getElementById('org-dialog-discard').hidden && document.getElementById('org-dialog-saveas').hidden && !document.getElementById('org-dialog-overwrite').hidden`));
  await click('org-dialog-cancel');
  await pause(100);
  check('save: no means no', fs.readFileSync(saved).equals(savedBytes) && (await isDirty()));

  let lock = null;
  try {
    lock = await lockLikeAnotherProgram(saved);
  } catch (err) {
    check('save: could lock a file for the test', false, err.message);
  }
  if (lock) {
    await clearToast();
    await click('org-save');
    await waitFor(`document.getElementById('organize-dialog').open`, 'asked again');
    await click('org-dialog-overwrite');
    await waitToast('正在被其他程式使用');
    await notBusy();
    await lock.release();
    check('save: a locked file gets the plain message', (await toast()).includes('或改用另存新檔'), await toast());
    check('save: and nothing is lost', fs.readFileSync(saved).equals(savedBytes) && (await isDirty()) && same(await order(), [2, 3, 4]));
  }

  await clearToast();
  await click('org-save');
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked once more');
  await click('org-dialog-overwrite');
  await waitToast('已儲存「saved.pdf」');
  await notBusy();
  const overwritten = await pdfInfo(saved);
  check('save: the file is replaced', same(overwritten.sizes, [TALL, WIDE, SQUARE]) && same(overwritten.angles, [90, 0, 0]), JSON.stringify(overwritten));
  check('save: same tab, nothing unsaved', (await js(`document.querySelector('.tab[aria-selected="true"] .tab-name').textContent`)) === 'saved.pdf' && !(await isDirty()));
  check('save: the list follows', same(await order(), [1, 2, 3]));
  await pause(200);
  check('save: nothing is left beside it', same(fs.readdirSync(folder).sort(), ['extracted.pdf', 'pages.pdf', 'saved.pdf']), fs.readdirSync(folder).join());
  check('save: only one hold on the file', heldFiles.size === heldBefore + 1, String(heldFiles.size - heldBefore));

  // ---- Leaving with and without changes
  await click('org-exit');
  await waitFor(`!document.body.classList.contains('organizing')`, 'left with nothing to save');
  check('leave: with nothing unsaved it just goes', await js(`!document.getElementById('organize-dialog').open`));
  check('leave: the reading view is back, with the saved file', (await text('page-total')) === '/ 3' && (await js(`document.getElementById('toolbar').offsetHeight > 0`)), await text('page-total'));
  check('leave: the page shows', await waitFor(`(() => {
    const c = document.querySelector('.viewer-host.active .page canvas');
    return Boolean(c && c.width) && getComputedStyle(document.querySelector('.viewer-host.active')).visibility === 'visible';
  })()`, 'the page is drawn again'));

  await enter(3);
  await clickCell(0);
  await press('Delete');
  const beforeLeaving = fs.readFileSync(saved);
  await click('org-exit');
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked before leaving');
  check('leave: offers every way out', await js(`['cancel', 'discard', 'overwrite', 'saveas'].every((name) => !document.getElementById('org-dialog-' + name).hidden)`));
  await click('org-dialog-cancel');
  await waitFor(`!document.getElementById('organize-dialog').open`, 'dialog closed');
  check('leave: cancel stays', (await organizing()) && (await isDirty()));
  await click('org-exit');
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked again');
  await click('org-dialog-discard');
  await waitFor(`!document.body.classList.contains('organizing')`, 'left without saving');
  check('leave: not saving leaves the file alone', fs.readFileSync(saved).equals(beforeLeaving));
  check('leave: and the mark goes', !(await isDirty()) && (await text('page-total')) === '/ 3');

  await enter(3);
  await clickCell(0);
  await click('org-right');
  await click('org-exit');
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked before leaving');
  await click('org-dialog-overwrite');
  await waitFor(`!document.body.classList.contains('organizing')`, 'left after overwriting');
  check('leave: overwriting from there saves and goes', same((await pdfInfo(saved)).angles, [180, 0, 0]), JSON.stringify((await pdfInfo(saved)).angles));

  // ---- Closing a tab
  await enter(3);
  await clickCell(0);
  await press('Delete');
  const tabsNow = await tabCount();
  await press('w', { ctrlKey: true });
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked before closing the tab');
  ctx.setSaveTarget(null);
  await click('org-dialog-saveas');
  await pause(200);
  await notBusy();
  check('close tab: cancelling Save As keeps the tab', (await tabCount()) === tabsNow && (await isDirty()));
  const closedSave = inFolder('saved-from-close.pdf');
  ctx.setSaveTarget(closedSave);
  await js(`document.querySelector('.tab[aria-selected="true"] .tab-close').click()`);
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked again');
  await click('org-dialog-saveas');
  await waitFor(`document.querySelectorAll('.tab').length === ${tabsNow - 1}`, 'tab closed after saving');
  check('close tab: Save As from there saves and closes', same((await pdfInfo(closedSave)).sizes, [WIDE, SQUARE]), JSON.stringify((await pdfInfo(closedSave)).sizes));
  await pause(200);
  check('close tab: nothing is left open', heldFiles.size === heldBefore, String(heldFiles.size - heldBefore));

  // ---- Protected files, and the view rotation
  await openCopy(copy('enc-owner-no-print.pdf', 'protected.pdf'));
  await clearToast();
  await click('btn-organize');
  await waitToast('此檔案受保護，無法整理頁面');
  check('protected: stays in the reading view with a clear reason', !(await organizing()));
  await closeTabNamed('protected.pdf');

  const rotatedFile = copy('mixed.pdf', 'rotated.pdf');
  await openCopy(rotatedFile);
  await click('btn-rotate-right');
  await enter(4);
  check('view rotation: says it does not count', (await text('org-note')).includes('畫面的旋轉'), await text('org-note'));
  await clickCell(0);
  await click('org-right');
  const rotatedOut = inFolder('rotated-out.pdf');
  ctx.setSaveTarget(rotatedOut);
  await click('org-saveas');
  await waitToast('已另存成「rotated-out.pdf」');
  await notBusy();
  check('view rotation: is not saved, only the real turn', same((await pdfInfo(rotatedOut)).angles, [90, 0, 0, 0]), JSON.stringify((await pdfInfo(rotatedOut)).angles));
  check('view rotation: the note goes with the new view', (await text('org-note')) === '');
  await click('org-exit');
  await waitFor(`!document.body.classList.contains('organizing')`, 'left');

  // ---- Splitting from here
  await enter(4);
  await clickCell(0);
  await press('Delete');
  await clearToast();
  await click('org-split');
  await waitToast('請先儲存');
  check('split: waits for changes to be saved', await js(`!document.getElementById('split-dialog').open`));
  await press('z', { ctrlKey: true });
  await click('org-split');
  await waitFor(`document.getElementById('split-dialog').open`, 'split dialog from organizing');
  check('split: opens on this file', (await text('split-file')).includes('rotated-out.pdf'), await text('split-file'));
  await click('split-close');
  await waitFor(`!document.getElementById('split-dialog').open`, 'split dialog closed');
  check('split: back in organizing afterwards', await organizing());

  // ---- Each tab keeps its own
  const second = copy('square.pdf', 'second.pdf');
  await clickCell(1);
  await clickCell(2, { ctrlKey: true });
  await press('Delete');
  await openCopy(second);
  check('tabs: another tab is in the reading view', !(await organizing()) && (await js(`document.getElementById('toolbar').offsetHeight > 0`)));
  check('tabs: its title has no mark', !(await js('document.title')).startsWith('● '));
  check('tabs: the other tab still shows its mark', await js(`document.querySelector('.tab.dirty .tab-name').textContent === 'rotated-out.pdf'`));
  await selectTab('rotated-out.pdf');
  check('tabs: coming back finds it as it was', (await organizing()) && same(await order(), [1, 4]), JSON.stringify(await order()));
  await clearToast();
  ctx.setSaveTarget(second);
  await click('org-saveas');
  await waitToast('已在其他分頁或視窗開啟');
  await notBusy();
  check('tabs: cannot save onto a file open in another tab', (await isDirty()) && same((await pdfInfo(second)).sizes, [SQUARE]), await toast());
  await press('Tab', { ctrlKey: true });
  await waitFor(`!document.body.classList.contains('organizing')`, 'Ctrl+Tab away');
  check('tabs: Ctrl+Tab still works from organizing', true);
  await closeTabNamed('second.pdf');
  await selectTab('rotated-out.pdf');

  // ---- Closing the window with unsaved changes
  check('close window: changes are there to lose', await isDirty());
  win.close();
  await waitFor(`document.getElementById('organize-dialog').open`, 'asked before closing the window');
  check('close window: it stays open while asking', !win.isDestroyed());
  win.close();
  await pause(150);
  check('close window: asking twice shows it once', await js(`document.querySelectorAll('dialog[open]').length === 1`));
  await click('org-dialog-cancel');
  await pause(200);
  check('close window: cancel keeps everything', !win.isDestroyed() && (await isDirty()));

  // Everything else about closing is at the very end of run.js.
  await press('z', { ctrlKey: true });
  check('close window: nothing unsaved again', !(await isDirty()));
  await click('org-exit');
  await waitFor(`!document.body.classList.contains('organizing')`, 'left');
  await closeTabNamed('rotated-out.pdf');

  // ---- A long document
  openFiles([fixture('big-500pages.pdf')]);
  await waitFor(`document.getElementById('page-total').textContent === '/ 500'`, '500 page file', 40000);
  const bigStart = Date.now();
  await click('btn-organize');
  await waitFor(`document.body.classList.contains('organizing') && ${CELLS}.length === 500`, '500 pages in organize mode');
  await waitFor(`${CELLS}[0].dataset.drawn`, 'first picture of 500');
  const bigMs = Date.now() - bigStart;
  check('long: 500 pages open quickly', bigMs < 3000, `${bigMs} ms`);
  await pause(1500);
  const drawnFew = await js(`${CELLS}.filter((c) => c.dataset.drawn).length`);
  check('long: only pages near the view are drawn', drawnFew > 0 && drawnFew < 120, String(drawnFew));
  await js(`${PANE}.scrollTop = ${PANE}.scrollHeight`);
  await waitFor(`${CELLS}[499].dataset.drawn`, 'last picture of 500', 30000);
  await waitFor(`!${CELLS}[0].dataset.drawn && ${CELLS}[0].querySelector('canvas').width === 0`, 'far pages let go');
  check('long: pages far away give their memory back', await js(`${CELLS}[0].querySelector('canvas').width === 0`));
  await clickCell(499);
  await js(`${PANE}.scrollTop = 0`);
  const dragMs = Date.now();
  await drag(499, 0);
  check('long: moving a page is instant', Date.now() - dragMs < 1000 && same((await order()).slice(0, 2), [500, 1]), `${Date.now() - dragMs} ms`);
  await press('a', { ctrlKey: true });
  await clickCell(0, { ctrlKey: true });
  const deleteMs = Date.now();
  await press('Delete');
  check('long: deleting 499 pages is instant', Date.now() - deleteMs < 1000 && same(await order(), [500]), `${Date.now() - deleteMs} ms`);
  const undoMs = Date.now();
  await press('z', { ctrlKey: true });
  check('long: undoing it is instant', Date.now() - undoMs < 1000 && (await js(`${CELLS}.length`)) === 500, `${Date.now() - undoMs} ms`);
  const bigOut = inFolder('big-out.pdf');
  ctx.setSaveTarget(bigOut);
  const saveMs = Date.now();
  await click('org-saveas');
  await waitToast('已另存成「big-out.pdf」');
  await notBusy();
  check('long: saving 500 reordered pages takes seconds', Date.now() - saveMs < 15000, `${Date.now() - saveMs} ms`);
  check('long: all there', (await pdfInfo(bigOut)).sizes.length === 500);
  await click('org-exit');
  await waitFor(`!document.body.classList.contains('organizing')`, 'left the long document');
  await closeTabNamed('big-out.pdf');

  await pause(300);
  check('organize: nothing is left open', heldFiles.size === heldBefore, String(heldFiles.size - heldBefore));
  check('organize: tabs are back to how they were', (await tabCount()) === tabsBefore, `${await tabCount()} vs ${tabsBefore}`);
  check('organize: nothing but finished files in the folder', fs.readdirSync(folder).every((name) => name.endsWith('.pdf')), fs.readdirSync(folder).join());
  fs.rmSync(folder, { recursive: true, force: true });
};
