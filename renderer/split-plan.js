// Which files a split will make, without any screen. A part is { from, to, suffix }:
// pages counted from 1, and what goes after the file name.
import { parseRanges } from './page-range.js';

export function splitPlan(mode, value, pageCount) {
  if (mode === 'each') {
    const parts = Array.from({ length: pageCount }, (_v, i) => ({ from: i + 1, to: i + 1, suffix: String(i + 1) }));
    return { ok: true, parts };
  }
  if (mode === 'every') {
    const size = Number(value);
    if (!Number.isInteger(size) || size < 1) return { ok: false, message: '請輸入 1 以上的整數' };
    if (size >= pageCount) return { ok: false, message: `這份檔案只有 ${pageCount} 頁，每 ${size} 頁拆不出第二個檔案` };
    const parts = [];
    for (let from = 1; from <= pageCount; from += size) {
      parts.push({ from, to: Math.min(from + size - 1, pageCount), suffix: String(parts.length + 1) });
    }
    return { ok: true, parts };
  }
  const parsed = parseRanges(value, pageCount);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    parts: parsed.ranges.map(({ from, to }) => ({ from, to, suffix: from === to ? String(from) : `${from}-${to}` })),
  };
}

export function leftOutPages(parts, pageCount) {
  const included = new Set();
  for (const { from, to } of parts) {
    for (let page = from; page <= to; page++) included.add(page);
  }
  return pageCount - included.size;
}
