const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { PDFDocument, PDFName, PDFArray } = require('@cantoo/pdf-lib');
const { removeOldTempFiles, rotateLandscapeClockwise, visibleSize, writeClockwiseCopy } = require('../lib/normalize');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

async function rotatedPages(name) {
  const { bytes, rotated } = await rotateLandscapeClockwise(fixture(name));
  const doc = await PDFDocument.load(bytes);
  return { doc, rotated, pages: doc.getPages() };
}

function annotationCount(doc) {
  return doc.getPages().reduce((sum, page) => {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    return sum + (annots instanceof PDFArray ? annots.size() : 0);
  }, 0);
}

test('mixed: only the landscape pages turn, and all end up upright', async () => {
  const { pages, rotated } = await rotatedPages('mixed.pdf');
  assert.equal(rotated, 2);
  assert.deepEqual(pages.map((p) => p.getRotation().angle), [0, 90, 0, 90]);
  for (const page of pages) {
    const { width, height } = visibleSize(page);
    assert.ok(width <= height);
  }
});

test('portrait size with /Rotate=90 looks landscape, so it turns', async () => {
  const { pages, rotated } = await rotatedPages('prerotated.pdf');
  assert.equal(rotated, 1);
  assert.equal(pages[0].getRotation().angle, 180);
  const { width, height } = visibleSize(pages[0]);
  assert.ok(width <= height);
});

test('landscape size with /Rotate=90 looks portrait, so it stays', async () => {
  const { pages, rotated } = await rotatedPages('landscape-rotated.pdf');
  assert.equal(rotated, 0);
  assert.equal(pages[0].getRotation().angle, 90);
});

test('square pages stay', async () => {
  const { pages, rotated } = await rotatedPages('square.pdf');
  assert.equal(rotated, 0);
  assert.equal(pages[0].getRotation().angle, 0);
});

test('annotations survive the turn', async () => {
  const before = await PDFDocument.load(fixture('annotated.pdf'));
  const { doc, rotated } = await rotatedPages('annotated.pdf');
  assert.equal(rotated, 1);
  assert.equal(annotationCount(before), 2);
  assert.equal(annotationCount(doc), 2);
});

test('protected files are refused rather than damaged, so the caller can fall back', async () => {
  for (const name of ['enc-open-password.pdf', 'enc-owner-print-allowed.pdf', 'enc-owner-no-print.pdf']) {
    await assert.rejects(rotateLandscapeClockwise(fixture(name)));
  }
});

test('document details are not overwritten', async () => {
  const source = await PDFDocument.create({ updateMetadata: false });
  source.setProducer('原本的製作程式');
  source.addPage([800, 400]);
  const { bytes } = await rotateLandscapeClockwise(await source.save());
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(doc.getProducer(), '原本的製作程式');
});

test('temporary copy: leaves the original alone and goes in the temp folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-normalize-'));
  const source = path.join(__dirname, 'fixtures', 'mixed.pdf');
  const before = fs.readFileSync(source);
  const copy = await writeClockwiseCopy(source, path.join(dir, 'new-folder'));
  assert.ok(copy.startsWith(path.join(dir, 'new-folder')));
  assert.match(path.basename(copy), /^print-.*\.pdf$/);
  assert.ok(before.equals(fs.readFileSync(source)));
  const doc = await PDFDocument.load(fs.readFileSync(copy));
  assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [0, 90, 0, 90]);
});

test('temporary copies: old ones are cleared, recent ones and other files stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-normalize-'));
  const old = path.join(dir, 'print-old.pdf');
  const recent = path.join(dir, 'print-recent.pdf');
  const other = path.join(dir, 'something-else.pdf');
  for (const file of [old, recent, other]) fs.writeFileSync(file, 'x');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
  await removeOldTempFiles(dir);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(other), true);
  await removeOldTempFiles(path.join(dir, 'missing'));
});
