const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFPageLeaf } = require('@cantoo/pdf-lib');
const { organizeFiles, splitFile } = require('../lib/pages');
const { PdfFiles } = require('../lib/pdf-files');

const list = () => import('../renderer/page-list.js');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-organize-'));
const load = (file) => PDFDocument.load(fs.readFileSync(file));
const allObjects = (doc) => doc.context.enumerateIndirectObjects().map(([, object]) => object);
const contains = (doc, text) => allObjects(doc).some((object) => object.toString().includes(text));
const pageObjectCount = (doc) => allObjects(doc).filter((object) => object instanceof PDFPageLeaf).length;
const sizes = (doc) => doc.getPages().map((page) => {
  const { width, height } = page.getSize();
  return `${Math.round(width)}x${Math.round(height)}`;
});
const angles = (doc) => doc.getPages().map((page) => page.getRotation().angle);
const TALL = '595x842';
const WIDE = '842x595';
// Pages of one file: at(0), at(2, 90) is page 1, then page 3 turned right.
const at = (index, turn = 0, source = 0) => ({ source, index, turn });
const marks = (doc) => doc.getPages().map((page) => {
  const contents = page.node.Contents();
  const streams = contents.asArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const found = /PAGE(\d)-MARK/.exec(streams.map(String).join(''));
  return found ? Number(found[1]) : null;
});
const keysOf = (pages) => pages.map((page) => page.key);

// ---- The list of pages

async function fresh(count = 5) {
  const { pagesOf } = await list();
  let key = 0;
  return pagesOf(0, count, () => ++key);
}

test('pages move in front of the chosen place, in the order they had', async () => {
  const { movePages } = await list();
  const pages = await fresh();
  assert.deepStrictEqual(keysOf(movePages(pages, new Set([4]), 1)), [1, 4, 2, 3, 5]);
  assert.deepStrictEqual(keysOf(movePages(pages, new Set([1]), 5)), [2, 3, 4, 5, 1]);
  assert.deepStrictEqual(keysOf(movePages(pages, new Set([1, 3]), 5)), [2, 4, 5, 1, 3]);
  assert.deepStrictEqual(keysOf(movePages(pages, new Set([5, 2]), 0)), [2, 5, 1, 3, 4]);
  assert.deepStrictEqual(keysOf(movePages(pages, new Set([2, 4]), 3)), [1, 3, 2, 4, 5]);
});

test('letting pages go where they already are is no change', async () => {
  const { movePages } = await list();
  const pages = await fresh();
  assert.strictEqual(movePages(pages, new Set([2]), 1), pages);
  assert.strictEqual(movePages(pages, new Set([2]), 2), pages);
  assert.strictEqual(movePages(pages, new Set([2, 3]), 2), pages);
  assert.strictEqual(movePages(pages, new Set([1, 2, 3, 4, 5]), 2), pages);
  assert.strictEqual(movePages(pages, new Set(), 2), pages);
});

test('turning goes round in quarter turns, either way', async () => {
  const { turnPages } = await list();
  const pages = await fresh(2);
  const right = turnPages(pages, new Set([1]), 90);
  assert.deepStrictEqual(right.map((page) => page.turn), [90, 0]);
  assert.strictEqual(right[1], pages[1]);
  assert.strictEqual(turnPages(right, new Set([1]), -90)[0].turn, 0);
  assert.strictEqual(turnPages(pages, new Set([1]), -90)[0].turn, 270);
});

test('new pages go after the last chosen page, or at the end', async () => {
  const { insertPages, placeAfter } = await list();
  const pages = await fresh(3);
  assert.strictEqual(placeAfter(pages, new Set([1, 2])), 2);
  assert.strictEqual(placeAfter(pages, new Set()), 3);
  const added = [{ key: 9, source: 1, index: 0, turn: 0 }];
  assert.deepStrictEqual(keysOf(insertPages(pages, added, 2)), [1, 2, 9, 3]);
  assert.deepStrictEqual(keysOf(insertPages(pages, added, 3)), [1, 2, 3, 9]);
});

test('a run of pages can be chosen in either direction', async () => {
  const { keysBetween } = await list();
  const pages = await fresh();
  assert.deepStrictEqual(keysBetween(pages, 2, 4), [2, 3, 4]);
  assert.deepStrictEqual(keysBetween(pages, 4, 2), [2, 3, 4]);
  assert.deepStrictEqual(keysBetween(pages, 99, 3), [3]);
});

test('where a dragged page lands, row by row', async () => {
  const { dropTarget } = await list();
  const boxes = [0, 100, 0].map((left, i) => ({ left, top: i < 2 ? 0 : 200, width: 100, height: 150 }));
  assert.strictEqual(dropTarget(boxes, 10, 50), 0);
  assert.strictEqual(dropTarget(boxes, 60, 50), 1);
  assert.strictEqual(dropTarget(boxes, 160, 50), 2, 'right part of the last in a row');
  assert.strictEqual(dropTarget(boxes, 500, 50), 2, 'past the end of a row');
  assert.strictEqual(dropTarget(boxes, 10, 170), 2, 'between the rows');
  assert.strictEqual(dropTarget(boxes, 10, 250), 2);
  assert.strictEqual(dropTarget(boxes, 60, 250), 3);
  assert.strictEqual(dropTarget(boxes, 10, 900), 3, 'below everything');
  assert.strictEqual(dropTarget([], 0, 0), 0);
});

test('undo and redo step through the changes', async () => {
  const { PageHistory, removePages, turnPages } = await list();
  const pages = await fresh(3);
  const history = new PageHistory(pages);
  assert.deepStrictEqual([history.canUndo, history.canRedo, history.dirty], [false, false, false]);
  assert.strictEqual(history.undo(), false);
  assert.strictEqual(history.apply(removePages(pages, new Set([2]))), true);
  history.apply(turnPages(history.pages, new Set([1]), 90));
  assert.deepStrictEqual(keysOf(history.pages), [1, 3]);
  assert.strictEqual(history.dirty, true);
  history.undo();
  assert.strictEqual(history.pages[0].turn, 0);
  history.undo();
  assert.strictEqual(history.pages, pages);
  assert.strictEqual(history.dirty, false, 'back to where it was saved');
  history.redo();
  assert.deepStrictEqual(keysOf(history.pages), [1, 3]);
  assert.strictEqual(history.dirty, true);
  assert.strictEqual(history.canRedo, true);
  history.apply(turnPages(history.pages, new Set([3]), 90));
  assert.strictEqual(history.canRedo, false, 'a new change drops what could be redone');
});

test('a change that changes nothing is not an edit', async () => {
  const { PageHistory, movePages, removePages, turnPages } = await list();
  const pages = await fresh(3);
  const history = new PageHistory(pages);
  assert.strictEqual(history.apply(movePages(pages, new Set([2]), 2)), false);
  assert.strictEqual(history.apply(removePages(pages, new Set())), false);
  assert.strictEqual(history.canUndo, false);
  for (let i = 0; i < 4; i++) history.apply(turnPages(history.pages, new Set([1]), 90));
  assert.strictEqual(history.dirty, false, 'four quarter turns is where it started');
  assert.strictEqual(history.canUndo, true);
});

test('what was saved counts as the new starting point', async () => {
  const { PageHistory, removePages } = await list();
  const pages = await fresh(3);
  const history = new PageHistory(pages);
  history.apply(removePages(pages, new Set([2])));
  history.markSaved();
  assert.strictEqual(history.dirty, false);
  history.undo();
  assert.strictEqual(history.dirty, true);
});

// ---- Writing the file

test('reordering gives the pages in the new order', async () => {
  const target = path.join(folder(), 'out.pdf');
  const result = await organizeFiles([fixture('mixed.pdf')], [at(3), at(2), at(1), at(0)], target);
  assert.deepStrictEqual(result, { ok: true, name: 'out.pdf', path: target, pages: 4 });
  assert.deepStrictEqual(sizes(await load(target)), [WIDE, TALL, WIDE, TALL]);
  const linked = path.join(folder(), 'linked.pdf');
  await organizeFiles([fixture('linked.pdf')], [at(2), at(0), at(1)], linked);
  assert.deepStrictEqual(marks(await load(linked)), [3, 1, 2]);
});

test('a deleted page is really gone from the file', async () => {
  const target = path.join(folder(), 'out.pdf');
  await organizeFiles([fixture('linked.pdf')], [at(0), at(2)], target);
  const doc = await load(target);
  assert.strictEqual(doc.getPageCount(), 2);
  assert.strictEqual(pageObjectCount(doc), 2);
  assert.ok(!contains(doc, 'PAGE2-MARK'), 'content of the deleted page');
  // Each page holds 120 KB of data that cannot be compressed.
  assert.ok(fs.statSync(target).size < 0.8 * fs.statSync(fixture('linked.pdf')).size, `size ${fs.statSync(target).size}`);
});

test('a link between pages still leads to the right page after moving them', async () => {
  const target = path.join(folder(), 'out.pdf');
  await organizeFiles([fixture('linked.pdf')], [at(1), at(0)], target);
  const doc = await load(target);
  assert.strictEqual(pageObjectCount(doc), 2);
  const first = doc.getPage(1);
  assert.deepStrictEqual(marks(doc), [2, 1]);
  const internal = doc.context.lookup(first.node.Annots().get(0));
  assert.strictEqual(doc.context.lookup(internal.get(PDFName.of('Dest'))).get(0), doc.getPage(0).ref);
});

test('turning a page adds to the rotation it has, and only on that page', async () => {
  const dir = folder();
  const target = path.join(dir, 'out.pdf');
  await organizeFiles([fixture('mixed.pdf')], [at(0, 90), at(1), at(2, 270), at(3, 180)], target);
  assert.deepStrictEqual(angles(await load(target)), [90, 0, 270, 180]);
  const turned = path.join(dir, 'turned.pdf');
  await organizeFiles([fixture('prerotated.pdf')], [at(0, 270)], turned);
  assert.deepStrictEqual(angles(await load(turned)), [0]);
  const moved = path.join(dir, 'moved.pdf');
  await organizeFiles([fixture('mixed.pdf')], [at(1, 90), at(0)], moved);
  assert.deepStrictEqual(angles(await load(moved)), [90, 0]);
});

test('annotations come along when pages are moved or turned', async () => {
  const target = path.join(folder(), 'out.pdf');
  await organizeFiles([fixture('annotated.pdf')], [at(0, 90)], target);
  assert.strictEqual((await load(target)).getPage(0).node.Annots().size(), 2);
  const merged = path.join(folder(), 'merged.pdf');
  await organizeFiles([fixture('mixed.pdf'), fixture('annotated.pdf')], [at(0, 90, 1), at(0)], merged);
  const doc = await load(merged);
  assert.strictEqual(doc.getPage(0).node.Annots().size(), 2);
  assert.strictEqual(doc.getPage(0).getRotation().angle, 90);
});

test('pages from another file can go anywhere among the others', async () => {
  const target = path.join(folder(), 'out.pdf');
  const layout = [at(0), at(0, 0, 1), at(1), at(2), at(3)];
  assert.strictEqual((await organizeFiles([fixture('mixed.pdf'), fixture('square.pdf')], layout, target)).pages, 5);
  assert.deepStrictEqual(sizes(await load(target)), [TALL, '500x500', WIDE, TALL, WIDE]);
});

test('the same file can be added to itself', async () => {
  const target = path.join(folder(), 'out.pdf');
  const mixed = fixture('mixed.pdf');
  await organizeFiles([mixed, mixed], [at(1), at(1, 0, 1), at(0, 90, 1)], target);
  const doc = await load(target);
  assert.deepStrictEqual(sizes(doc), [WIDE, WIDE, TALL]);
  assert.strictEqual(pageObjectCount(doc), 3);
  assert.strictEqual(new Set(doc.getPages().map((page) => page.ref)).size, 3, 'separate pages');
});

test('nothing changed gives the file byte for byte', async () => {
  const target = path.join(folder(), 'out.pdf');
  await organizeFiles([fixture('annotated.pdf')], [at(0)], target);
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(fixture('annotated.pdf'))));
});

test('turning pages without moving them keeps what merging would lose', async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  const original = await PDFDocument.create();
  original.addPage([300, 500]);
  original.addPage([300, 500]);
  const form = original.getForm();
  form.createTextField('name').addToPage(original.getPage(0));
  original.catalog.set(PDFName.of('PageLabels'), original.context.obj({ Nums: [0, { S: 'r' }] }));
  original.setTitle('A title');
  fs.writeFileSync(source, await original.save());
  const target = path.join(dir, 'out.pdf');
  await organizeFiles([source], [at(0, 90), at(1)], target);
  const doc = await load(target);
  assert.deepStrictEqual(angles(doc), [90, 0]);
  assert.ok(doc.catalog.has(PDFName.of('PageLabels')), 'page labels stay');
  assert.ok(doc.catalog.has(PDFName.of('AcroForm')), 'the form stays');
  assert.strictEqual(doc.getTitle(), 'A title');
});

test('a reorganized file keeps its title', async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  const original = await PDFDocument.create();
  original.addPage([300, 500]);
  original.addPage([300, 500]);
  original.setTitle('A title');
  original.setAuthor('An author');
  fs.writeFileSync(source, await original.save());
  const target = path.join(dir, 'out.pdf');
  await organizeFiles([source], [at(1), at(0)], target);
  const doc = await load(target);
  assert.strictEqual(doc.getTitle(), 'A title');
  assert.strictEqual(doc.getAuthor(), 'An author');
});

test('a layout that makes no sense is refused', async () => {
  const dir = folder();
  const target = path.join(dir, 'out.pdf');
  const mixed = [fixture('mixed.pdf')];
  for (const layout of [
    [], null, 'x', [null], [at(9)], [at(-1)], [at(0.5)], [at(0, 45)], [at(0, 360)], [at(0, '90')],
    [at(0, 0, 1)], [at(0), at(0)], [{ source: 0, index: 0 }],
  ]) {
    assert.deepStrictEqual(await organizeFiles(mixed, layout, target), { ok: false, reason: 'BAD_REQUEST' }, JSON.stringify(layout));
  }
  assert.deepStrictEqual(await organizeFiles([], [at(0)], target), { ok: false, reason: 'BAD_REQUEST' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('protected and unreadable files give a clear reason and leave nothing behind', async () => {
  const dir = folder();
  const target = path.join(dir, 'out.pdf');
  for (const name of ['enc-owner-print-allowed.pdf', 'enc-owner-no-print.pdf', 'enc-open-password.pdf']) {
    assert.deepStrictEqual(await organizeFiles([fixture(name)], [at(0)], target), { ok: false, reason: 'PROTECTED', file: name });
  }
  assert.deepStrictEqual(await organizeFiles([fixture('corrupt.pdf')], [at(0)], target), { ok: false, reason: 'CANNOT_READ', file: 'corrupt.pdf' });
  assert.deepStrictEqual(await organizeFiles([path.join(dir, 'gone.pdf')], [at(0)], target), { ok: false, reason: 'CANNOT_READ', file: 'gone.pdf' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a file added but no longer used does not get in the way', async () => {
  const target = path.join(folder(), 'out.pdf');
  const result = await organizeFiles([fixture('mixed.pdf'), fixture('corrupt.pdf')], [at(1), at(0)], target);
  assert.strictEqual(result.ok, true);
});

test('saving a copy onto a file being organized is refused, whatever the case', async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  const other = path.join(dir, 'other.pdf');
  fs.copyFileSync(fixture('mixed.pdf'), source);
  fs.copyFileSync(fixture('square.pdf'), other);
  const layout = [at(1), at(0), at(0, 0, 1)];
  for (const target of [source, source.toUpperCase(), other]) {
    assert.deepStrictEqual(await organizeFiles([source, other], layout, target), { ok: false, reason: 'SAME_FILE' });
  }
});

test('saving over the open original works, and what has it open keeps reading the old file', async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  fs.copyFileSync(fixture('mixed.pdf'), source);
  const before = fs.readFileSync(source);
  const files = new PdfFiles();
  const { file } = await files.register(source);
  const result = await organizeFiles([source], [at(1), at(0)], source, { overOriginal: true });
  assert.deepStrictEqual(result, { ok: true, name: 'source.pdf', path: source, pages: 2 });
  assert.deepStrictEqual(sizes(await load(source)), [WIDE, TALL]);
  const stillOld = await files.read(file.id, 0, before.length);
  assert.ok(Buffer.from(stillOld).equals(before), 'old contents through the old handle');
  await files.close(file.id);
  assert.deepStrictEqual(fs.readdirSync(dir), ['source.pdf'], 'nothing left beside it');
});

test('a failed save over the original leaves it as it was', async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  fs.copyFileSync(fixture('mixed.pdf'), source);
  const before = fs.readFileSync(source);
  assert.strictEqual((await organizeFiles([source], [at(9)], source, { overOriginal: true })).ok, false);
  assert.strictEqual((await organizeFiles([source, fixture('corrupt.pdf')], [at(0, 0, 1)], source, { overOriginal: true })).ok, false);
  assert.ok(fs.readFileSync(source).equals(before));
  assert.deepStrictEqual(fs.readdirSync(dir), ['source.pdf']);
});

// Node opens files so that others may still move them; many programs do not.
function lockLikeAnotherProgram(file) {
  const script = '$f = [IO.File]::Open($env:LOCK_PATH, "Open", "Read", "Read"); "ready"; [Console]::In.ReadLine() | Out-Null; $f.Close()';
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
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

test('a file another program has locked is reported as in use, and stays as it was', { skip: process.platform !== 'win32' }, async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  fs.copyFileSync(fixture('mixed.pdf'), source);
  const before = fs.readFileSync(source);
  const lock = await lockLikeAnotherProgram(source);
  try {
    assert.deepStrictEqual(await organizeFiles([source], [at(1), at(0)], source, { overOriginal: true }), { ok: false, reason: 'IN_USE' });
  } finally {
    await lock.release();
  }
  assert.ok(fs.readFileSync(source).equals(before));
  assert.deepStrictEqual(fs.readdirSync(dir), ['source.pdf']);
});

test('a copy onto a file another program holds is reported as in use', { skip: process.platform !== 'win32' }, async () => {
  const dir = folder();
  const target = path.join(dir, 'locked.pdf');
  fs.writeFileSync(target, 'what was here before');
  const handle = fs.openSync(target, 'r');
  try {
    assert.deepStrictEqual(await organizeFiles([fixture('mixed.pdf')], [at(1), at(0)], target), { ok: false, reason: 'IN_USE' });
  } finally {
    fs.closeSync(handle);
  }
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'what was here before');
  assert.deepStrictEqual(fs.readdirSync(dir), ['locked.pdf']);
});

test('a page taken out alone does not bring the pages it links to', async () => {
  const target = path.join(folder(), 'out.pdf');
  await organizeFiles([fixture('linked.pdf')], [at(0)], target);
  const doc = await load(target);
  assert.ok(contains(doc, 'PAGE1-MARK'));
  assert.ok(!contains(doc, 'PAGE2-MARK') && !contains(doc, 'PAGE3-MARK'));
  assert.strictEqual(pageObjectCount(doc), 1);
});

test('the open-file list knows a file by path, whatever the case', async () => {
  const files = new PdfFiles();
  const { file } = await files.register(fixture('mixed.pdf'));
  assert.strictEqual(files.isOpen(fixture('mixed.pdf')), true);
  assert.strictEqual(files.isOpen(fixture('mixed.pdf').toUpperCase()), true);
  assert.strictEqual(files.isOpen(fixture('square.pdf')), false);
  await files.close(file.id);
  assert.strictEqual(files.isOpen(fixture('mixed.pdf')), false);
});

test('merging and splitting still work after the shared code changed', async () => {
  const dir = folder();
  const result = await splitFile(fixture('mixed.pdf'), [{ from: 2, to: 3, suffix: '2-3' }], dir);
  assert.deepStrictEqual(result, { ok: true, names: ['mixed_2-3.pdf'] });
  assert.deepStrictEqual(sizes(await load(path.join(dir, 'mixed_2-3.pdf'))), [WIDE, TALL]);
});

// ---- The thumbnail column

test('the column stays between its limits and leaves room for the pages', async () => {
  const { clampWidth } = await import('../renderer/sidebar-width.js');
  assert.strictEqual(clampWidth(300, 1920), 300);
  assert.strictEqual(clampWidth(10, 1920), 120);
  assert.strictEqual(clampWidth(5000, 1920), 560);
  assert.strictEqual(clampWidth(5000, 800), 480);
  assert.strictEqual(clampWidth(5000, 300), 120, 'even in a very small window');
  assert.strictEqual(clampWidth(300.6, 1920), 301);
  assert.strictEqual(clampWidth(5000, Infinity), 560);
});

test('the oldest thumbnails out of view are let go first, only when over the budget', async () => {
  const { picturesToLetGo } = await import('../renderer/thumbnails.js');
  const kept = new Map([[1, { bytes: 40 }], [2, { bytes: 40 }], [3, { bytes: 40 }], [4, { bytes: 40 }]]);
  assert.deepStrictEqual(picturesToLetGo(kept, new Set(), 160), [], 'fits');
  assert.deepStrictEqual(picturesToLetGo(kept, new Set(), 120), [1]);
  assert.deepStrictEqual(picturesToLetGo(kept, new Set(), 70), [1, 2, 3]);
  assert.deepStrictEqual(picturesToLetGo(kept, new Set([1, 2]), 70), [3, 4], 'what is in view stays');
  assert.deepStrictEqual(picturesToLetGo(kept, new Set([1, 2, 3, 4]), 0), [], 'even over the budget');
});
