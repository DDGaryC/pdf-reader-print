// The document information window ("文件資訊"): file, pages and paper, who made it and
// when, and what the file allows. The parts that only work out words are kept free of
// the page so they can be tested on their own.

// Paper sizes in millimetres, portrait.
const PAPERS = [
  ['A3', 297, 420],
  ['A4', 210, 297],
  ['A5', 148, 210],
  ['A6', 105, 148],
  ['B4', 257, 364],
  ['B5', 182, 257],
  ['Letter', 215.9, 279.4],
  ['Legal', 215.9, 355.6],
];
const MM_PER_POINT = 25.4 / 72;
const TOLERANCE_MM = 3;
// pdf.js permission flags.
const FLAG = { PRINT: 4, MODIFY: 8, COPY: 16, ANNOTATE: 32, FILL: 256, ASSEMBLE: 1024 };

// A page's size as people say it: "A4 直式", or "100 × 150 公釐".
export function paperName(widthPt, heightPt) {
  const w = widthPt * MM_PER_POINT;
  const h = heightPt * MM_PER_POINT;
  const portrait = h >= w;
  const [short, long] = portrait ? [w, h] : [h, w];
  const found = PAPERS.find(([, a, b]) => Math.abs(short - a) <= TOLERANCE_MM && Math.abs(long - b) <= TOLERANCE_MM);
  if (found) return `${found[0]} ${Math.abs(w - h) < 1 ? '' : portrait ? '直式' : '橫式'}`.trim();
  return `${Math.round(w)} × ${Math.round(h)} 公釐`;
}

// "A4 直式（10 頁）、A4 橫式（2 頁）", most common first; one size alone needs no count.
export function describeSizes(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  if (counts.size === 1) return `${names[0]}（全部 ${names.length} 頁）`;
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}（${count} 頁）`).join('、');
}

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const exact = `${bytes.toLocaleString('en-US')} 位元組`;
  if (bytes < 1024) return exact;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / 1024 / 1024, 'MB'];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}（${exact}）`;
}

const pad = (n) => String(n).padStart(2, '0');
export function dateText(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// What the author allows. pdf.js gives null when nothing is restricted.
export function permissionLines(permissions) {
  if (!Array.isArray(permissions)) return ['沒有限制'];
  const allowed = new Set(permissions);
  const word = (flag) => (allowed.has(flag) ? '允許' : '禁止');
  return [
    `列印：${word(FLAG.PRINT)}`,
    `複製文字：${word(FLAG.COPY)}`,
    `修改內容：${word(FLAG.MODIFY)}`,
    `加註解：${word(FLAG.ANNOTATE)}`,
    `填寫表單：${allowed.has(FLAG.FILL) || allowed.has(FLAG.ANNOTATE) ? '允許' : '禁止'}`,
    `調整頁面：${allowed.has(FLAG.ASSEMBLE) || allowed.has(FLAG.MODIFY) ? '允許' : '禁止'}`,
  ];
}

const folderOf = (filePath) => filePath.replace(/[\\/][^\\/]*$/, '');

// Rows for the window: [label, value], leaving out what the file does not say.
// view: the open document; pdfjsLib for reading PDF dates.
export async function gatherInfo(view, pdfjsLib, onPages = () => {}) {
  const { doc, file } = view;
  const [metadata, permissions, stat, outline] = await Promise.all([
    doc.getMetadata().catch(() => ({ info: {} })),
    doc.getPermissions().catch(() => null),
    window.api.statPdf(file.id).catch(() => null),
    doc.getOutline().catch(() => null),
  ]);
  const info = metadata.info ?? {};
  const pdfDate = (value) => (typeof value === 'string' ? dateText(pdfjsLib.PDFDateString.toDateObject(value)) : '');
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const rows = [
    ['檔名', file.name],
    ['位置', folderOf(file.path)],
    ['檔案大小', fileSize(stat?.size ?? file.size)],
    ['檔案修改時間', stat ? dateText(new Date(stat.modified)) : ''],
    ['頁數', `${doc.numPages} 頁`],
    ['頁面大小', '計算中…'],
    ['標題', text(info.Title)],
    ['作者', text(info.Author)],
    ['主旨', text(info.Subject)],
    ['關鍵字', text(info.Keywords)],
    ['製作程式', text(info.Creator)],
    ['PDF 產生器', text(info.Producer)],
    ['建立日期', pdfDate(info.CreationDate)],
    ['修改日期', pdfDate(info.ModDate)],
    ['PDF 版本', text(info.PDFFormatVersion)],
    ['書籤目錄', Array.isArray(outline) && outline.length > 0 ? '有' : '沒有'],
    ['開啟密碼', view.openPassword() !== null ? '有' : '沒有'],
    ['作者設定的權限', permissionLines(permissions).join('\n')],
  ];
  // Page sizes take a while on a long file, so they come in afterwards.
  (async () => {
    const names = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      names.push(paperName(width, height));
    }
    onPages(describeSizes(names));
  })().catch((err) => {
    console.warn('reading the page sizes failed:', err);
    onPages('讀不到');
  });
  return rows.filter(([, value]) => value !== '');
}
