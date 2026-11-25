const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFPageLeaf } = require('@cantoo/pdf-lib');
const { mergeFiles, rotateAllPages, saveCopy, splitFile } = require('../lib/pages');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-pages-'));
const angles = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((page) => page.getRotation().angle);
const annotationCount = async (bytes) => (await PDFDocument.load(bytes)).getPages()
  .reduce((sum, page) => sum + (page.node.lookup(PDFName.of('Annots'))?.size() ?? 0), 0);

test('every page turns by the same amount', async () => {
  const bytes = fs.readFileSync(fixture('mixed.pdf'));
  assert.deepStrictEqual(await angles(await rotateAllPages(bytes, 90)), [90, 90, 90, 90]);
  assert.deepStrictEqual(await angles(await rotateAllPages(bytes, 270)), [270, 270, 270, 270]);
});

test('a turn adds to the rotation a page already has', async () => {
  const bytes = fs.readFileSync(fixture('prerotated.pdf'));
  assert.deepStrictEqual(await angles(bytes), [90]);
  assert.deepStrictEqual(await angles(await rotateAllPages(bytes, 90)), [180]);
  assert.deepStrictEqual(await angles(await rotateAllPages(bytes, 270)), [0]);
});

test('annotations survive the turn', async () => {
  const bytes = fs.readFileSync(fixture('annotated.pdf'));
  assert.ok((await annotationCount(bytes)) >= 2);
  assert.strictEqual(await annotationCount(await rotateAllPages(bytes, 90)), await annotationCount(bytes));
});

test('without a turn the copy is byte for byte the same', async () => {
  const target = path.join(folder(), 'copy.pdf');
  const result = await saveCopy(fixture('annotated.pdf'), target, 0);
  assert.deepStrictEqual(result, { ok: true, name: 'copy.pdf' });
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(fixture('annotated.pdf'))));
});

test('a protected file can be copied as it is, protection included', async () => {
  const target = path.join(folder(), 'copy.pdf');
  assert.strictEqual((await saveCopy(fixture('enc-owner-no-print.pdf'), target, 0)).ok, true);
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(fixture('enc-owner-no-print.pdf'))));
});

test('a protected file cannot be saved turned, and leaves nothing behind', async () => {
  for (const name of ['enc-owner-print-allowed.pdf', 'enc-owner-no-print.pdf', 'enc-open-password.pdf']) {
    const dir = folder();
    const result = await saveCopy(fixture(name), path.join(dir, 'turned.pdf'), 90);
    assert.deepStrictEqual(result, { ok: false, reason: 'PROTECTED' }, name);
    assert.deepStrictEqual(fs.readdirSync(dir), [], name);
  }
});

test('a file pdf-lib cannot read gives a clear reason', async () => {
  const dir = folder();
  const result = await saveCopy(fixture('corrupt.pdf'), path.join(dir, 'turned.pdf'), 90);
  assert.deepStrictEqual(result, { ok: false, reason: 'CANNOT_ROTATE' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('saving over the file being read is refused, whatever the case', async () => {
  const dir = folder();
  const source = path.join(dir, 'original.pdf');
  fs.copyFileSync(fixture('mixed.pdf'), source);
  const before = fs.readFileSync(source);
  for (const target of [source, source.toUpperCase(), path.join(dir, '.', 'original.pdf')]) {
    assert.deepStrictEqual(await saveCopy(source, target, 90), { ok: false, reason: 'SAME_FILE' });
  }
  assert.ok(fs.readFileSync(source).equals(before));
});

test('an existing file is replaced only once the new one is complete', async () => {
  const dir = folder();
  const target = path.join(dir, 'existing.pdf');
  fs.writeFileSync(target, 'what was here before');
  assert.strictEqual((await saveCopy(fixture('corrupt.pdf'), target, 90)).ok, false);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'what was here before');
  assert.strictEqual((await saveCopy(fixture('mixed.pdf'), target, 90)).ok, true);
  assert.deepStrictEqual(await angles(fs.readFileSync(target)), [90, 90, 90, 90]);
  assert.deepStrictEqual(fs.readdirSync(dir), ['existing.pdf']);
});

test('a folder that cannot be written to gives a clear reason', async () => {
  const target = path.join(folder(), 'no-such-folder', 'copy.pdf');
  assert.deepStrictEqual(await saveCopy(fixture('mixed.pdf'), target, 0), { ok: false, reason: 'CANNOT_WRITE' });
  assert.deepStrictEqual(await saveCopy(fixture('mixed.pdf'), target, 90), { ok: false, reason: 'CANNOT_WRITE' });
});

test('a source file that has gone away gives a clear reason', async () => {
  const dir = folder();
  assert.deepStrictEqual(await saveCopy(path.join(dir, 'gone.pdf'), path.join(dir, 'copy.pdf'), 0), { ok: false, reason: 'CANNOT_WRITE' });
  assert.deepStrictEqual(await saveCopy(path.join(dir, 'gone.pdf'), path.join(dir, 'copy.pdf'), 90), { ok: false, reason: 'CANNOT_WRITE' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('only quarter turns are accepted', async () => {
  const dir = folder();
  for (const rotation of [45, 360, -90, '90', null, undefined]) {
    assert.deepStrictEqual(await saveCopy(fixture('mixed.pdf'), path.join(dir, 'copy.pdf'), rotation), { ok: false, reason: 'BAD_REQUEST' });
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

// ---- Merging and splitting

const load = (file) => PDFDocument.load(fs.readFileSync(file));
const allObjects = (doc) => doc.context.enumerateIndirectObjects().map(([, object]) => object);
const pageObjectCount = (doc) => allObjects(doc).filter((object) => object instanceof PDFPageLeaf).length;
const contains = (doc, text) => allObjects(doc).some((object) => object.toString().includes(text));
const pageSizes = (doc) => doc.getPages().map((page) => {
  const { width, height } = page.getSize();
  return `${Math.round(width)}x${Math.round(height)}`;
});
const A4_TALL = '595x842';
const A4_WIDE = '842x595';
const parts = (...items) => items.map(([from, to, suffix]) => ({ from, to, suffix }));

test('merging keeps every page, in the order given', async () => {
  const target = path.join(folder(), 'merged.pdf');
  const result = await mergeFiles([fixture('mixed.pdf'), fixture('small-page.pdf'), fixture('square.pdf')], target);
  assert.deepStrictEqual(result, { ok: true, name: 'merged.pdf', path: target, pages: 6 });
  assert.deepStrictEqual(pageSizes(await load(target)), [A4_TALL, A4_WIDE, A4_TALL, A4_WIDE, '298x420', '500x500']);
  const reversed = path.join(folder(), 'reversed.pdf');
  await mergeFiles([fixture('square.pdf'), fixture('mixed.pdf')], reversed);
  assert.deepStrictEqual(pageSizes(await load(reversed)), ['500x500', A4_TALL, A4_WIDE, A4_TALL, A4_WIDE]);
});

test('merging keeps annotations, and a page\'s own rotation', async () => {
  const target = path.join(folder(), 'merged.pdf');
  await mergeFiles([fixture('mixed.pdf'), fixture('annotated.pdf'), fixture('prerotated.pdf')], target);
  const doc = await load(target);
  assert.strictEqual(doc.getPageCount(), 6);
  assert.strictEqual(doc.getPage(4).node.Annots().size(), 2);
  assert.strictEqual(doc.getPage(5).getRotation().angle, 90);
});

test('annotations point at the page they sit on, and no extra page objects appear', async () => {
  const target = path.join(folder(), 'merged.pdf');
  await mergeFiles([fixture('annotated.pdf'), fixture('mixed.pdf')], target);
  const doc = await load(target);
  assert.strictEqual(pageObjectCount(doc), 5);
  const first = doc.getPage(0);
  for (const entry of first.node.Annots().asArray()) {
    assert.strictEqual(doc.context.lookup(entry).get(PDFName.of('P')), first.ref);
  }
});

test('settings a page inherits from the page tree come along', async () => {
  const dir = folder();
  const source = path.join(dir, 'inherited.pdf');
  const original = await PDFDocument.create();
  const page = original.addPage([300, 500]);
  page.node.delete(PDFName.of('MediaBox'));
  page.node.delete(PDFName.of('Rotate'));
  const tree = original.context.lookup(page.node.get(PDFName.of('Parent')));
  tree.set(PDFName.of('MediaBox'), original.context.obj([0, 0, 300, 500]));
  tree.set(PDFName.of('Rotate'), original.context.obj(90));
  fs.writeFileSync(source, await original.save());
  await splitFile(source, parts([1, 1, '1']), dir);
  const copy = await load(path.join(dir, 'inherited_1.pdf'));
  assert.strictEqual(copy.getPage(0).getRotation().angle, 90);
  assert.deepStrictEqual(pageSizes(copy), ['300x500']);
});

test('a source file left out of a merge is named when it cannot be read', async () => {
  const dir = folder();
  const target = path.join(dir, 'merged.pdf');
  assert.deepStrictEqual(
    await mergeFiles([fixture('mixed.pdf'), fixture('enc-owner-no-print.pdf')], target),
    { ok: false, reason: 'PROTECTED', file: 'enc-owner-no-print.pdf' },
  );
  assert.deepStrictEqual(
    await mergeFiles([fixture('corrupt.pdf'), fixture('mixed.pdf')], target),
    { ok: false, reason: 'CANNOT_READ', file: 'corrupt.pdf' },
  );
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a merge cannot be saved over one of its own files', async () => {
  const dir = folder();
  const source = path.join(dir, 'source.pdf');
  fs.copyFileSync(fixture('mixed.pdf'), source);
  const before = fs.readFileSync(source);
  assert.deepStrictEqual(
    await mergeFiles([fixture('square.pdf'), source], source.toUpperCase()),
    { ok: false, reason: 'SAME_FILE' },
  );
  assert.ok(fs.readFileSync(source).equals(before));
});

test('merging replaces an existing file only when finished', async () => {
  const dir = folder();
  const target = path.join(dir, 'existing.pdf');
  fs.writeFileSync(target, 'what was here before');
  await mergeFiles([fixture('corrupt.pdf')], target);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'what was here before');
  assert.strictEqual((await mergeFiles([fixture('square.pdf')], target)).ok, true);
  assert.strictEqual((await load(target)).getPageCount(), 1);
  assert.deepStrictEqual(fs.readdirSync(dir), ['existing.pdf']);
});

test('a file another program holds open is reported as in use, and stays as it was', { skip: process.platform !== 'win32' }, async () => {
  const dir = folder();
  const target = path.join(dir, 'locked.pdf');
  fs.writeFileSync(target, 'what was here before');
  const handle = fs.openSync(target, 'r');
  try {
    assert.deepStrictEqual(await mergeFiles([fixture('square.pdf')], target), { ok: false, reason: 'IN_USE' });
    assert.deepStrictEqual(await saveCopy(fixture('square.pdf'), target, 0), { ok: false, reason: 'IN_USE' });
  } finally {
    fs.closeSync(handle);
  }
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'what was here before');
  assert.deepStrictEqual(fs.readdirSync(dir), ['locked.pdf']);
});

test('splitting by ranges gives one file for each, with the right pages', async () => {
  const dir = folder();
  const progress = [];
  const result = await splitFile(fixture('linked.pdf'), parts([1, 2, '1-2'], [3, 3, '3']), dir, (done, total) => progress.push([done, total]));
  assert.deepStrictEqual(result, { ok: true, names: ['linked_1-2.pdf', 'linked_3.pdf'] });
  assert.deepStrictEqual(progress, [[1, 2], [2, 2]]);
  const [first, second] = [await load(path.join(dir, 'linked_1-2.pdf')), await load(path.join(dir, 'linked_3.pdf'))];
  assert.strictEqual(first.getPageCount(), 2);
  assert.ok(contains(first, 'PAGE1-MARK') && contains(first, 'PAGE2-MARK'));
  assert.strictEqual(second.getPageCount(), 1);
  assert.ok(contains(second, 'PAGE3-MARK') && !contains(second, 'PAGE1-MARK'));
});

test('splitting page by page gives one file a page', async () => {
  const dir = folder();
  const result = await splitFile(fixture('mixed.pdf'), parts([1, 1, '1'], [2, 2, '2'], [3, 3, '3'], [4, 4, '4']), dir);
  assert.deepStrictEqual(result.names, ['mixed_1.pdf', 'mixed_2.pdf', 'mixed_3.pdf', 'mixed_4.pdf']);
  assert.deepStrictEqual(pageSizes(await load(path.join(dir, 'mixed_2.pdf'))), [A4_WIDE]);
  assert.deepStrictEqual(pageSizes(await load(path.join(dir, 'mixed_3.pdf'))), [A4_TALL]);
});

test('a page taken alone does not carry the pages it links to', async () => {
  const dir = folder();
  await splitFile(fixture('linked.pdf'), parts([1, 1, '1']), dir);
  const file = path.join(dir, 'linked_1.pdf');
  const doc = await load(file);
  assert.ok(contains(doc, 'PAGE1-MARK'));
  assert.ok(!contains(doc, 'PAGE2-MARK') && !contains(doc, 'PAGE3-MARK'), 'content of other pages');
  assert.strictEqual(pageObjectCount(doc), 1);
  // Each page holds 120 KB of data that cannot be compressed.
  assert.ok(fs.statSync(file).size < 0.5 * fs.statSync(fixture('linked.pdf')).size, `size ${fs.statSync(file).size}`);
  // Only the link to an outside web page is left.
  assert.strictEqual(doc.getPage(0).node.Annots().size(), 1);
});

test('a link between two pages that stay still leads to the right page', async () => {
  const dir = folder();
  await splitFile(fixture('linked.pdf'), parts([1, 2, '1-2']), dir);
  const doc = await load(path.join(dir, 'linked_1-2.pdf'));
  assert.strictEqual(pageObjectCount(doc), 2);
  assert.ok(!contains(doc, 'PAGE3-MARK'), 'link and page action to page 3 must not bring it along');
  const annotations = doc.getPage(0).node.Annots();
  assert.strictEqual(annotations.size(), 2);
  const internal = doc.context.lookup(annotations.get(0));
  const destination = doc.context.lookup(internal.get(PDFName.of('Dest')));
  assert.strictEqual(destination.get(0), doc.getPage(1).ref);
});

test('merging a whole file keeps its links working', async () => {
  const target = path.join(folder(), 'merged.pdf');
  await mergeFiles([fixture('square.pdf'), fixture('linked.pdf')], target);
  const doc = await load(target);
  assert.strictEqual(pageObjectCount(doc), 4);
  const annotations = doc.getPage(1).node.Annots();
  assert.strictEqual(annotations.size(), 3);
  const internal = doc.context.lookup(annotations.get(0));
  assert.strictEqual(doc.context.lookup(internal.get(PDFName.of('Dest'))).get(0), doc.getPage(2).ref);
});

test('a page taken alone does not carry other pages\' form values', async () => {
  const dir = folder();
  await splitFile(fixture('form-across-pages.pdf'), parts([1, 1, '1']), dir);
  const doc = await load(path.join(dir, 'form-across-pages_1.pdf'));
  assert.ok(contains(doc, 'VALUE-ON-PAGE-1'), 'its own value stays');
  assert.ok(!contains(doc, 'VALUE-ON-PAGE-2'), 'the other page\'s value goes');
  const widget = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  assert.ok(!widget.has(PDFName.of('Parent')));
  assert.strictEqual(widget.get(PDFName.of('FT')).toString(), '/Tx');
});

test('names that are taken get a number, and the existing files are left alone', async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'mixed_1.pdf'), 'first');
  fs.writeFileSync(path.join(dir, 'mixed_1 (2).pdf'), 'second');
  const result = await splitFile(fixture('mixed.pdf'), parts([1, 1, '1'], [2, 2, '2']), dir);
  assert.deepStrictEqual(result.names, ['mixed_1 (3).pdf', 'mixed_2.pdf']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'mixed_1.pdf'), 'utf8'), 'first');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'mixed_1 (2).pdf'), 'utf8'), 'second');
  assert.strictEqual((await load(path.join(dir, 'mixed_1 (3).pdf'))).getPageCount(), 1);
});

test('the same range twice gives two files', async () => {
  const dir = folder();
  const result = await splitFile(fixture('mixed.pdf'), parts([1, 2, '1-2'], [1, 2, '1-2']), dir);
  assert.deepStrictEqual(result.names, ['mixed_1-2.pdf', 'mixed_1-2 (2).pdf']);
});

test('protected and unreadable files cannot be split, and leave nothing behind', async () => {
  const dir = folder();
  for (const name of ['enc-owner-print-allowed.pdf', 'enc-owner-no-print.pdf', 'enc-open-password.pdf']) {
    assert.deepStrictEqual(await splitFile(fixture(name), parts([1, 1, '1']), dir), { ok: false, reason: 'PROTECTED', written: 0 }, name);
  }
  assert.deepStrictEqual(await splitFile(fixture('corrupt.pdf'), parts([1, 1, '1']), dir), { ok: false, reason: 'CANNOT_READ', written: 0 });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a folder that cannot be written to says how far it got', async () => {
  const target = path.join(folder(), 'no-such-folder');
  assert.deepStrictEqual(await splitFile(fixture('mixed.pdf'), parts([1, 1, '1']), target), { ok: false, reason: 'CANNOT_WRITE', written: 0 });
});

test('page ranges outside the file, or odd names, are refused', async () => {
  const dir = folder();
  for (const bad of [
    parts([0, 1, '1']), parts([1, 5, '1-5']), parts([3, 2, '3-2']), parts([1.5, 2, '1']),
    parts([1, 1, '..\\..\\evil']), parts([1, 1, 'a/b']), [], null, 'x',
  ]) {
    assert.deepStrictEqual(await splitFile(fixture('mixed.pdf'), bad, dir), { ok: false, reason: 'BAD_REQUEST', written: 0 }, JSON.stringify(bad));
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('the original file is never changed', async () => {
  const before = fs.readFileSync(fixture('linked.pdf'));
  const dir = folder();
  await splitFile(fixture('linked.pdf'), parts([1, 1, '1']), dir);
  await mergeFiles([fixture('linked.pdf'), fixture('mixed.pdf')], path.join(dir, 'merged.pdf'));
  assert.ok(fs.readFileSync(fixture('linked.pdf')).equals(before));
});
