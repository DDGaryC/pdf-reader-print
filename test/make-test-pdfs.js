// Generates the test PDFs into test/fixtures. Each page has a big label and an
// arrow pointing up, so the direction can be checked by eye.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb, degrees, PDFString } = require('@cantoo/pdf-lib');

const outDir = path.join(__dirname, 'fixtures');
const A4 = [595.28, 841.89];

// Draws in visual coordinates so a /Rotate=90 page still looks right on screen.
function painter(page, font, rotate) {
  const { width: W } = page.getSize();
  const map = (vx, vy) => (rotate === 90 ? { x: W - vy, y: vx } : { x: vx, y: vy });
  return {
    line(a, b, c, d, thickness = 1, color = rgb(0, 0, 0)) {
      page.drawLine({ start: map(a, b), end: map(c, d), thickness, color });
    },
    text(s, vx, vy, size, color = rgb(0, 0, 0)) {
      const p = map(vx, vy);
      page.drawText(s, { x: p.x, y: p.y, size, font, color, rotate: degrees(rotate === 90 ? 90 : 0) });
    },
    box(vx, vy, s, color) {
      for (let i = 0; i < s; i += 2) this.line(vx, vy + i, vx + s, vy + i, 2.2, color);
    },
  };
}

function drawContent(page, font, label, rotate = 0) {
  const { width, height } = page.getSize();
  const VW = rotate === 90 ? height : width;
  const VH = rotate === 90 ? width : height;
  const g = painter(page, font, rotate);
  const m = 20;
  g.line(m, m, VW - m, m);
  g.line(VW - m, m, VW - m, VH - m);
  g.line(VW - m, VH - m, m, VH - m);
  g.line(m, VH - m, m, m);
  g.text('TOP-LEFT', m + 6, VH - m - 16, 11);
  g.text('BOTTOM-RIGHT', VW - m - 92, m + 6, 11);
  const cx = VW / 2;
  g.line(cx, VH * 0.45, cx, VH * 0.82, 6);
  g.line(cx, VH * 0.82, cx - 22, VH * 0.76, 6);
  g.line(cx, VH * 0.82, cx + 22, VH * 0.76, 6);
  g.text('UP', cx + 14, VH * 0.84, 20);
  g.text(label, 50, VH * 0.36, 26);
  g.box(50, VH * 0.2, 44, rgb(1, 0, 0));
  g.box(100, VH * 0.2, 44, rgb(0, 0.7, 0));
  g.box(150, VH * 0.2, 44, rgb(0, 0, 1));
  g.box(200, VH * 0.2, 44, rgb(0.5, 0.5, 0.5));
  g.text('Fine print 6pt: The quick brown fox jumps over the lazy dog 0123456789', 50, VH * 0.15, 6);
  g.text('Fine print 8pt: The quick brown fox jumps over the lazy dog 0123456789', 50, VH * 0.13, 8);
}

async function make(name, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([p.w, p.h]);
    if (p.rotate) page.setRotation(degrees(p.rotate));
    drawContent(page, font, p.label, p.rotate || 0);
    if (p.after) p.after(doc, page, font);
  }
  fs.writeFileSync(path.join(outDir, name), await doc.save());
}

function addAnnot(doc, page, [x, y, w, h], color, flags, text) {
  const ctx = doc.context;
  const ap = ctx.register(ctx.stream(`${color} rg 0 0 ${w} ${h} re f`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h],
  }));
  const ref = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [x, y, x + w, y + h], F: flags,
    Contents: PDFString.of(text), C: [1, 0, 0], AP: { N: ap },
  }));
  page.node.addAnnot(ref);
}

// ---- Hand-written PDFs: encryption and fonts that are not embedded ---------

function writeRaw(file, objs, trailerExtra = '') {
  let out = Buffer.from('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const offsets = {};
  for (const [num, body] of objs) {
    offsets[num] = out.length;
    out = Buffer.concat([out, Buffer.from(`${num} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
  }
  const max = Math.max(...objs.map((o) => o[0]));
  const xref = out.length;
  let t = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) {
    t += offsets[i] === undefined ? '0000000000 00000 f \n' : `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  t += `trailer\n<</Size ${max + 1}/Root 1 0 R${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(outDir, file), Buffer.concat([out, Buffer.from(t, 'latin1')]));
}

function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const md5 = (...b) => crypto.createHash('md5').update(Buffer.concat(b)).digest();
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const pad = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

function makeEncrypted(file, userPw, ownerPw, perms) {
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const O = rc4(md5(pad(ownerPw)).subarray(0, 5), pad(userPw));
  const p = Buffer.alloc(4);
  p.writeInt32LE(perms);
  const fileKey = md5(pad(userPw), O, p, id).subarray(0, 5);
  const U = rc4(fileKey, PAD);
  const objKey = (n) => md5(fileKey, Buffer.from([n & 255, (n >> 8) & 255, 0, 0, 0])).subarray(0, 10);
  const content = Buffer.from(
    'BT /F1 34 Tf 60 300 Td (PROTECTED LANDSCAPE) Tj ET\n6 w 421 330 m 421 520 l S 399 480 m 421 520 l 443 480 l S\n', 'latin1');
  const enc = rc4(objKey(4), content);
  const hex = (b) => `<${b.toString('hex')}>`;
  writeRaw(file, [
    [1, Buffer.from('<</Type/Catalog/Pages 2 0 R>>')],
    [2, Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>')],
    [3, Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 842 595]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>')],
    [4, Buffer.concat([Buffer.from(`<</Length ${enc.length}>>\nstream\n`), enc, Buffer.from('\nendstream')])],
    [5, Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')],
    [6, Buffer.from(`<</Filter/Standard/V 1/R 2/O ${hex(O)}/U ${hex(U)}/P ${perms}>>`)],
  ], `/Encrypt 6 0 R/ID[${hex(id)}${hex(id)}]`);
}

function makeCjk(file) {
  const u16 = (s) => {
    let h = '';
    for (const c of s) h += c.codePointAt(0).toString(16).padStart(4, '0');
    return `<${h}>`;
  };
  const fonts = ['MingLiU', 'PMingLiU', 'DFKai-SB', 'MicrosoftJhengHei'];
  const line = '統一發票 電子發票證明聯 金額 1,234 元';
  let content = '';
  const res = [];
  const objs = [
    [1, Buffer.from('<</Type/Catalog/Pages 2 0 R>>')],
    [2, Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>')],
  ];
  fonts.forEach((name, i) => {
    const base = 10 + i * 3;
    res.push(`/F${i} ${base} 0 R`);
    objs.push([base, Buffer.from(`<</Type/Font/Subtype/Type0/BaseFont/${name}/Encoding/UniCNS-UCS2-H/DescendantFonts[${base + 1} 0 R]>>`)]);
    objs.push([base + 1, Buffer.from(`<</Type/Font/Subtype/CIDFontType2/BaseFont/${name}/CIDSystemInfo<</Registry(Adobe)/Ordering(CNS1)/Supplement 0>>/FontDescriptor ${base + 2} 0 R/DW 1000>>`)]);
    objs.push([base + 2, Buffer.from(`<</Type/FontDescriptor/FontName/${name}/Flags 6/FontBBox[-1000 -1000 1000 1000]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 880/StemV 80>>`)]);
    content += `BT /F${i} 22 Tf 40 ${720 - i * 70} Td ${u16(line)} Tj ET\n`;
    content += `BT /H 10 Tf 40 ${705 - i * 70} Td (font: ${name}, not embedded) Tj ET\n`;
  });
  objs.push([3, Buffer.from(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<<${res.join('')}/H 5 0 R>>>>>>`)]);
  const c = Buffer.from(content, 'latin1');
  objs.push([4, Buffer.concat([Buffer.from(`<</Length ${c.length}>>\nstream\n`), c, Buffer.from('\nendstream')])]);
  objs.push([5, Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')]);
  writeRaw(file, objs);
}

// Chinese text in a font that is not embedded, one line per entry: [text, size]. Like a
// real file it can draw each page number before the page and a letterhead after page 1.
function makeTextDoc(file, pages, { numbered = false, letterhead = null } = {}) {
  const u16 = (s) => {
    let h = '';
    for (const c of s) h += c.codePointAt(0).toString(16).padStart(4, '0');
    return `<${h}>`;
  };
  const pageRefs = pages.map((_, i) => 10 + i * 2);
  const objs = [
    [1, Buffer.from('<</Type/Catalog/Pages 2 0 R>>')],
    [2, Buffer.from(`<</Type/Pages/Kids[${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}]/Count ${pages.length}>>`)],
    [3, Buffer.from('<</Type/Font/Subtype/Type0/BaseFont/MingLiU/Encoding/UniCNS-UCS2-H/DescendantFonts[4 0 R]>>')],
    [4, Buffer.from('<</Type/Font/Subtype/CIDFontType2/BaseFont/MingLiU/CIDSystemInfo<</Registry(Adobe)/Ordering(CNS1)/Supplement 0>>/FontDescriptor 5 0 R/DW 1000>>')],
    [5, Buffer.from('<</Type/FontDescriptor/FontName/MingLiU/Flags 6/FontBBox[-1000 -1000 1000 1000]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 880/StemV 80>>')],
  ];
  pages.forEach((lines, i) => {
    let y = 780;
    let content = numbered ? `BT /F0 10 Tf 280 40 Td ${u16(`第 ${i + 1} 頁`)} Tj ET\n` : '';
    content += lines.map(([s, size]) => {
      const text = `BT /F0 ${size} Tf 60 ${y} Td ${u16(s)} Tj ET\n`;
      y -= size * 2;
      return text;
    }).join('');
    if (letterhead && i === 0) content += `BT /F0 10 Tf 60 812 Td ${u16(letterhead)} Tj ET\n`;
    const c = Buffer.from(content, 'latin1');
    objs.push([pageRefs[i], Buffer.from(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents ${pageRefs[i] + 1} 0 R/Resources<</Font<</F0 3 0 R>>>>>>`)]);
    objs.push([pageRefs[i] + 1, Buffer.concat([Buffer.from(`<</Length ${c.length}>>\nstream\n`), c, Buffer.from('\nendstream')])]);
  });
  writeRaw(file, objs);
}

// Two versions of a contract for the compare mode, with six differences between them:
// two numbers changed, a date changed in two places, a line added, words replaced, a line removed.
// The new one also carries the end of article 4 over to page 2, which is no difference.
// Both draw the page number first and the letterhead last, as some real files do.
function makeCompareDocs() {
  const looks = { numbered: true, letterhead: '衡達會計師事務所' };
  const title = ['勞務採購契約書', 20];
  const line = (s) => [s, 14];
  const top = [
    title,
    line('立契約人：國立臺北科技大學（以下簡稱甲方）'),
    line('英屬維京群島商幫你優股份有限公司（以下簡稱乙方）'),
  ];
  makeTextDoc('compare-old.pdf', [
    [
      ...top,
      line('第一條　契約金額為新臺幣 650,000 元整。'),
      line('第二條　履約期限自簽約日起至 115 年 12 月 31 日止。'),
      line('第三條　乙方應於每月 10 日前提出工作報告。'),
      line('第四條　付款方式：驗收合格後一次付清。'),
    ],
    [
      line('第五條　保密義務：乙方不得洩漏甲方資料。'),
      line('第六條　本契約一式二份，雙方各執一份。'),
      line('第七條　未盡事宜依政府採購法辦理。'),
    ],
  ], looks);
  makeTextDoc('compare-new.pdf', [
    [
      ...top,
      line('第一條　契約金額為新臺幣 680,000 元整。'),
      line('第二條　履約期限自簽約日起至 116 年 1 月 31 日止。'),
      line('第三條　乙方應於每月 10 日前提出工作報告。'),
      line('第三條之一　乙方應指派專人負責聯繫。'),
      line('第四條　付款方式：驗收合格後'),
    ],
    [
      line('一次付清。'),
      line('第五條　保密義務：乙方不得洩露或轉交甲方資料。'),
      line('第七條　未盡事宜依政府採購法辦理。'),
    ],
  ], looks);
}

// Like a scan: lines and boxes, but no text at all.
async function makeNoText(name) {
  const doc = await PDFDocument.create();
  for (let n = 0; n < 2; n++) {
    const page = doc.addPage(A4);
    for (let y = 760; y > 120; y -= 30) page.drawRectangle({ x: 60, y, width: 300 + (y % 120), height: 10, color: rgb(0.2, 0.2, 0.2) });
  }
  fs.writeFileSync(path.join(outDir, name), await doc.save());
}

async function makeBig(name, count) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const words = 'The quick brown fox jumps over the lazy dog while the printer spools every single page of this rather long report'.split(' ');
  for (let n = 1; n <= count; n++) {
    const land = n % 5 === 0;
    const page = doc.addPage(land ? [A4[1], A4[0]] : A4);
    const { width, height } = page.getSize();
    page.drawText(`PAGE ${n} ${land ? 'LANDSCAPE' : 'PORTRAIT'}`, { x: 40, y: height - 44, size: 18, font });
    for (let y = height - 70, l = 0; y > 40; y -= 12, l++) {
      let s = '';
      for (let k = 0; s.length < (land ? 150 : 100); k++) s += `${words[(n + l + k) % words.length]} `;
      page.drawText(s, { x: 40, y, size: 9, font });
    }
    page.drawLine({ start: { x: 30, y: 30 }, end: { x: width - 30, y: 30 }, thickness: 1 });
  }
  fs.writeFileSync(path.join(outDir, name), await doc.save());
}

// Each page holds a readable marker and a lot of incompressible data, so a test can
// tell from the markers and the file size whether another page came along.
function addMarker(doc, page, n) {
  const marker = doc.context.stream(`% PAGE${n}-MARK ${crypto.randomBytes(60000).toString('hex')}\n`);
  page.node.addContentStream(doc.context.register(marker));
}

async function makeLinked(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [first, second, third] = [1, 2, 3].map((n) => {
    const page = doc.addPage(A4);
    drawContent(page, font, `PAGE ${n} PORTRAIT`);
    addMarker(doc, page, n);
    return page;
  });
  const link = (y, extra) => doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [50, y, 250, y + 40], Border: [0, 0, 0], ...extra,
  }));
  first.node.set(PDFName.of('Annots'), doc.context.obj([
    link(700, { Dest: [second.ref, 'Fit'], P: first.ref }),
    link(640, { A: { S: 'GoTo', D: [third.ref, 'Fit'] } }),
    link(580, { A: { S: 'URI', URI: PDFString.of('https://example.com/') } }),
  ]));
  // Page actions also point at other pages, without any link on the page.
  second.node.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'GoTo', D: [third.ref, 'Fit'] } }));
  fs.writeFileSync(path.join(outDir, name), await doc.save());
}

// One form field whose widgets sit on two pages, each widget with its own value.
async function makeFormAcrossPages(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [first, second] = [1, 2].map((n) => {
    const page = doc.addPage(A4);
    drawContent(page, font, `PAGE ${n} PORTRAIT`);
    return page;
  });
  const fieldRef = doc.context.nextRef();
  const widget = (page, value) => {
    const ref = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', Rect: [50, 700, 250, 730], Parent: fieldRef, P: page.ref, V: PDFString.of(value),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    return ref;
  };
  doc.context.assign(fieldRef, doc.context.obj({
    FT: 'Tx',
    T: PDFString.of('shared'),
    Kids: [widget(first, 'VALUE-ON-PAGE-1'), widget(second, 'VALUE-ON-PAGE-2')],
  }));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [fieldRef] }));
  fs.writeFileSync(path.join(outDir, name), await doc.save({ updateFieldAppearances: false }));
}

// Four pages with bookmarks: two chapters with sections under them, and an appendix.
// The first chapter starts open, the second folded, the way the file says.
async function makeOutlined(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let n = 1; n <= 4; n++) {
    const page = doc.addPage(A4);
    drawContent(page, font, `OUTLINE PAGE ${n}`);
    pages.push(page);
  }
  const ctx = doc.context;
  const tree = [
    { title: '第一章 總則', page: 0, open: true, kids: [{ title: '1.1 目的', page: 1 }, { title: '1.2 範圍', page: 1 }] },
    { title: '第二章 內容', page: 2, open: false, kids: [{ title: '2.1 細節', page: 3 }] },
    { title: '附錄', page: 3 },
  ];
  const root = ctx.nextRef();
  function build(items, parent) {
    const refs = items.map(() => ctx.nextRef());
    items.forEach((item, i) => {
      const dict = {
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        Dest: [pages[item.page].ref, PDFName.of('Fit')],
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < items.length - 1) dict.Next = refs[i + 1];
      if (item.kids) {
        const kids = build(item.kids, refs[i]);
        dict.First = kids[0];
        dict.Last = kids.at(-1);
        dict.Count = item.open ? item.kids.length : -item.kids.length;
      }
      ctx.assign(refs[i], ctx.obj(dict));
    });
    return refs;
  }
  const top = build(tree, root);
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: top[0], Last: top.at(-1), Count: top.length + 2 }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  fs.writeFileSync(path.join(outDir, name), await doc.save());
}

// Needs a password to open (AES-128), two pages, saved the way most programs save today.
async function makeAesLocked(name, password) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['LOCKED PAGE 1', 'LOCKED PAGE 2']) drawContent(doc.addPage(A4), font, label);
  doc.encrypt({ userPassword: password, ownerPassword: 'owner-aes', algorithm: 'AES-128', permissions: { printing: 'highResolution' } });
  fs.writeFileSync(path.join(outDir, name), await doc.save({ useObjectStreams: true }));
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const P = (n) => ({ w: A4[0], h: A4[1], label: `PAGE ${n} PORTRAIT` });
  const L = (n) => ({ w: A4[1], h: A4[0], label: `PAGE ${n} LANDSCAPE` });
  await make('mixed.pdf', [P(1), L(2), P(3), L(4)]);
  await make('prerotated.pdf', [{ w: A4[0], h: A4[1], rotate: 90, label: 'A4 ROTATE90 LOOKS LANDSCAPE' }]);
  await make('landscape-rotated.pdf', [{ w: A4[1], h: A4[0], rotate: 90, label: 'LANDSCAPE ROTATE90 LOOKS PORTRAIT' }]);
  await make('square.pdf', [{ w: 500, h: 500, label: 'SQUARE' }]);
  await make('small-page.pdf', [{ w: 297.64, h: 419.53, label: 'A6 SIZE' }]);
  await make('annotated.pdf', [{
    ...L(1),
    label: 'ANNOTATIONS LANDSCAPE',
    after(doc, page, font) {
      page.drawText('RED: annot with print flag (F=4)', { x: 300, y: 500, size: 11, font });
      page.drawText('BLUE: annot WITHOUT print flag (F=0)', { x: 300, y: 430, size: 11, font });
      addAnnot(doc, page, [120, 485, 160, 40], '1 0 0', 4, 'print flag set');
      addAnnot(doc, page, [120, 415, 160, 40], '0 0 1', 0, 'no print flag');
    },
  }]);
  await makeLinked('linked.pdf');
  await makeFormAcrossPages('form-across-pages.pdf');
  makeEncrypted('enc-open-password.pdf', 'test1234', 'owner', -4);
  makeEncrypted('enc-owner-print-allowed.pdf', '', 'owner', -4);
  makeEncrypted('enc-owner-no-print.pdf', '', 'owner', -8);
  await makeAesLocked('enc-aes-password.pdf', 'test1234');
  await makeOutlined('outline.pdf');
  makeCjk('cjk-not-embedded.pdf');
  makeCompareDocs();
  await makeNoText('compare-scan.pdf');
  await makeBig('big-500pages.pdf', 500);
  fs.writeFileSync(path.join(outDir, 'corrupt.pdf'), 'this is not a pdf file at all');
  fs.writeFileSync(path.join(outDir, 'empty.pdf'), '');
  fs.writeFileSync(path.join(outDir, 'notes.txt'), 'not a pdf');
  for (const f of fs.readdirSync(outDir)) console.log(f.padEnd(32), fs.statSync(path.join(outDir, f)).size);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
