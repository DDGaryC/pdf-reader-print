const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const diff = () => import('../renderer/text-diff.js');
const reading = () => import('../renderer/compare-text.js');
const fixture = (name) => path.join(__dirname, 'fixtures', name);

// One token list per side, with a line number for each token. Lines are given as strings.
async function sides(leftLines, rightLines) {
  const { splitTokens } = await diff();
  const side = (lines) => {
    const tokens = [];
    const line = [];
    lines.forEach((text, n) => {
      for (const { text: token } of splitTokens(text)) {
        tokens.push(token);
        line.push(n);
      }
    });
    return { tokens, line };
  };
  return [side(leftLines), side(rightLines)];
}

async function differences(leftLines, rightLines) {
  const { compareTexts } = await diff();
  const [left, right] = await sides(leftLines, rightLines);
  const result = compareTexts(left, right);
  return {
    ...result,
    words: result.differences.map((d) => [left.tokens.slice(d.aStart, d.aEnd).join(''), right.tokens.slice(d.bStart, d.bEnd).join('')]),
  };
}

// ---- Tokens

test('compare: Chinese goes one character at a time, letters and digits as words', async () => {
  const { splitTokens } = await diff();
  assert.deepEqual(splitTokens('金額 650,000 元 NT$ abc12').map((t) => t.text), ['金', '額', '650', ',', '000', '元', 'NT', '$', 'abc12']);
});

test('compare: spaces of every kind are left out, and full-width letters count as normal ones', async () => {
  const { splitTokens } = await diff();
  assert.deepEqual(splitTokens('第一條\u{3000}Ａ１\u{a0} b').map((t) => t.text), ['第', '一', '條', 'A1', 'b']);
});

test('compare: each token knows where it is in the string', async () => {
  const { splitTokens } = await diff();
  const text = '甲 ab𠀀c';
  const tokens = splitTokens(text);
  assert.deepEqual(tokens.map((t) => text.slice(t.start, t.end)), ['甲', 'ab', '𠀀', 'c']);
});

// ---- Differences

test('compare: the same text has no differences', async () => {
  const result = await differences(['第一條 金額 650,000 元', '第二條'], ['第一條 金額 650,000 元', '第二條']);
  assert.deepEqual(result.differences, []);
  assert.equal(result.rough, false);
});

test('compare: text that only wraps or spaces differently is the same', async () => {
  const result = await differences(['乙方應於每月 10 日前', '提出工作報告。'], ['乙方應於每月10日前提出', '工作 報告。']);
  assert.deepEqual(result.differences, []);
});

test('compare: a changed number is one difference, and only the number', async () => {
  const result = await differences(['契約金額為新臺幣 650,000 元整。'], ['契約金額為新臺幣 680,000 元整。']);
  assert.deepEqual(result.words, [['650', '680']]);
});

test('compare: two changes a character apart stay two', async () => {
  const result = await differences(['至 115 年 12 月 31 日止'], ['至 116 年 1 月 31 日止']);
  assert.deepEqual(result.words, [['115', '116'], ['12', '1']]);
});

test('compare: a line added, a line removed and words replaced', async () => {
  const left = ['第三條 工作報告。', '第四條 一次付清。', '第五條 不得洩漏資料。', '第六條 一式二份。', '第七條 依採購法。'];
  const right = ['第三條 工作報告。', '第三條之一 指派專人。', '第四條 一次付清。', '第五條 不得洩露或轉交資料。', '第七條 依採購法。'];
  const result = await differences(left, right);
  assert.deepEqual(result.words, [['', '第三條之一指派專人。'], ['漏', '露或轉交'], ['第六條一式二份。', '']]);
  const added = result.differences[0];
  assert.equal(added.aStart, added.aEnd, 'nothing on the left side');
});

test('compare: a rewritten sentence is one difference, not many small ones', async () => {
  const result = await differences(['乙方應於驗收合格後的三十日內付款'], ['甲方須在收到發票後的十個工作天內撥款']);
  assert.equal(result.differences.length, 1, JSON.stringify(result.words));
});

test('compare: a moved line shows as removed in one place and added in another', async () => {
  const result = await differences(['第一條', '第二條', '第三條'], ['第二條', '第三條', '第一條']);
  assert.deepEqual(result.words, [['第一條', ''], ['', '第一條']]);
});

test('compare: an empty side is all one difference', async () => {
  const result = await differences([], ['新的內容']);
  assert.deepEqual(result.words, [['', '新的內容']]);
  assert.deepEqual((await differences(['舊的內容'], [])).words, [['舊的內容', '']]);
  assert.deepEqual((await differences([], [])).differences, []);
});

test('compare: big documents with few changes are quick', async () => {
  const lines = [];
  for (let n = 0; n < 6000; n++) lines.push(`第${n}項 乙方應於每月${n % 28 + 1}日前提出工作報告並由甲方審查`);
  const changed = [...lines];
  changed[100] = lines[100].replace('每月', '每週');
  changed.splice(4000, 1);
  changed.splice(5000, 0, '新增的一行');
  const started = Date.now();
  const result = await differences(lines, changed);
  assert.equal(result.differences.length, 3, JSON.stringify(result.words.slice(0, 5)));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('compare: completely different big documents finish quickly and say so', async () => {
  const left = [];
  const right = [];
  for (let n = 0; n < 4000; n++) {
    left.push(`甲乙丙丁戊己庚辛壬癸 ${n % 7}`);
    right.push(`子丑寅卯辰巳午未申酉 ${n % 5}`);
  }
  const started = Date.now();
  const result = await differences(left, right);
  assert.ok(result.differences.length >= 1);
  assert.equal(result.rough, true);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

// ---- Reading real files

async function openPdf(name) {
  const pdfjs = await import(pathToFileURL(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);
  const cMapUrl = `${path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'cmaps')}${path.sep}`;
  return pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(fixture(name))), cMapUrl, cMapPacked: true, isEvalSupported: false, verbosity: 0 }).promise;
}

// pdf.js warns about missing drawing helpers in Node; reading text does not need them.
const quietly = async (work) => {
  const { warn } = console;
  console.warn = () => {};
  try {
    return await work();
  } finally {
    console.warn = warn;
  }
};

test('compare: reads the words of a file with Chinese text, page by page and line by line', async () => {
  const { readText } = await reading();
  const doc = await quietly(() => openPdf('compare-old.pdf'));
  const pagesSeen = [];
  const text = await quietly(() => readText(doc, { onPage: (n, total) => pagesSeen.push(`${n}/${total}`) }));
  assert.deepEqual(pagesSeen, ['1/2', '2/2']);
  assert.equal(text.pageCount, 2);
  assert.equal(text.tokens.slice(0, 8).join(''), '衡達會計師事務所', 'the letterhead, drawn last, is read first');
  assert.equal(text.tokens.slice(8, 15).join(''), '勞務採購契約書');
  assert.ok(text.tokens.includes('650'));
  assert.equal(new Set(text.line).size, 13, 'ten lines, the letterhead and two page numbers');
  assert.deepEqual([...new Set(text.page)], [1, 2]);
  assert.equal(text.tokens.filter((_, i) => text.edge[i]).join(''), '第1頁第2頁', 'only the page numbers are at the edges');
  assert.equal(text.tokens.slice([...text.page].indexOf(2) - 3, [...text.page].indexOf(2)).join(''), '第1頁', 'a page number drawn first is read last');
  // Every box sits on the page, in reading order down the page.
  for (let i = 0; i < text.tokens.length; i++) {
    const [x0, y0, x1, y1] = text.box.subarray(4 * i, 4 * i + 4);
    assert.ok(x0 >= 50 && x1 <= 595 && y0 >= 0 && y1 <= 842 && x1 > x0 && y1 > y0, `${text.tokens[i]}: ${[x0, y0, x1, y1]}`);
  }
  await doc.destroy();
});

test('compare: the two versions of the contract differ in six places', async () => {
  const { readText, boxesOf, splitAtEdges, compareDocuments } = await reading();
  const { compareTexts } = await diff();
  const [oldDoc, newDoc] = await quietly(() => Promise.all([openPdf('compare-old.pdf'), openPdf('compare-new.pdf')]));
  const [oldText, newText] = await quietly(() => Promise.all([readText(oldDoc), readText(newDoc)]));
  // Read as one, the page number between the pages makes the words carried over look moved.
  assert.ok(compareTexts(oldText, newText).differences.length > 6);
  const [oldParts, newParts] = [splitAtEdges(oldText), splitAtEdges(newText)];
  const { differences: found } = compareDocuments(oldParts, newParts);
  assert.ok(found.every((d) => d.part === 'body'));
  const [left, right] = [oldParts.body, newParts.body];
  const words = found.map((d) => [left.tokens.slice(d.aStart, d.aEnd).join(''), right.tokens.slice(d.bStart, d.bEnd).join('')]);
  assert.deepEqual(words, [
    ['650', '680'],
    ['115', '116'],
    ['12', '1'],
    ['', '第三條之一乙方應指派專人負責聯繫。'],
    ['漏', '露或轉交'],
    ['第六條本契約一式二份,雙方各執一份。', ''],
  ]);
  // The number sits on the line of the first article, on page 1.
  const [box] = boxesOf(oldParts.body, found[0].aStart, found[0].aEnd);
  assert.equal(box.page, 1);
  assert.ok(box.rect[1] < 690 && box.rect[3] > 670, JSON.stringify(box));
  // The removed line is on page 2.
  assert.deepEqual(boxesOf(left, found[5].aStart, found[5].aEnd).map((b) => b.page), [2]);
  await Promise.all([oldDoc.destroy(), newDoc.destroy()]);
});

// A document as pdf.js would hand it over: each page a list of [text, x, y, size], one line each.
function fakeDoc(pages) {
  return {
    numPages: pages.length,
    getPage: async (n) => ({
      getTextContent: async () => ({
        styles: { f: { ascent: 0.85, descent: -0.15 } },
        items: pages[n - 1].map(([str, x, y, size = 12]) => ({
          str, transform: [size, 0, 0, size, x, y], width: [...str].length * size, height: size, fontName: 'f', hasEOL: true,
        })),
      }),
      getViewport: () => ({ width: 595, height: 842, convertToViewportRectangle: ([x0, y0, x1, y1]) => [x0, 842 - y0, x1, 842 - y1] }),
      cleanup() {},
    }),
  };
}
const edgeWords = (text, page) => text.tokens.filter((_, i) => text.edge[i] && text.page[i] === page).join('');

test('compare: lines are read from the top of the page, left to right, however the file draws them', async () => {
  const { readText } = await reading();
  const text = await readText(fakeDoc([[['丙', 60, 100], ['右', 300, 500], ['左', 60, 500], ['甲', 60, 700]]]));
  assert.equal(text.tokens.join(''), '甲左右丙');
});

test('compare: page numbers of many kinds are set apart, other numbers are not', async () => {
  const { readText } = await reading();
  const body = (n) => [['本文第', 60, 600], [`${n}`, 60, 400], ['段', 60, 300]];
  const text = await readText(fakeDoc([
    [...body(1), ['- 1 -', 280, 30]],
    [...body(2), ['第 2 頁，共 4 頁', 250, 30]],
    [['Page 3 of 4', 250, 815], ...body(3)],
    [...body(4), ['4/4', 280, 30]],
  ]));
  assert.deepEqual([1, 2, 3, 4].map((n) => edgeWords(text, n)), ['-1-', '第2頁,共4頁', 'Page3of4', '4/4']);
  assert.deepEqual(text.tokens.filter((token, i) => !text.edge[i] && /^\d+$/.test(token)), ['1', '2', '3', '4'], 'the numbers in the body stay');
});

test('compare: a header on every page is set apart, and a changed header is still found', async () => {
  const { readText, splitAtEdges, compareDocuments } = await reading();
  const doc = (company) => fakeDoc([1, 2, 3].map((n) => [[`${company}年度報告`, 60, 820], [`第${n}章內容`, 60, 600]]));
  const [left, right] = await Promise.all([readText(doc('甲公司')), readText(doc('乙公司'))]);
  assert.equal(edgeWords(left, 2), '甲公司年度報告');
  const { differences } = compareDocuments(splitAtEdges(left), splitAtEdges(right));
  assert.equal(differences.length, 3, 'once on each page');
  assert.ok(differences.every((d) => d.part === 'edges'));
});

test('compare: words carried over to the next page are no difference, whatever comes between', async () => {
  const { readText, splitAtEdges, compareDocuments } = await reading();
  const { compareTexts } = await diff();
  // As in a real letter: the letterhead drawn after page 1, the number drawn before page 2.
  const doc = (endOfOne, startOfTwo) => fakeDoc([
    [['委任書正文', 60, 760], [endOfOne, 60, 700], ['1', 290, 30], ['衡達會計師事務所', 60, 815]],
    [['2', 290, 30], [startOfTwo, 60, 780], ['其餘內容', 60, 740]],
  ]);
  const [left, right] = await Promise.all([readText(doc('因舞弊', '可能涉及共謀')), readText(doc('因舞弊可能', '涉及共謀'))]);
  assert.ok(compareTexts(left, right).differences.length > 0, 'read as one, the words look moved');
  assert.deepEqual(compareDocuments(splitAtEdges(left), splitAtEdges(right)).differences, []);
});

test('compare: a file without text is recognised', async () => {
  const { readText, hasLittleText, gapAt } = await reading();
  const doc = await quietly(() => openPdf('compare-scan.pdf'));
  const text = await quietly(() => readText(doc));
  assert.equal(text.tokens.length, 0);
  assert.ok(hasLittleText(text));
  assert.equal(gapAt(text, 0), null);
  await doc.destroy();
});

test('compare: the mark for missing words sits before the next word, or after the last', async () => {
  const { gapAt } = await reading();
  const text = {
    tokens: ['甲', '乙'],
    line: Int32Array.from([0, 0]),
    page: Int32Array.from([1, 1]),
    box: Float64Array.from([10, 100, 20, 112, 20, 100, 30, 112]),
  };
  const before = gapAt(text, 1);
  assert.equal(before.page, 1);
  assert.ok(before.rect[0] < 20 && before.rect[2] > 20);
  const after = gapAt(text, 2);
  assert.ok(after.rect[0] < 30 && after.rect[2] > 30);
});
