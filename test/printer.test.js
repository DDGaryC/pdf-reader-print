const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildPrintArgs, buildPrintSettings, choosePrinter, mergePrinters, parseWindowsPrinters, sanitizePrintSettings,
} = require('../lib/printer');

const base = { scale: 'fit', grayscale: false, duplex: 'simplex', paper: 'A4' };

test('print settings: the defaults', () => {
  assert.equal(buildPrintSettings(base), 'fit,portrait,color,simplex,paper=A4,ignore-pdf-print-settings');
});

test('print settings: the example from the plan', () => {
  assert.equal(
    buildPrintSettings({ pages: '1-3,5', copies: 2, scale: 'fit', grayscale: true, duplex: 'duplexlong', paper: 'A4' }),
    '1-3,5,2x,fit,portrait,monochrome,duplexlong,paper=A4,ignore-pdf-print-settings',
  );
});

test('print settings: every option reaches the command', () => {
  for (const scale of ['fit', 'shrink', 'noscale']) assert.match(buildPrintSettings({ ...base, scale }), new RegExp(`^${scale},`));
  for (const duplex of ['simplex', 'duplexlong', 'duplexshort']) assert.ok(buildPrintSettings({ ...base, duplex }).includes(`,${duplex},`));
  for (const paper of ['A4', 'A3', 'A5', 'letter', 'legal']) assert.ok(buildPrintSettings({ ...base, paper }).includes(`paper=${paper},`));
  assert.ok(buildPrintSettings({ ...base, grayscale: true }).includes(',monochrome,'));
});

test('print settings: always keep portrait and ignore the settings stored in the PDF', () => {
  for (const options of [base, { ...base, pages: '2', copies: 3, scale: 'shrink', grayscale: true }]) {
    const settings = buildPrintSettings(options);
    assert.ok(settings.includes('portrait'));
    assert.ok(settings.endsWith('ignore-pdf-print-settings'));
  }
});

test('print settings: refuses bad page ranges and copies', () => {
  for (const pages of ['abc', '1-', '1,,2', '1-3,landscape', '-silent']) {
    assert.throws(() => buildPrintSettings({ ...base, pages }), /invalid page range/);
  }
  for (const copies of [0, -1, 1000, 1.5, '2']) {
    assert.throws(() => buildPrintSettings({ ...base, copies }), /invalid copies/);
  }
});

test('print settings: unknown values fall back instead of reaching the command', () => {
  assert.equal(
    buildPrintSettings({ scale: 'huge', grayscale: false, duplex: 'triple', paper: 'A0;x' }),
    'fit,portrait,color,simplex,paper=A4,ignore-pdf-print-settings',
  );
});

test('print command: a file name with spaces and Chinese stays one argument', () => {
  const file = 'C:\\文件 夾\\測 試.pdf';
  const args = buildPrintArgs({ ...base, printer: 'HP M127 辦公室', file, appDataDir: 'C:\\data' });
  assert.deepEqual(args, [
    '-appdata', 'C:\\data',
    '-print-to', 'HP M127 辦公室',
    '-print-settings', 'fit,portrait,color,simplex,paper=A4,ignore-pdf-print-settings',
    '-silent',
    file,
  ]);
});

test('print command: needs a printer and a file', () => {
  assert.throws(() => buildPrintArgs({ ...base, printer: '', file: 'a.pdf', appDataDir: 'x' }), /no printer/);
  assert.throws(() => buildPrintArgs({ ...base, printer: 'P', file: '', appDataDir: 'x' }), /no file/);
});

test('remembered settings: keep only known values, never copies or pages', () => {
  assert.deepEqual(sanitizePrintSettings(undefined), {
    printer: null, direction: 'counterclockwise', scale: 'fit', paper: 'A4', grayscale: false, duplex: 'simplex',
  });
  const cleaned = sanitizePrintSettings({
    printer: 'SHARP', direction: 'clockwise', scale: 'shrink', paper: 'A3', grayscale: true, duplex: 'duplexshort', copies: 5, pages: '1-2',
  });
  assert.deepEqual(cleaned, {
    printer: 'SHARP', direction: 'clockwise', scale: 'shrink', paper: 'A3', grayscale: true, duplex: 'duplexshort',
  });
  assert.equal(sanitizePrintSettings({ direction: 'sideways', grayscale: 'yes', printer: 5 }).direction, 'counterclockwise');
  assert.equal(sanitizePrintSettings({ grayscale: 'yes' }).grayscale, false);
  assert.equal(sanitizePrintSettings({ printer: 5 }).printer, null);
});

test('printers: reads what Windows reports', () => {
  const json = JSON.stringify([
    { Name: 'Microsoft Print to PDF', PortName: 'PORTPROMPT:', Default: false },
    { Name: 'SHARP MX-3050V PCL6', PortName: '192.168.100.6', Default: true },
  ]);
  assert.deepEqual(parseWindowsPrinters(json), [
    { name: 'Microsoft Print to PDF', isDefault: false, asksForFile: true },
    { name: 'SHARP MX-3050V PCL6', isDefault: true, asksForFile: false },
  ]);
  assert.deepEqual(parseWindowsPrinters('{"Name":"Only","PortName":"x","Default":true}'), [{ name: 'Only', isDefault: true, asksForFile: false }]);
  assert.deepEqual(parseWindowsPrinters('not json'), []);
});

test('printers: works when Windows gave no details', () => {
  assert.deepEqual(mergePrinters([{ name: 'A', displayName: 'A 顯示' }, { name: 'B' }], [{ name: 'B', isDefault: true, asksForFile: true }]), [
    { name: 'A', displayName: 'A 顯示', isDefault: false, asksForFile: false },
    { name: 'B', displayName: 'B', isDefault: true, asksForFile: true },
  ]);
});

test('printers: last used, then the Windows default, then the first', () => {
  const printers = [{ name: 'A', isDefault: false }, { name: 'B', isDefault: true }, { name: 'C', isDefault: false }];
  assert.equal(choosePrinter(printers, 'C'), 'C');
  assert.equal(choosePrinter(printers, 'removed printer'), 'B');
  assert.equal(choosePrinter(printers, null), 'B');
  assert.equal(choosePrinter([{ name: 'A', isDefault: false }], null), 'A');
  assert.equal(choosePrinter([], 'A'), null);
});

test('page range: accepts ranges, single pages and Chinese input', async () => {
  const { parsePageRange } = await import('../renderer/page-range.js');
  assert.deepEqual(parsePageRange('1-3,5,8', 12), { ok: true, pages: [1, 2, 3, 5, 8], normalized: '1-3,5,8' });
  assert.deepEqual(parsePageRange(' 2 , 4 - 5 ', 12), { ok: true, pages: [2, 4, 5], normalized: '2,4-5' });
  assert.deepEqual(parsePageRange('１－３，５、８', 12), { ok: true, pages: [1, 2, 3, 5, 8], normalized: '1-3,5,8' });
  assert.deepEqual(parsePageRange('12', 12), { ok: true, pages: [12], normalized: '12' });
});

test('page range: explains what is wrong', async () => {
  const { parsePageRange } = await import('../renderer/page-range.js');
  assert.match(parsePageRange('', 12).message, /請輸入/);
  assert.match(parsePageRange('abc', 12).message, /格式/);
  assert.match(parsePageRange('1-', 12).message, /格式/);
  assert.match(parsePageRange('1,,2', 12).message, /格式/);
  assert.match(parsePageRange('13', 12).message, /1 到 12/);
  assert.match(parsePageRange('0', 12).message, /1 到 12/);
  assert.match(parsePageRange('5-20', 12).message, /1 到 12/);
  assert.match(parsePageRange('5-3', 12).message, /由小到大/);
});

test('spaces between numbers separate them instead of gluing them together', async () => {
  const { parsePageRange } = await import('../renderer/page-range.js');
  assert.deepStrictEqual(parsePageRange('1 3', 20).pages, [1, 3]);
  assert.deepStrictEqual(parsePageRange('1 - 3', 20).pages, [1, 2, 3]);
  assert.deepStrictEqual(parsePageRange('1, 3', 20).pages, [1, 3]);
  assert.deepStrictEqual(parsePageRange('１　３', 20).pages, [1, 3]);
});

test('what a split will make', async () => {
  const { splitPlan, leftOutPages } = await import('../renderer/split-plan.js');
  const shape = (plan) => plan.parts.map(({ from, to, suffix }) => `${from}-${to}:${suffix}`).join(' ');
  assert.strictEqual(shape(splitPlan('each', '', 3)), '1-1:1 2-2:2 3-3:3');
  assert.strictEqual(shape(splitPlan('every', '2', 5)), '1-2:1 3-4:2 5-5:3');
  assert.strictEqual(shape(splitPlan('every', 1, 2)), '1-1:1 2-2:2');
  assert.strictEqual(shape(splitPlan('ranges', '1-3, 4-8, 9', 12)), '1-3:1-3 4-8:4-8 9-9:9');
  assert.strictEqual(splitPlan('every', '0', 5).ok, false);
  assert.strictEqual(splitPlan('every', '1.5', 5).ok, false);
  assert.strictEqual(splitPlan('every', '', 5).ok, false);
  assert.ok(splitPlan('every', '5', 5).message.includes('只有 5 頁'));
  assert.strictEqual(splitPlan('ranges', '', 5).ok, false);
  assert.strictEqual(splitPlan('ranges', '4-9', 5).ok, false);
  assert.strictEqual(leftOutPages(splitPlan('ranges', '1-2,2-3', 5).parts, 5), 2);
  assert.strictEqual(leftOutPages(splitPlan('each', '', 5).parts, 5), 0);
});
