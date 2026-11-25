// Reads a page range such as "1-3,5,8". Chinese input methods often produce
// full-width digits and punctuation, so those are accepted too.
const FULL_WIDTH_DIGITS = /[０-９]/g;

function normalizeInput(text) {
  return text
    .replace(FULL_WIDTH_DIGITS, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[，、；;]/g, ',')
    .replace(/[－–—~～]/g, '-')
    .replace(/(\d)\s+(?=\d)/g, '$1,')
    .replace(/\s+/g, '');
}

export function parseRanges(text, pageCount) {
  const input = normalizeInput(String(text ?? ''));
  if (!input) return { ok: false, message: '請輸入頁碼，例如 1-3,5,8' };
  const ranges = [];
  const parts = input.split(',');
  for (const part of parts) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return { ok: false, message: '格式不正確，例如 1-3,5,8' };
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > pageCount || from > pageCount) {
      return { ok: false, message: `頁碼要在 1 到 ${pageCount} 之間` };
    }
    if (from > to) return { ok: false, message: `「${part}」要由小到大` };
    ranges.push({ from, to });
  }
  return { ok: true, ranges, normalized: parts.join(',') };
}

export function parsePageRange(text, pageCount) {
  const parsed = parseRanges(text, pageCount);
  if (!parsed.ok) return parsed;
  const pages = [];
  for (const { from, to } of parsed.ranges) {
    for (let page = from; page <= to; page++) pages.push(page);
  }
  return { ok: true, pages, normalized: parsed.normalized };
}
