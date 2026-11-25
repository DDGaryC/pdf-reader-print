// Reads the text of a document for comparing, with where each word sits on its page.
// Takes an open pdf.js document but loads nothing itself, so the tests can run it in Node.
import { compareTexts, splitTokens, widthOf } from './text-diff.js';

// Fonts without these figures get the usual proportions of a Chinese font.
const ASCENT = 0.85;
const DESCENT = -0.15;
// Page numbers, headers and footers sit in this share of the page at the top or the bottom.
const EDGE = 0.12;
// Page numbers once the digits are replaced by # and the punctuation dropped: 3, - 3 -,
// 3/5, 第3頁, 第3頁共5頁, 共5頁第3頁, Page 3 of 5.
const PAGE_NUMBER = /^(?:page|p|第|共#頁第)?#頁?(?:(?:of|共)?#頁?)?$/;
const PUNCTUATION = /[-–—()（）[\]【】.,，、:：;；|｜/／~～·•]/g;
const clamp = (value, low, high, fallback) => (Number.isFinite(value) && value !== 0 ? Math.min(high, Math.max(low, value)) : fallback);

// How far along an item each position of its text is, from 0 to 1.
function placesIn(str, vertical) {
  const places = new Float64Array(str.length + 1);
  let total = 0;
  let at = 0;
  for (const char of str) {
    total += vertical ? 1 : widthOf(char);
    at += char.length;
    places[at] = total;
  }
  // Positions inside a two-part character take the place after it.
  for (let i = 1; i <= str.length; i++) if (places[i] === 0) places[i] = places[i - 1];
  if (total > 0) for (let i = 0; i <= str.length; i++) places[i] /= total;
  return places;
}

// Each word of the item with the box around it, in the page's own units.
function boxesInItem(item, style, pieces) {
  const [a, b, c, d, e, f] = item.transform;
  const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
  const angle = Math.atan2(b, a);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const vertical = Boolean(style.vertical);
  // Along the writing direction, and across it.
  const along = vertical ? [sin, -cos] : [cos, sin];
  const across = vertical ? [cos, sin] : [-sin, cos];
  const length = vertical ? item.height : item.width;
  const low = vertical ? -0.5 : clamp(style.descent, -0.5, 0, DESCENT);
  const high = vertical ? 0.5 : clamp(style.ascent, 0.5, 1.2, ASCENT);
  const places = placesIn(item.str, vertical);
  return pieces.map(({ start, end }) => {
    const from = places[start] * length;
    const to = places[end] * length;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of [from, to]) {
      for (const t of [low * size, high * size]) {
        const x = e + along[0] * s + across[0] * t;
        const y = f + along[1] * s + across[1] * t;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    return [x0, y0, x1, y1];
  });
}

// The lines of one page as the file draws them: [{ words: [{ text, box }] }].
function linesInContent(content) {
  const lines = [];
  let current = null;
  let previous = null;
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const [a, b, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
    // Text that moved up or down by more than half a letter is on another line.
    if (previous && Math.abs((e - previous.x) * previous.upX + (f - previous.y) * previous.upY) > size * 0.5) current = null;
    const pieces = splitTokens(item.str);
    if (pieces.length > 0) {
      if (!current) {
        current = { words: [] };
        lines.push(current);
      }
      const boxes = boxesInItem(item, content.styles[item.fontName] ?? {}, pieces);
      pieces.forEach((piece, k) => current.words.push({ text: piece.text, box: boxes[k] }));
    }
    const angle = Math.atan2(b, a);
    previous = { x: e, y: f, upX: -Math.sin(angle), upY: Math.cos(angle) };
    if (item.hasEOL) current = null;
  }
  return lines;
}

// A line as the page is seen: where it sits, whether at the top or bottom edge, and its text
// with the digits replaced, so that "第 3 頁" on one page matches "第 4 頁" on the next.
function placeLine(line, viewport) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { box } of line.words) {
    x0 = Math.min(x0, box[0]);
    y0 = Math.min(y0, box[1]);
    x1 = Math.max(x1, box[2]);
    y1 = Math.max(y1, box[3]);
  }
  const [a, b, c, d] = viewport.convertToViewportRectangle([x0, y0, x1, y1]);
  line.top = Math.min(b, d);
  line.bottom = Math.max(b, d);
  line.left = Math.min(a, c);
  line.middle = (line.top + line.bottom) / 2;
  line.edge = line.middle < viewport.height * EDGE ? 'top' : line.middle > viewport.height * (1 - EDGE) ? 'bottom' : null;
  line.key = line.words.map(({ text }) => (/^\d+$/.test(text) ? '#' : text.toLowerCase())).join('').replace(PUNCTUATION, '');
}

// Files often draw a page out of order, such as the letterhead last or the page number
// first. Lines are put in the order they are read: from the top, and left to right where
// they share a row.
function inReadingOrder(lines) {
  const sorted = [...lines].sort((p, q) => p.middle - q.middle);
  const out = [];
  let row = [];
  const flush = () => out.push(...row.sort((p, q) => p.left - q.left));
  for (const line of sorted) {
    const last = row[row.length - 1];
    if (last && line.middle - last.middle > Math.min(last.bottom - last.top, line.bottom - line.top) / 2) {
      flush();
      row = [];
    }
    row.push(line);
  }
  flush();
  return out;
}

// The words of the whole document: { tokens, line, page, box, edge }. box holds four
// numbers a word, x0 y0 x1 y1, with y going up as in the file. edge marks the words of page
// numbers and of headers and footers that repeat. Null if canceled part way.
export async function readText(doc, { onPage = () => {}, isCanceled = () => false } = {}) {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pdfPage = await doc.getPage(n);
    const content = await pdfPage.getTextContent();
    if (isCanceled()) return null;
    const viewport = pdfPage.getViewport({ scale: 1 });
    const lines = linesInContent(content);
    for (const line of lines) placeLine(line, viewport);
    pages.push(inReadingOrder(lines));
    pdfPage.cleanup();
    onPage(n, doc.numPages);
  }

  // A line at the edge that is a page number, or that comes back on at least half the pages.
  const pagesWith = new Map();
  pages.forEach((lines, index) => {
    for (const { edge, key } of lines) {
      if (!edge) continue;
      const where = `${edge}:${key}`;
      if (!pagesWith.has(where)) pagesWith.set(where, new Set());
      pagesWith.get(where).add(index);
    }
  });
  const often = Math.max(2, Math.ceil(pages.length / 2));
  const atEdge = ({ edge, key }) => Boolean(edge) && (PAGE_NUMBER.test(key) || pagesWith.get(`${edge}:${key}`).size >= often);

  const tokens = [];
  const line = [];
  const page = [];
  const box = [];
  const edge = [];
  let lineNumber = 0;
  pages.forEach((lines, index) => {
    for (const each of lines) {
      const isEdge = atEdge(each) ? 1 : 0;
      for (const word of each.words) {
        tokens.push(word.text);
        line.push(lineNumber);
        page.push(index + 1);
        box.push(...word.box);
        edge.push(isEdge);
      }
      lineNumber++;
    }
  });
  return {
    tokens,
    line: Int32Array.from(line),
    page: Int32Array.from(page),
    box: Float32Array.from(box),
    edge: Uint8Array.from(edge),
    pageCount: doc.numPages,
  };
}

function subset(text, keep) {
  const chosen = [];
  for (let i = 0; i < text.tokens.length; i++) if (keep(i)) chosen.push(i);
  const box = new Float32Array(chosen.length * 4);
  chosen.forEach((i, k) => box.set(text.box.subarray(4 * i, 4 * i + 4), 4 * k));
  return {
    tokens: chosen.map((i) => text.tokens[i]),
    line: Int32Array.from(chosen, (i) => text.line[i]),
    page: Int32Array.from(chosen, (i) => text.page[i]),
    box,
    pageCount: text.pageCount,
  };
}

// The body of the text, and the page numbers, headers and footers apart from it. Kept in
// the body, a page number would sit between the last word of one page and the first of the
// next, and a word carried over to the next page would look moved.
export function splitAtEdges(text) {
  const edge = text.edge ?? new Uint8Array(text.tokens.length);
  return { body: subset(text, (i) => !edge[i]), edges: subset(text, (i) => edge[i] === 1) };
}

// Compares the bodies, and the edges on their own. Each difference says which part it is in.
export function compareDocuments(left, right) {
  const found = ['body', 'edges'].map((part) => ({ part, ...compareTexts(left[part], right[part]) }));
  return {
    differences: found.flatMap(({ part, differences }) => differences.map((difference) => ({ ...difference, part }))),
    rough: found.some(({ rough }) => rough),
  };
}

// So little text that it is most likely a scan.
export const hasLittleText = (text) => text.tokens.length < Math.max(5, text.pageCount * 5);

// Boxes around words start..end, one for each line: { page, rect: [x0, y0, x1, y1] }.
export function boxesOf(text, start, end) {
  const out = [];
  let current = null;
  for (let i = start; i < end; i++) {
    const [x0, y0, x1, y1] = text.box.subarray(4 * i, 4 * i + 4);
    if (current && current.page === text.page[i] && current.line === text.line[i]) {
      const { rect } = current;
      rect[0] = Math.min(rect[0], x0);
      rect[1] = Math.min(rect[1], y0);
      rect[2] = Math.max(rect[2], x1);
      rect[3] = Math.max(rect[3], y1);
    } else {
      current = { page: text.page[i], line: text.line[i], rect: [x0, y0, x1, y1] };
      out.push(current);
    }
  }
  return out.map(({ page, rect }) => ({ page, rect }));
}

// Where the other side has words this side lacks: a thin mark just before word `at`, or after
// the last word. Null for a document without words.
export function gapAt(text, at) {
  const count = text.tokens.length;
  if (count === 0) return null;
  const i = Math.min(at, count - 1);
  const [x0, y0, x1, y1] = text.box.subarray(4 * i, 4 * i + 4);
  const x = at < count ? x0 : x1;
  const half = Math.max(0.6, (y1 - y0) * 0.06);
  return { page: text.page[i], rect: [x - half, y0, x + half, y1] };
}
