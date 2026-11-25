const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MAX_IMAGE_BYTES, imageDocument } = require('./images');
const { normalizeAngle } = require('./normalize');

const QUARTER_TURNS = [0, 90, 180, 270];
const PART_SUFFIX = /^\d+(-\d+)?$/;
// What a form field can pass down to its widgets. See detachFromField.
const INHERITED_FIELD_KEYS = ['FT', 'T', 'V', 'DV', 'Ff', 'DA', 'Q', 'MaxLen', 'Opt'];

// pdf-lib is only loaded when someone actually needs it, to keep startup fast.
const pdfLib = () => require('@cantoo/pdf-lib');

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function failureReason(err, whenUnreadable) {
  if (err?.code === 'TARGET_IN_USE') return 'IN_USE';
  if (err?.code) return 'CANNOT_WRITE';
  return err instanceof pdfLib().EncryptedPDFError ? 'PROTECTED' : whenUnreadable;
}

// The target is only replaced once the new file is complete, so a failure cannot
// damage what is there. Windows refuses to replace a file another program has open.
async function replaceFile(targetPath, writeTo) {
  const temp = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeTo(temp);
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
  try {
    await fs.promises.rename(temp, targetPath);
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw Object.assign(err, { code: 'TARGET_IN_USE' });
  }
}

// For a file this program has open itself. Replacing it directly would fail, but moving
// it aside works, and whatever is reading it goes on seeing the old contents until it
// closes. A program that locks the file makes the first move fail, with nothing changed.
async function replaceOpenFile(targetPath, writeTo) {
  const temp = `${targetPath}.${crypto.randomUUID()}.tmp`;
  const aside = `${targetPath}.${crypto.randomUUID()}.old`;
  const dropTemp = () => fs.promises.rm(temp, { force: true }).catch(() => {});
  try {
    await writeTo(temp);
  } catch (err) {
    await dropTemp();
    throw err;
  }
  try {
    await fs.promises.rename(targetPath, aside);
  } catch (err) {
    await dropTemp();
    throw Object.assign(err, { code: 'TARGET_IN_USE' });
  }
  try {
    await fs.promises.rename(temp, targetPath);
  } catch (err) {
    await fs.promises.rename(aside, targetPath).catch(() => {});
    await dropTemp();
    throw Object.assign(err, { code: 'TARGET_IN_USE' });
  }
  // While something still has it open this only marks it; it goes when that closes.
  await fs.promises.rm(aside, { force: true }).catch(() => {});
}

// Never touches an existing file: a name that is taken gets a number instead.
async function writeNewFile(folder, stem, bytes) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.pdf` : `${stem} (${n}).pdf`;
    const target = path.join(folder, name);
    try {
      await fs.promises.writeFile(target, bytes, { flag: 'wx' });
      return name;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      await fs.promises.rm(target, { force: true }).catch(() => {});
      throw err;
    }
  }
}

// Only each page's rotation setting changes, so annotations and forms stay intact.
async function rotateAllPages(bytes, rotation) {
  const { PDFDocument, degrees } = pdfLib();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const page of doc.getPages()) {
    page.setRotation(degrees((normalizeAngle(page.getRotation().angle) + rotation) % 360));
  }
  return doc.save();
}

// Without a turn the copy is byte for byte the same, protection included.
async function saveCopy(sourcePath, targetPath, rotation) {
  if (!QUARTER_TURNS.includes(rotation)) return { ok: false, reason: 'BAD_REQUEST' };
  if (samePath(sourcePath, targetPath)) return { ok: false, reason: 'SAME_FILE' };
  try {
    await replaceFile(targetPath, async (temp) => {
      if (rotation === 0) await fs.promises.copyFile(sourcePath, temp);
      else await fs.promises.writeFile(temp, await rotateAllPages(await fs.promises.readFile(sourcePath), rotation));
    });
    return { ok: true, name: path.basename(targetPath) };
  } catch (err) {
    return { ok: false, reason: failureReason(err, 'CANNOT_ROTATE') };
  }
}

function linkTarget(annotation, context) {
  const { PDFArray, PDFDict, PDFName } = pdfLib();
  let destination = context.lookup(annotation.get(PDFName.of('Dest')));
  if (!destination) {
    const action = context.lookup(annotation.get(PDFName.of('A')));
    if (action instanceof PDFDict) destination = context.lookup(action.get(PDFName.of('D')));
  }
  return destination instanceof PDFArray ? destination.get(0) : null;
}

// A widget's field can list every other widget of the form, with their values. Keeping
// the link would carry those along, so the widget takes what it needs and lets go.
function detachFromField(widget, context) {
  const { PDFDict, PDFName } = pdfLib();
  const parentKey = PDFName.of('Parent');
  let parent = context.lookup(widget.get(parentKey));
  while (parent instanceof PDFDict) {
    for (const key of INHERITED_FIELD_KEYS.map((name) => PDFName.of(name))) {
      if (!widget.has(key) && parent.has(key)) widget.set(key, parent.get(key));
    }
    parent = context.lookup(parent.get(parentKey));
  }
  widget.delete(parentKey);
}

// Links to a page that was left out would drag that whole page into the file, where it
// stays hidden but readable. This removes them, then drops everything nothing refers to.
function removeLeftOutPages(out) {
  const { PDFArray, PDFDict, PDFName, PDFNull, PDFPageLeaf, PDFRef, PDFStream } = pdfLib();
  const { context } = out;
  const pages = out.getPages();
  const kept = new Set(pages.map((page) => page.ref));
  const isLeftOut = (value) => value instanceof PDFRef && !kept.has(value) && context.lookup(value) instanceof PDFPageLeaf;
  const subtypeOf = (annotation) => context.lookup(annotation.get(PDFName.of('Subtype')))?.toString();

  for (const page of pages) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    const stay = annotations.asArray().filter((entry) => {
      const annotation = context.lookup(entry);
      if (!(annotation instanceof PDFDict)) return true;
      if (subtypeOf(annotation) === '/Link' && isLeftOut(linkTarget(annotation, context))) return false;
      if (subtypeOf(annotation) === '/Widget') detachFromField(annotation, context);
      annotation.set(PDFName.of('P'), page.ref);
      return true;
    });
    page.node.set(PDFName.of('Annots'), context.obj(stay));
  }

  const reached = new Set();
  const seen = new Set();
  const stack = [context.trailerInfo.Root, context.trailerInfo.Info];
  while (stack.length > 0) {
    let object = stack.pop();
    if (object instanceof PDFRef) {
      if (reached.has(object)) continue;
      reached.add(object);
      object = context.lookup(object);
    }
    if (!object || seen.has(object)) continue;
    seen.add(object);
    const dict = object instanceof PDFStream ? object.dict : object;
    if (dict instanceof PDFDict) {
      for (const [key, value] of dict.entries()) {
        if (isLeftOut(value)) dict.delete(key);
        else stack.push(value);
      }
    } else if (object instanceof PDFArray) {
      object.asArray().forEach((value, index) => {
        if (isLeftOut(value)) object.set(index, PDFNull);
        else stack.push(value);
      });
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(ref)) context.delete(ref);
  }
}

function turnPage(page, turn) {
  if (turn) page.setRotation(pdfLib().degrees((normalizeAngle(page.getRotation().angle) + turn) % 360));
}

// entries: [{ doc, index, turn }], in output order. Copying by reference, with one copier
// for each source, means a link between two copied pages points at the copy that is
// really in the file, however the pages were reordered.
async function buildDocument(entries, describe = () => {}) {
  const { PDFDocument, PDFObjectCopier, PDFPage } = pdfLib();
  const out = await PDFDocument.create();
  const copiers = new Map();
  for (const { doc, index, turn = 0 } of entries) {
    if (!copiers.has(doc)) copiers.set(doc, PDFObjectCopier.for(doc.context, out.context));
    const ref = copiers.get(doc).copy(doc.getPages()[index].ref);
    const page = PDFPage.of(out.context.lookup(ref), ref, out);
    out.addPage(page);
    turnPage(page, turn);
  }
  describe(out);
  removeLeftOutPages(out);
  return { bytes: await out.save(), pageCount: out.getPageCount() };
}

// The title and so on are a nicety: one that cannot be read never stops a save.
function copyDocumentInfo(from, to) {
  const copy = (read, write) => {
    try {
      const value = read();
      if (value) write(value);
    } catch {
      // Left out.
    }
  };
  copy(() => from.getTitle(), (value) => to.setTitle(value));
  copy(() => from.getAuthor(), (value) => to.setAuthor(value));
  copy(() => from.getSubject(), (value) => to.setSubject(value));
  copy(() => from.getKeywords(), (value) => to.setKeywords([value]));
  copy(() => from.getCreator(), (value) => to.setCreator(value));
  copy(() => from.getCreationDate(), (value) => to.setCreationDate(value));
}

async function loadForCopying(sourcePath) {
  const { PDFDocument } = pdfLib();
  return PDFDocument.load(await fs.promises.readFile(sourcePath), { updateMetadata: false });
}

// sources: PDF paths, or { image: path } for a picture that becomes a page of its own.
async function mergeFiles(sources, targetPath, { imagePaper = 'A4' } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return { ok: false, reason: 'BAD_REQUEST' };
  const sourcePath = (source) => (typeof source === 'string' ? source : source?.image);
  if (sources.some((source) => typeof sourcePath(source) !== 'string')) return { ok: false, reason: 'BAD_REQUEST' };
  if (sources.some((source) => samePath(sourcePath(source), targetPath))) return { ok: false, reason: 'SAME_FILE' };
  const parts = [];
  for (const source of sources) {
    try {
      if (typeof source === 'string') {
        const doc = await loadForCopying(source);
        parts.push(...doc.getPageIndices().map((index) => ({ doc, index })));
      } else {
        const bytes = await fs.promises.readFile(source.image);
        if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('too big'), { code: 'BAD_IMAGE' });
        parts.push({ doc: await imageDocument(bytes, imagePaper), index: 0 });
      }
    } catch (err) {
      const reason = err?.code === 'BAD_IMAGE' ? 'BAD_IMAGE' : err?.code === 'ENOENT' ? 'CANNOT_READ' : failureReason(err, 'CANNOT_READ');
      return { ok: false, reason, file: path.basename(sourcePath(source)) };
    }
  }
  try {
    const { bytes, pageCount } = await buildDocument(parts);
    await replaceFile(targetPath, (temp) => fs.promises.writeFile(temp, bytes));
    return { ok: true, name: path.basename(targetPath), path: targetPath, pages: pageCount };
  } catch (err) {
    return { ok: false, reason: failureReason(err, 'CANNOT_READ') };
  }
}

function validParts(parts, pageCount) {
  return Array.isArray(parts) && parts.length > 0 && parts.every(({ from, to, suffix }) => Number.isInteger(from)
    && Number.isInteger(to) && from >= 1 && from <= to && to <= pageCount && PART_SUFFIX.test(suffix));
}

// parts: [{ from, to, suffix }], with page numbers counted from 1.
async function splitFile(sourcePath, parts, folder, onProgress = () => {}) {
  let doc;
  try {
    doc = await loadForCopying(sourcePath);
  } catch (err) {
    return { ok: false, reason: failureReason(err, 'CANNOT_READ'), written: 0 };
  }
  if (!validParts(parts, doc.getPageCount())) return { ok: false, reason: 'BAD_REQUEST', written: 0 };
  const stem = path.parse(sourcePath).name;
  const names = [];
  try {
    for (const { from, to, suffix } of parts) {
      const entries = Array.from({ length: to - from + 1 }, (_v, i) => ({ doc, index: from - 1 + i }));
      const { bytes } = await buildDocument(entries);
      names.push(await writeNewFile(folder, `${stem}_${suffix}`, bytes));
      onProgress(names.length, parts.length);
    }
    return { ok: true, names };
  } catch (err) {
    return { ok: false, reason: failureReason(err, 'CANNOT_READ'), written: names.length };
  }
}

function validLayout(sourcePaths, layout) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || !Array.isArray(layout) || layout.length === 0) return false;
  const seen = new Set();
  return layout.every((entry) => {
    const { source, index, turn } = entry ?? {};
    const name = `${source}:${index}`;
    const valid = Number.isInteger(source) && source >= 0 && source < sourcePaths.length
      && Number.isInteger(index) && index >= 0 && QUARTER_TURNS.includes(turn) && !seen.has(name);
    seen.add(name);
    return valid;
  });
}

// Nothing is left out or moved, so everything that merging would lose can stay: bookmarks,
// forms and the rest. Only each page's rotation setting changes, if that.
async function layoutBytes(sourcePaths, docs, layout) {
  const first = docs.get(0);
  const sameOrder = first && layout.length === first.getPageCount()
    && layout.every(({ source, index }, position) => source === 0 && index === position);
  if (!sameOrder) {
    const entries = layout.map(({ source, index, turn }) => ({ doc: docs.get(source), index, turn }));
    const { bytes } = await buildDocument(entries, (out) => copyDocumentInfo(first ?? docs.get(layout[0].source), out));
    return bytes;
  }
  if (layout.every(({ turn }) => turn === 0)) return fs.promises.readFile(sourcePaths[0]);
  const pages = first.getPages();
  layout.forEach(({ turn }, position) => turnPage(pages[position], turn));
  return first.save();
}

// layout: [{ source, index, turn }], in output order. source counts into sourcePaths, and
// index counts from 0. overOriginal is for saving over sourcePaths[0], which is open.
async function organizeFiles(sourcePaths, layout, targetPath, { overOriginal = false } = {}) {
  if (!validLayout(sourcePaths, layout)) return { ok: false, reason: 'BAD_REQUEST' };
  if (!overOriginal && sourcePaths.some((source) => samePath(source, targetPath))) return { ok: false, reason: 'SAME_FILE' };
  const { EncryptedPDFError } = pdfLib();
  const docs = new Map();
  for (const source of new Set(layout.map((entry) => entry.source))) {
    try {
      docs.set(source, await loadForCopying(sourcePaths[source]));
    } catch (err) {
      return { ok: false, reason: err instanceof EncryptedPDFError ? 'PROTECTED' : 'CANNOT_READ', file: path.basename(sourcePaths[source]) };
    }
  }
  if (layout.some(({ source, index }) => index >= docs.get(source).getPageCount())) return { ok: false, reason: 'BAD_REQUEST' };
  try {
    const bytes = await layoutBytes(sourcePaths, docs, layout);
    const write = (temp) => fs.promises.writeFile(temp, bytes);
    await (overOriginal ? replaceOpenFile : replaceFile)(targetPath, write);
    return { ok: true, name: path.basename(targetPath), path: targetPath, pages: layout.length };
  } catch (err) {
    return { ok: false, reason: failureReason(err, 'CANNOT_READ') };
  }
}

module.exports = { rotateAllPages, saveCopy, mergeFiles, splitFile, organizeFiles };
