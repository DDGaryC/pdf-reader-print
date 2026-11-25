// Several pages on one sheet of paper. Pure, so the tests can run it in Node.
//
// Sizes are in points. Each slot has a rectangle measured from the sheet's top-left
// corner, for the preview, and a PDF matrix that takes the page's own coordinates onto
// the sheet, for the printout. Both come from the same numbers, so they agree.

export const PAGES_PER_SHEET = [1, 2, 4, 6, 9, 16];
// Columns and rows for upright pages. More columns than rows means the sheet lies on its side.
const GRIDS = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };
// Space between neighbouring pages, about 3 mm.
export const GAP = 8;
// The same turns as one page per sheet: counter-clockwise is what Sumatra does itself.
const TURN_DEGREES = { counterclockwise: 270, clockwise: 90 };

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

// Width and height as the page is shown, after its own rotation setting.
function shownSize({ view: [x0, y0, x1, y1], rotate }) {
  const width = x1 - x0;
  const height = y1 - y0;
  return rotate % 180 === 0 ? [width, height] : [height, width];
}

// Takes a point of the page onto the sheet, in PDF coordinates (from the bottom-left).
// rotation turns the page clockwise, like a page's own rotation setting.
function pageMatrix([x0, y0, x1, y1], rotation, scale, left, bottom) {
  const s = scale;
  switch (rotation) {
    case 90: return [0, -s, s, 0, left - s * y0, bottom + s * x1];
    case 180: return [-s, 0, 0, -s, left + s * x1, bottom + s * y1];
    case 270: return [0, s, -s, 0, left + s * y1, bottom - s * x0];
    default: return [s, 0, 0, s, left - s * x0, bottom - s * y0];
  }
}

function placePage(page, cell, sheetHeight, direction) {
  const [shownWidth, shownHeight] = shownSize(page);
  // A page whose shape does not match its space is turned, the same way as one page per sheet.
  const mismatched = sign(shownWidth - shownHeight) * sign(cell.width - cell.height) === -1;
  const turn = mismatched ? TURN_DEGREES[direction] : 0;
  const rotation = (page.rotate + turn) % 360;
  const [x0, y0, x1, y1] = page.view;
  const [width, height] = rotation % 180 === 0 ? [x1 - x0, y1 - y0] : [y1 - y0, x1 - x0];
  const scale = Math.min(cell.width / width, cell.height / height);
  const rect = {
    x: cell.x + (cell.width - width * scale) / 2,
    y: cell.y + (cell.height - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
  return {
    page: page.number,
    box: [...page.view],
    rotation,
    turned: turn !== 0,
    scale,
    rect,
    matrix: pageMatrix(page.view, rotation, scale, rect.x, sheetHeight - rect.y - rect.height),
  };
}

// pages: [{ number, view: [x0, y0, x1, y1], rotate }] in printing order, where view is
// the visible part of the page (pdf.js's page.view) and rotate its rotation setting.
// paper: [width, height] of the paper standing upright.
export function planSheets(pages, { perSheet, paper, direction }) {
  const [many, few] = GRIDS[perSheet];
  // Mostly landscape pages get the grid the other way round, so they fit without turning.
  const lying = pages.filter((page) => {
    const [width, height] = shownSize(page);
    return width > height;
  }).length * 2 > pages.length;
  const [columns, rows] = lying ? [few, many] : [many, few];
  const landscape = lying ? many <= few : many > few;
  const [width, height] = landscape ? [paper[1], paper[0]] : paper;
  const cellWidth = (width - GAP * (columns - 1)) / columns;
  const cellHeight = (height - GAP * (rows - 1)) / rows;

  const sheets = [];
  for (let start = 0; start < pages.length; start += perSheet) {
    const slots = pages.slice(start, start + perSheet).map((page, i) => placePage(page, {
      x: (i % columns) * (cellWidth + GAP),
      y: Math.floor(i / columns) * (cellHeight + GAP),
      width: cellWidth,
      height: cellHeight,
    }, height, direction));
    sheets.push({ slots });
  }
  return {
    perSheet,
    width,
    height,
    landscape,
    // Sumatra turns a lying sheet counter-clockwise by itself; clockwise has to be asked for.
    rotate: landscape && direction === 'clockwise' ? 90 : 0,
    sheets,
  };
}

// What the main process needs to make the file: no more than it can check.
export function printablePlan(plan, border) {
  return {
    width: plan.width,
    height: plan.height,
    rotate: plan.rotate,
    border,
    sheets: plan.sheets.map(({ slots }) => ({
      slots: slots.map(({ page, box, matrix }) => ({ page, box, matrix })),
    })),
  };
}

// 第 3–6、9 頁
export function describePages(numbers) {
  const runs = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return `第 ${runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join('、')} 頁`;
}

// What one printed side is called. Printed on both sides, two sides share a sheet of paper.
export function sideName(index, twoSided) {
  if (!twoSided) return `第 ${index + 1} 張`;
  return `第 ${Math.floor(index / 2) + 1} 張${index % 2 === 0 ? '正面' : '背面'}`;
}

// Sheets of paper used for this many printed sides.
export function sheetsOfPaper(sides, twoSided) {
  return twoSided ? Math.ceil(sides / 2) : sides;
}
