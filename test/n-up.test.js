const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = require('@cantoo/pdf-lib');
const { appearanceMatrix, buildSheets, validPlan } = require('../lib/n-up');

const layout = () => import('../renderer/n-up.js');
const fixture = (name) => path.join(__dirname, 'fixtures', name);
const A4 = [595.28, 841.89];
const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

const upright = (number) => ({ number, view: [0, 0, A4[0], A4[1]], rotate: 0 });
const lying = (number) => ({ number, view: [0, 0, A4[1], A4[0]], rotate: 0 });

async function openWithPdfjs(bytes) {
  const pdfjs = await import(pathToFileURL(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);
  return pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
}

// What the print dialog reads with pdf.js before laying the pages out.
async function shapesOf(name) {
  const doc = await openWithPdfjs(fs.readFileSync(fixture(name)));
  const shapes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    shapes.push({ number: n, view: [...page.view], rotate: page.rotate });
  }
  await doc.destroy();
  return shapes;
}

const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];

// ---- Layout

test('n-up: four upright pages fill a standing sheet two by two, left to right then down', async () => {
  const { planSheets, GAP } = await layout();
  const plan = planSheets([1, 2, 3, 4].map(upright), { perSheet: 4, paper: A4, direction: 'counterclockwise' });
  assert.strictEqual(plan.landscape, false);
  assert.deepStrictEqual([plan.width, plan.height], A4);
  assert.strictEqual(plan.sheets.length, 1);
  const [a, b, c, d] = plan.sheets[0].slots.map((slot) => slot.rect);
  assert.ok(near(a.y, b.y) && b.x > a.x, 'page 2 is right of page 1');
  assert.ok(near(a.x, c.x) && c.y > a.y, 'page 3 is under page 1');
  assert.ok(near(d.x, b.x) && near(d.y, c.y), 'page 4 is bottom right');
  const cellWidth = (A4[0] - GAP) / 2;
  assert.ok(near(a.width, cellWidth), 'an A4 page in an A4-shaped space fills its width');
  assert.ok(plan.sheets[0].slots.every((slot) => !slot.turned && slot.rotation === 0));
});

test('n-up: two upright pages sit side by side on a sheet lying on its side', async () => {
  const { planSheets } = await layout();
  const plan = planSheets([1, 2].map(upright), { perSheet: 2, paper: A4, direction: 'counterclockwise' });
  assert.strictEqual(plan.landscape, true);
  assert.deepStrictEqual([plan.width, plan.height], [A4[1], A4[0]]);
  const [a, b] = plan.sheets[0].slots.map((slot) => slot.rect);
  assert.ok(near(a.y, b.y) && b.x > a.x + a.width);
  assert.strictEqual(plan.rotate, 0, 'Sumatra turns it counter-clockwise by itself');
  assert.strictEqual(planSheets([1, 2].map(upright), { perSheet: 2, paper: A4, direction: 'clockwise' }).rotate, 90);
});

test('n-up: mostly landscape pages get the grid the other way round and are not turned', async () => {
  const { planSheets } = await layout();
  const two = planSheets([1, 2].map(lying), { perSheet: 2, paper: A4, direction: 'counterclockwise' });
  assert.strictEqual(two.landscape, false);
  const [a, b] = two.sheets[0].slots.map((slot) => slot.rect);
  assert.ok(near(a.x, b.x) && b.y > a.y + a.height, 'one above the other');
  assert.ok(two.sheets[0].slots.every((slot) => !slot.turned));
  const four = planSheets([1, 2, 3, 4].map(lying), { perSheet: 4, paper: A4, direction: 'counterclockwise' });
  assert.strictEqual(four.landscape, true);
  assert.ok(four.sheets[0].slots.every((slot) => !slot.turned));
});

test('n-up: a page that does not match its space is turned the chosen way', async () => {
  const { planSheets } = await layout();
  const pages = [upright(1), lying(2), upright(3), lying(4)];
  const ccw = planSheets(pages, { perSheet: 4, paper: A4, direction: 'counterclockwise' }).sheets[0].slots;
  assert.deepStrictEqual(ccw.map((slot) => slot.rotation), [0, 270, 0, 270]);
  assert.deepStrictEqual(ccw.map((slot) => slot.turned), [false, true, false, true]);
  const cw = planSheets(pages, { perSheet: 4, paper: A4, direction: 'clockwise' }).sheets[0].slots;
  assert.deepStrictEqual(cw.map((slot) => slot.rotation), [0, 90, 0, 90]);
  // Already turned to look landscape by its own setting: turned back to stand upright.
  const prerotated = { number: 1, view: [0, 0, A4[0], A4[1]], rotate: 90 };
  const [slot] = planSheets([prerotated, upright(2)], { perSheet: 4, paper: A4, direction: 'counterclockwise' }).sheets[0].slots;
  assert.strictEqual(slot.rotation, 0);
  // A square page is never turned.
  const square = { number: 1, view: [0, 0, 500, 500], rotate: 0 };
  assert.strictEqual(planSheets([square], { perSheet: 2, paper: A4, direction: 'counterclockwise' }).sheets[0].slots[0].turned, false);
});

test('n-up: the matrix puts the page exactly where the preview shows it, the right way up', async () => {
  const { planSheets } = await layout();
  const cases = [
    { pages: [upright(1)], perSheet: 4, top: 'up' },
    { pages: [lying(1), upright(2), upright(3)], perSheet: 4, direction: 'counterclockwise', top: 'left' },
    { pages: [lying(1), upright(2), upright(3)], perSheet: 4, direction: 'clockwise', top: 'right' },
    { pages: [{ number: 1, view: [10, 20, 310, 420], rotate: 180 }], perSheet: 9, top: 'down' },
  ];
  for (const { pages, perSheet, direction = 'counterclockwise', top } of cases) {
    const plan = planSheets(pages, { perSheet, paper: A4, direction });
    const slot = plan.sheets[0].slots[0];
    const [x0, y0, x1, y1] = slot.box;
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map((corner) => apply(slot.matrix, corner));
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const { rect } = slot;
    assert.ok(near(Math.min(...xs), rect.x) && near(Math.max(...xs), rect.x + rect.width), `${top}: left and right`);
    assert.ok(near(Math.max(...ys), plan.height - rect.y) && near(Math.min(...ys), plan.height - rect.y - rect.height), `${top}: top and bottom`);
    // Where the middle of the page's top edge ends up.
    const [tx, ty] = apply(slot.matrix, [(x0 + x1) / 2, y1]);
    const middle = [rect.x + rect.width / 2, plan.height - rect.y - rect.height / 2];
    const where = Math.abs(tx - middle[0]) > Math.abs(ty - middle[1])
      ? (tx < middle[0] ? 'left' : 'right')
      : (ty > middle[1] ? 'up' : 'down');
    assert.strictEqual(where, top);
  }
});

test('n-up: the last sheet takes what is left', async () => {
  const { planSheets } = await layout();
  const plan = planSheets(Array.from({ length: 11 }, (_v, i) => upright(i + 1)), { perSheet: 4, paper: A4, direction: 'counterclockwise' });
  assert.deepStrictEqual(plan.sheets.map((sheet) => sheet.slots.map((slot) => slot.page)), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11]]);
});

test('n-up: every choice of pages per sheet fits inside the paper', async () => {
  const { planSheets, PAGES_PER_SHEET } = await layout();
  for (const perSheet of PAGES_PER_SHEET.filter((n) => n > 1)) {
    for (const make of [upright, lying]) {
      const plan = planSheets(Array.from({ length: perSheet }, (_v, i) => make(i + 1)), { perSheet, paper: A4, direction: 'counterclockwise' });
      assert.strictEqual(plan.sheets.length, 1);
      for (const { rect } of plan.sheets[0].slots) {
        assert.ok(rect.x >= -0.01 && rect.y >= -0.01 && rect.x + rect.width <= plan.width + 0.01 && rect.y + rect.height <= plan.height + 0.01, `${perSheet} per sheet`);
      }
    }
  }
});

test('n-up: page lists are short', async () => {
  const { describePages } = await layout();
  assert.strictEqual(describePages([3, 4, 5, 6, 9]), '第 3–6、9 頁');
  assert.strictEqual(describePages([1]), '第 1 頁');
  assert.strictEqual(describePages([1, 3, 5]), '第 1、3、5 頁');
});

test('n-up: printed sides are named, and counted as sheets of paper', async () => {
  const { sideName, sheetsOfPaper } = await layout();
  assert.strictEqual(sideName(0, false), '第 1 張');
  assert.strictEqual(sideName(4, false), '第 5 張');
  assert.strictEqual(sideName(0, true), '第 1 張正面');
  assert.strictEqual(sideName(1, true), '第 1 張背面');
  assert.strictEqual(sideName(4, true), '第 3 張正面');
  assert.strictEqual(sheetsOfPaper(5, false), 5);
  assert.strictEqual(sheetsOfPaper(5, true), 3);
  assert.strictEqual(sheetsOfPaper(4, true), 2);
});

test('n-up: only what the main process needs is sent to it', async () => {
  const { planSheets, printablePlan } = await layout();
  const plan = printablePlan(planSheets([upright(1), upright(2)], { perSheet: 2, paper: A4, direction: 'counterclockwise' }), true);
  assert.deepStrictEqual(Object.keys(plan).sort(), ['border', 'height', 'rotate', 'sheets', 'width']);
  assert.deepStrictEqual(Object.keys(plan.sheets[0].slots[0]).sort(), ['box', 'matrix', 'page']);
  assert.ok(validPlan(plan, 2));
});

// ---- Making the file

test('n-up: a plan from outside is checked', async () => {
  const { planSheets, printablePlan } = await layout();
  const good = printablePlan(planSheets([upright(1), upright(2)], { perSheet: 2, paper: A4, direction: 'counterclockwise' }), false);
  assert.ok(validPlan(good, 2));
  const broken = (change) => {
    const copy = structuredClone(good);
    change(copy);
    return validPlan(copy, 2);
  };
  assert.strictEqual(validPlan(null, 2), false);
  assert.strictEqual(validPlan(good, 1), false, 'page past the end');
  assert.strictEqual(broken((p) => { p.sheets[0].slots[0].page = 0; }), false);
  assert.strictEqual(broken((p) => { p.sheets[0].slots[0].page = 1.5; }), false);
  assert.strictEqual(broken((p) => { p.sheets[0].slots[0].matrix[4] = NaN; }), false);
  assert.strictEqual(broken((p) => { p.sheets[0].slots[0].box = [0, 0, 0, 10]; }), false);
  assert.strictEqual(broken((p) => { p.rotate = 45; }), false);
  assert.strictEqual(broken((p) => { p.border = 'yes'; }), false);
  assert.strictEqual(broken((p) => { p.width = -1; }), false);
  assert.strictEqual(broken((p) => { p.sheets = []; }), false);
  assert.strictEqual(broken((p) => { p.sheets[0].slots = Array(17).fill(p.sheets[0].slots[0]); }), false);
});

test('n-up: an appearance is stretched onto its annotation rectangle', () => {
  assert.deepStrictEqual(appearanceMatrix([0, 0, 160, 40], [1, 0, 0, 1, 0, 0], [120, 485, 280, 525]), [1, 0, 0, 1, 120, 485]);
  assert.deepStrictEqual(appearanceMatrix([0, 0, 80, 20], [1, 0, 0, 1, 0, 0], [280, 525, 120, 485]), [2, 0, 0, 2, 120, 485]);
  // An appearance drawn turned: its own matrix turns the box first.
  assert.deepStrictEqual(appearanceMatrix([0, 0, 40, 160], [0, 1, -1, 0, 0, 0], [0, 0, 160, 40]), [1, 0, 0, 1, 160, 0]);
  assert.strictEqual(appearanceMatrix([0, 0, 0, 10], [1, 0, 0, 1, 0, 0], [0, 0, 10, 10]), null);
});

test('n-up: the printout puts each page and its text where the plan says', async () => {
  const { planSheets, printablePlan } = await layout();
  const plan = planSheets(await shapesOf('mixed.pdf'), { perSheet: 4, paper: A4, direction: 'counterclockwise' });
  const bytes = await buildSheets(fs.readFileSync(fixture('mixed.pdf')), printablePlan(plan, true));
  const out = await PDFDocument.load(bytes);
  assert.strictEqual(out.getPageCount(), 1);
  const { width, height } = out.getPage(0).getSize();
  assert.ok(near(width, A4[0]) && near(height, A4[1]));

  const doc = await openWithPdfjs(bytes);
  const items = (await (await doc.getPage(1)).getTextContent()).items.filter((item) => /^PAGE \d/.test(item.str));
  for (const slot of plan.sheets[0].slots) {
    const item = items.find((candidate) => candidate.str.startsWith(`PAGE ${slot.page} `));
    assert.ok(item, `text of page ${slot.page}`);
    const [a, b, , , x, y] = item.transform;
    const { rect } = slot;
    assert.ok(x > rect.x && x < rect.x + rect.width && y > plan.height - rect.y - rect.height && y < plan.height - rect.y, `page ${slot.page} lands in its space`);
    // Turned counter-clockwise, a line of text runs upwards.
    assert.strictEqual(slot.turned ? b > 0 && near(a, 0) : a > 0 && near(b, 0), true, `page ${slot.page} reads the right way`);
  }
  await doc.destroy();
});

test('n-up: a sheet lying on its side is turned for clockwise', async () => {
  const { planSheets, printablePlan } = await layout();
  const shapes = (await shapesOf('mixed.pdf')).filter((page) => page.number % 2 === 1);
  for (const [direction, angle] of [['counterclockwise', 0], ['clockwise', 90]]) {
    const plan = planSheets(shapes, { perSheet: 2, paper: A4, direction });
    const out = await PDFDocument.load(await buildSheets(fs.readFileSync(fixture('mixed.pdf')), printablePlan(plan, false)));
    assert.strictEqual(out.getPage(0).getRotation().angle, angle, direction);
    assert.ok(near(out.getPage(0).getSize().width, A4[1]));
  }
});

// The appearance streams drawn on a sheet, as text.
function drawnAppearances(out) {
  const xObjects = out.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
  return xObjects.keys().filter((key) => key.asString().startsWith('/Annot')).map((key) => {
    const stream = xObjects.lookup(key);
    return Buffer.from(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()).toString('latin1');
  });
}

test('n-up: annotations marked for printing are printed, the others are not', async () => {
  const { planSheets, printablePlan } = await layout();
  const plan = planSheets(await shapesOf('annotated.pdf'), { perSheet: 2, paper: A4, direction: 'counterclockwise' });
  const out = await PDFDocument.load(await buildSheets(fs.readFileSync(fixture('annotated.pdf')), printablePlan(plan, false)));
  const drawn = drawnAppearances(out);
  assert.strictEqual(drawn.length, 1);
  assert.ok(drawn[0].includes('1 0 0 rg'), 'the red one with the print flag');
  assert.strictEqual(out.getPage(0).node.Annots()?.size() ?? 0, 0, 'nothing clickable is left on the sheet');
});

test('n-up: an owner-protected file can still be laid out', async () => {
  const { planSheets, printablePlan } = await layout();
  const plan = planSheets(await shapesOf('enc-owner-print-allowed.pdf'), { perSheet: 4, paper: A4, direction: 'counterclockwise' });
  const bytes = await buildSheets(fs.readFileSync(fixture('enc-owner-print-allowed.pdf')), printablePlan(plan, false));
  const doc = await openWithPdfjs(bytes);
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((item) => item.str).join('');
  assert.ok(text.includes('PROTECTED LANDSCAPE'), text);
  await doc.destroy();
});

test('n-up: links do not drag other pages into the printout', async () => {
  const { planSheets, printablePlan } = await layout();
  const shapes = await shapesOf('linked.pdf');
  const plan = planSheets(shapes.slice(0, 1), { perSheet: 2, paper: A4, direction: 'counterclockwise' });
  const out = await PDFDocument.load(await buildSheets(fs.readFileSync(fixture('linked.pdf')), printablePlan(plan, false)));
  const pageObjects = out.context.enumerateIndirectObjects().filter(([, object]) => object?.get?.(PDFName.of('Type'))?.toString() === '/Page');
  assert.strictEqual(pageObjects.length, 1);
});

test('n-up: a bad plan is refused before anything is made', async () => {
  await assert.rejects(buildSheets(fs.readFileSync(fixture('mixed.pdf')), { width: 10 }), (err) => err.code === 'BAD_REQUEST');
});
