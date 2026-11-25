const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Puts several pages on one sheet, following the plan the print dialog made and
// showed in its preview (renderer/n-up.js). Each page goes in as a whole, unchanged,
// so text stays text. A page drawn this way leaves its annotations behind, so the
// ones that would print are drawn on top from their own appearance, as a printer would.

const MAX_SHEETS = 10000;
const MAX_SLOTS = 16;
const MAX_POINTS = 14400;
const FLAG_HIDDEN = 2;
const FLAG_PRINT = 4;
const NEVER_PRINTED = new Set(['/Link', '/Popup']);
const BORDER_WIDTH = 0.5;
const BORDER_GRAY = 0.45;

// pdf-lib is only loaded when someone actually prints several pages per sheet.
const pdfLib = () => require('@cantoo/pdf-lib');

const isNumbers = (list, length) => Array.isArray(list) && list.length === length && list.every(Number.isFinite);
const inRange = (n) => Number.isFinite(n) && n > 0 && n <= MAX_POINTS;

function validPlan(plan, pageCount) {
  if (!plan || typeof plan !== 'object') return false;
  const { width, height, rotate, border, sheets } = plan;
  return inRange(width) && inRange(height) && [0, 90].includes(rotate) && typeof border === 'boolean'
    && Array.isArray(sheets) && sheets.length > 0 && sheets.length <= MAX_SHEETS
    && sheets.every((sheet) => Array.isArray(sheet?.slots) && sheet.slots.length > 0 && sheet.slots.length <= MAX_SLOTS
      && sheet.slots.every((slot) => Number.isInteger(slot?.page) && slot.page >= 1 && slot.page <= pageCount
        && isNumbers(slot.box, 4) && slot.box[2] > slot.box[0] && slot.box[3] > slot.box[1]
        && isNumbers(slot.matrix, 6)));
}

function numbersOf(value, context) {
  const { PDFArray, PDFNumber } = pdfLib();
  const array = context.lookup(value);
  if (!(array instanceof PDFArray)) return null;
  const numbers = array.asArray().map((item) => {
    const number = context.lookup(item);
    return number instanceof PDFNumber ? number.asNumber() : NaN;
  });
  return numbers.every(Number.isFinite) ? numbers : null;
}

const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

// The smallest upright rectangle around a box once the matrix has moved it.
function boundsOf([x0, y0, x1, y1], matrix) {
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => apply(matrix, x, y));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// How an appearance fits its annotation's rectangle (PDF 32000, 12.5.5).
function appearanceMatrix(bbox, formMatrix, rect) {
  const [tx0, ty0, tx1, ty1] = boundsOf(bbox, formMatrix);
  const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (tx1 - tx0 <= 0 || ty1 - ty0 <= 0) return null;
  const sx = (rx1 - rx0) / (tx1 - tx0);
  const sy = (ry1 - ry0) / (ty1 - ty0);
  return [sx, 0, 0, sy, rx0 - sx * tx0, ry0 - sy * ty0];
}

// The annotations of a page that a printer would print, with their normal appearance.
function printedAppearances(page, context) {
  const { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } = pdfLib();
  const list = page.node.Annots();
  if (!list) return [];
  const found = [];
  for (const entry of list.asArray()) {
    const annotation = context.lookup(entry);
    if (!(annotation instanceof PDFDict)) continue;
    const subtype = context.lookup(annotation.get(PDFName.of('Subtype')));
    if (NEVER_PRINTED.has(subtype?.toString())) continue;
    const flags = context.lookup(annotation.get(PDFName.of('F')));
    const flagBits = flags instanceof PDFNumber ? flags.asNumber() : 0;
    if (!(flagBits & FLAG_PRINT) || flagBits & FLAG_HIDDEN) continue;
    const appearances = context.lookup(annotation.get(PDFName.of('AP')));
    if (!(appearances instanceof PDFDict)) continue;
    let normal = appearances.get(PDFName.of('N'));
    // Check boxes and radio buttons keep one appearance per state.
    if (!(context.lookup(normal) instanceof PDFStream) && context.lookup(normal) instanceof PDFDict) {
      const state = context.lookup(annotation.get(PDFName.of('AS')));
      normal = state instanceof PDFName ? context.lookup(normal).get(state) : null;
    }
    const stream = context.lookup(normal);
    if (!(stream instanceof PDFStream) || !(normal instanceof PDFRef)) continue;
    const rect = numbersOf(annotation.get(PDFName.of('Rect')), context);
    const bbox = numbersOf(stream.dict.get(PDFName.of('BBox')), context);
    if (!rect || rect.length !== 4 || !bbox || bbox.length !== 4) continue;
    const formMatrix = numbersOf(stream.dict.get(PDFName.of('Matrix')), context) ?? [1, 0, 0, 1, 0, 0];
    const matrix = formMatrix.length === 6 ? appearanceMatrix(bbox, formMatrix, rect) : null;
    if (matrix) found.push({ ref: normal, matrix });
  }
  return found;
}

// Owner-protected files open with the empty password, the same as in any reader;
// a file that needs a password to open comes with the one the user typed.
async function buildSheets(bytes, plan, password = '') {
  const {
    PDFDocument, PDFName, PDFObjectCopier, degrees, clip, concatTransformationMatrix, drawObject, endPath,
    popGraphicsState, pushGraphicsState, rectangle, setLineWidth, setStrokingGrayscaleColor, stroke,
  } = pdfLib();
  const source = await PDFDocument.load(bytes, { updateMetadata: false, password });
  const sourcePages = source.getPages();
  if (!validPlan(plan, sourcePages.length)) throw Object.assign(new Error('bad plan'), { code: 'BAD_REQUEST' });

  const out = await PDFDocument.create();
  const keyOf = (slot) => `${slot.page}:${slot.box.join(',')}`;
  const wanted = new Map();
  for (const { slots } of plan.sheets) {
    for (const slot of slots) if (!wanted.has(keyOf(slot))) wanted.set(keyOf(slot), slot);
  }
  const slotsToEmbed = [...wanted.values()];

  // Found before the pages go in, and then taken off them: copying a page copies its
  // annotations too, and a link would drag along the page it points to.
  const appearancesOf = new Map();
  for (const { page } of slotsToEmbed) {
    if (!appearancesOf.has(page)) appearancesOf.set(page, printedAppearances(sourcePages[page - 1], source.context));
  }
  for (const page of sourcePages) page.node.delete(PDFName.of('Annots'));

  // One call for all pages, so fonts they share are copied only once.
  const embedded = await out.embedPages(
    slotsToEmbed.map((slot) => sourcePages[slot.page - 1]),
    slotsToEmbed.map(({ box: [left, bottom, right, top] }) => ({ left, bottom, right, top })),
    slotsToEmbed.map(() => [1, 0, 0, 1, 0, 0]),
  );
  const embeddedByKey = new Map(slotsToEmbed.map((slot, i) => [keyOf(slot), embedded[i]]));

  const copier = PDFObjectCopier.for(source.context, out.context);
  for (const list of appearancesOf.values()) {
    for (const appearance of list) appearance.ref = copier.copy(appearance.ref);
  }
  const appearancesFor = (pageNumber) => appearancesOf.get(pageNumber);

  for (const { slots } of plan.sheets) {
    const sheet = out.addPage([plan.width, plan.height]);
    if (plan.rotate) sheet.setRotation(degrees(plan.rotate));
    const operators = [];
    for (const slot of slots) {
      const [left, bottom, right, top] = slot.box;
      const pageName = sheet.node.newXObject('Page', embeddedByKey.get(keyOf(slot)).ref);
      operators.push(
        pushGraphicsState(),
        concatTransformationMatrix(...slot.matrix),
        rectangle(left, bottom, right - left, top - bottom),
        clip(),
        endPath(),
        drawObject(pageName),
      );
      for (const { ref, matrix } of appearancesFor(slot.page)) {
        operators.push(pushGraphicsState(), concatTransformationMatrix(...matrix), drawObject(sheet.node.newXObject('Annot', ref)), popGraphicsState());
      }
      operators.push(popGraphicsState());
      if (plan.border) {
        const [x0, y0, x1, y1] = boundsOf(slot.box, slot.matrix);
        operators.push(
          pushGraphicsState(),
          setLineWidth(BORDER_WIDTH),
          setStrokingGrayscaleColor(BORDER_GRAY),
          rectangle(x0, y0, x1 - x0, y1 - y0),
          stroke(),
          popGraphicsState(),
        );
      }
    }
    sheet.pushOperators(...operators);
  }
  return out.save();
}

// The name matches what removeOldTempFiles clears at startup, in case printing is cut short.
async function writeSheetsCopy(sourcePath, plan, tempDir, password = '') {
  const bytes = await buildSheets(await fs.promises.readFile(sourcePath), plan, password);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const target = path.join(tempDir, `print-${crypto.randomUUID()}.pdf`);
  await fs.promises.writeFile(target, bytes);
  return target;
}

module.exports = { validPlan, appearanceMatrix, buildSheets, writeSheetsCopy };
