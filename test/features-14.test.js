// Version 1.4: saved print setups, printing files that need a password, recent files,
// the document information words, and pictures made into PDF pages.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PDFDict, PDFDocument, PDFName, PDFStream } = require('@cantoo/pdf-lib');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

// ---- Saved print setups -----------------------------------------------------

test('saved setups are cleaned when read back, and names stay unique', () => {
  const { sanitizeSetups } = require('../lib/print-setups');
  const list = sanitizeSetups([
    { name: '  發票  雙面 ', printer: 'SHARP', duplex: 'duplexshort', perSheet: 2, border: true },
    { name: '發票 雙面', printer: 'HP' },
    { name: '', printer: 'HP' },
    { name: '奇怪', perSheet: 3, duplex: 'sideways', paper: 'B9', direction: 'up', grayscale: 'yes' },
    null,
    'text',
  ]);
  assert.deepStrictEqual(list.map((one) => one.name), ['發票 雙面', '奇怪']);
  assert.deepStrictEqual(list[0], {
    name: '發票 雙面', printer: 'SHARP', direction: 'counterclockwise', scale: 'fit', paper: 'A4', grayscale: false, duplex: 'duplexshort', perSheet: 2, border: true,
  });
  assert.deepStrictEqual(
    { perSheet: list[1].perSheet, duplex: list[1].duplex, paper: list[1].paper, direction: list[1].direction, grayscale: list[1].grayscale, printer: list[1].printer },
    { perSheet: 1, duplex: 'simplex', paper: 'A4', direction: 'counterclockwise', grayscale: false, printer: null },
  );
  assert.deepStrictEqual(sanitizeSetups('nope'), []);
});

test('saving a setup with a name already there replaces it in place', () => {
  const { addSetup, removeSetup, MAX_SETUPS } = require('../lib/print-setups');
  let result = addSetup([], { name: 'A', printer: 'P1' });
  assert.ok(result.ok && !result.replaced);
  result = addSetup(result.setups, { name: 'B', printer: 'P2' });
  result = addSetup(result.setups, { name: 'A', printer: 'P3', perSheet: 4 });
  assert.ok(result.ok && result.replaced);
  assert.deepStrictEqual(result.setups.map((one) => [one.name, one.printer, one.perSheet]), [['A', 'P3', 4], ['B', 'P2', 1]]);
  assert.strictEqual(addSetup(result.setups, { name: '   ' }).reason, 'NO_NAME');
  assert.deepStrictEqual(removeSetup(result.setups, ' A ').map((one) => one.name), ['B']);
  const full = Array.from({ length: MAX_SETUPS }, (_v, i) => ({ name: `S${i}` }));
  assert.strictEqual(addSetup(full, { name: 'one more' }).reason, 'TOO_MANY');
  assert.ok(addSetup(full, { name: 'S3', duplex: 'duplexlong' }).ok, 'replacing still works when the list is full');
});

test('a setup is shown as chosen only while the dialog matches it', async () => {
  const { matches, findMatching, suggestName } = await import('../renderer/print-setups.js');
  const setup = { name: 'x', printer: 'SHARP', direction: 'counterclockwise', scale: 'fit', paper: 'A4', grayscale: false, duplex: 'duplexshort', perSheet: 2, border: true };
  const current = { ...setup };
  delete current.name;
  assert.ok(matches(setup, current));
  assert.ok(!matches(setup, { ...current, duplex: 'simplex' }));
  assert.ok(!matches(setup, { ...current, border: false }));
  assert.ok(matches(setup, { ...current, scale: 'noscale' }), 'scaling does not count with several pages per sheet');
  assert.ok(!matches({ ...setup, perSheet: 1 }, { ...current, perSheet: 1, scale: 'noscale' }));
  assert.ok(matches({ ...setup, perSheet: 1 }, { ...current, perSheet: 1, border: false }), 'frames do not count with one page per sheet');
  assert.ok(!matches(setup, { ...current, printer: 'HP' }));
  assert.ok(matches({ ...setup, printer: null }, { ...current, printer: 'HP' }), 'a setup without a printer fits any');
  assert.ok(!matches(setup, { ...current, direction: 'clockwise' }));
  assert.ok(matches(setup, { ...current, direction: 'clockwise' }, { ignoreDirection: true }));
  assert.strictEqual(findMatching([{ ...setup, name: 'a', duplex: 'simplex' }, setup], current).name, 'x');
  assert.strictEqual(findMatching([], current), null);
  assert.strictEqual(suggestName(current, 'SHARP MX-3050V'), 'SHARP MX-3050V、每張 2 頁、雙面短邊');
  assert.strictEqual(suggestName({ ...current, perSheet: 1, duplex: 'simplex', grayscale: true, paper: 'A3', direction: 'clockwise', scale: 'shrink' }, ''), '單面、A3、灰階、順時針、只縮不放');
  assert.ok(suggestName(current, 'A very long printer name that goes on and on').length <= 40);
});

// ---- Printing files that need a password ------------------------------------

test('a file that needs a password is unlocked for printing, and the copy opens without one', async () => {
  const { unlockedBytes } = require('../lib/unlock');
  for (const name of ['enc-open-password.pdf', 'enc-aes-password.pdf']) {
    const bytes = await unlockedBytes(fs.readFileSync(fixture(name)), 'test1234');
    const doc = await PDFDocument.load(bytes);
    assert.ok(!doc.isEncrypted, name);
    assert.ok(!Buffer.from(bytes).toString('latin1').includes('/Encrypt'), `${name} carries no lock`);
  }
});

test('a wrong password is said plainly, and an unlocked file passes through', async () => {
  const { unlockedBytes, usablePassword } = require('../lib/unlock');
  await assert.rejects(unlockedBytes(fs.readFileSync(fixture('enc-aes-password.pdf')), 'nope'), { code: 'WRONG_PASSWORD' });
  await assert.rejects(unlockedBytes(fs.readFileSync(fixture('enc-open-password.pdf')), ''), { code: 'WRONG_PASSWORD' });
  const plain = await unlockedBytes(fs.readFileSync(fixture('mixed.pdf')), 'anything');
  assert.strictEqual((await PDFDocument.load(plain)).getPageCount(), 4);
  assert.ok(usablePassword('') && usablePassword('密碼'));
  assert.ok(!usablePassword(null) && !usablePassword(12) && !usablePassword('x'.repeat(2000)));
});

test('several pages per sheet work on a file that needs a password', async () => {
  const { buildSheets } = require('../lib/n-up');
  const [w, h] = [595.28, 841.89];
  const plan = {
    width: w, height: h, rotate: 90, border: false,
    sheets: [{ slots: [
      { page: 1, box: [0, 0, w, h], matrix: [0.5, 0, 0, 0.5, 0, 0] },
      { page: 2, box: [0, 0, w, h], matrix: [0.5, 0, 0, 0.5, w / 2, 0] },
    ] }],
  };
  const bytes = await buildSheets(fs.readFileSync(fixture('enc-aes-password.pdf')), plan, 'test1234');
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1);
  await assert.rejects(buildSheets(fs.readFileSync(fixture('enc-aes-password.pdf')), plan, 'wrong'));
});

// ---- Recent files -----------------------------------------------------------

test('recent files: newest first, one entry per file whatever the case, with the page kept', () => {
  const recent = require('../lib/recent');
  let list = recent.noteOpened([], 'C:\\docs\\a.pdf');
  list = recent.noteOpened(list, 'C:\\docs\\b.pdf');
  list = recent.notePage(list, 'c:\\DOCS\\A.PDF', 7);
  list = recent.noteOpened(list, 'C:\\Docs\\A.pdf');
  assert.deepStrictEqual(list, [{ path: 'C:\\Docs\\A.pdf', page: 7 }, { path: 'C:\\docs\\b.pdf', page: 1 }]);
  assert.strictEqual(recent.pageOf(list, 'c:\\docs\\a.pdf'), 7);
  assert.strictEqual(recent.pageOf(list, 'C:\\docs\\c.pdf'), null);
  assert.deepStrictEqual(recent.forget(list, 'C:\\DOCS\\B.PDF').map((entry) => entry.path), ['C:\\Docs\\A.pdf']);
  for (let i = 0; i < 30; i++) list = recent.noteOpened(list, `C:\\docs\\f${i}.pdf`);
  assert.strictEqual(list.length, recent.MAX_RECENT);
  assert.strictEqual(list[0].path, 'C:\\docs\\f29.pdf');
});

test('recent files: anything odd in the settings file is dropped', () => {
  const recent = require('../lib/recent');
  const list = recent.sanitizeRecent([
    { path: 'C:\\ok.pdf', page: 3 },
    { path: 'relative.pdf', page: 1 },
    { path: 'C:\\picture.jpg' },
    { path: 'C:\\bad-page.pdf', page: -2 },
    { path: 42 },
    null,
  ]);
  assert.deepStrictEqual(list, [{ path: 'C:\\ok.pdf', page: 3 }, { path: 'C:\\bad-page.pdf', page: 1 }]);
  assert.deepStrictEqual(recent.notePage(list, 'C:\\ok.pdf', 0), list);
  assert.deepStrictEqual(recent.noteOpened(list, 'not a path'), list);
  assert.deepStrictEqual(recent.sanitizeRecent({}), []);
});

// ---- Document information ---------------------------------------------------

test('document information: paper names, sizes, dates and permissions in plain words', async () => {
  const { paperName, describeSizes, fileSize, dateText, permissionLines } = await import('../renderer/doc-info.js');
  assert.strictEqual(paperName(595.28, 841.89), 'A4 直式');
  assert.strictEqual(paperName(841.89, 595.28), 'A4 橫式');
  assert.strictEqual(paperName(612, 792), 'Letter 直式');
  assert.strictEqual(paperName(728.5, 1031.8), 'B4 直式');
  assert.strictEqual(paperName(500, 500), '176 × 176 公釐');
  assert.strictEqual(describeSizes(['A4 直式', 'A4 直式']), 'A4 直式（全部 2 頁）');
  assert.strictEqual(describeSizes(['A4 橫式', 'A4 直式', 'A4 直式']), 'A4 直式（2 頁）、A4 橫式（1 頁）');
  assert.strictEqual(fileSize(900), '900 位元組');
  assert.strictEqual(fileSize(1536), '1.5 KB（1,536 位元組）');
  assert.strictEqual(fileSize(25 * 1024 * 1024), '25 MB（26,214,400 位元組）');
  assert.strictEqual(dateText(new Date(2026, 10, 25, 9, 5)), '2026/11/25 09:05');
  assert.strictEqual(dateText(null), '');
  assert.deepStrictEqual(permissionLines(null), ['沒有限制']);
  const limited = permissionLines([16]);
  assert.ok(limited.includes('列印：禁止') && limited.includes('複製文字：允許') && limited.includes('修改內容：禁止'));
});

// ---- Pictures made into PDF pages -------------------------------------------

// A JPEG with just enough structure to be read and embedded, optionally saying which way is up.
function jpeg(width, height, orientation = null, order = 'II') {
  const parts = [Buffer.from([0xFF, 0xD8])];
  if (orientation) {
    const tiff = Buffer.alloc(26);
    const little = order === 'II';
    const w16 = (value, at) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
    const w32 = (value, at) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
    tiff.write(order, 0, 'latin1');
    w16(42, 2);
    w32(8, 4);
    w16(1, 8);
    w16(0x0112, 10);
    w16(3, 12);
    w32(1, 14);
    w16(orientation, 18);
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const head = Buffer.from([0xFF, 0xE1, 0, 0]);
    head.writeUInt16BE(exif.length + 2, 2);
    parts.push(head, exif);
  }
  parts.push(Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
    0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]));
  parts.push(Buffer.from([0xFF, 0xD9]));
  return Buffer.concat(parts);
}

function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('pictures: type, size and which way is up are read from the file', () => {
  const { readImageInfo, shownSize, isImagePath } = require('../lib/images');
  assert.deepStrictEqual(readImageInfo(jpeg(400, 300)), { type: 'jpeg', width: 400, height: 300, orientation: 1 });
  assert.deepStrictEqual(readImageInfo(jpeg(400, 300, 6)), { type: 'jpeg', width: 400, height: 300, orientation: 6 });
  assert.deepStrictEqual(readImageInfo(jpeg(400, 300, 8, 'MM')), { type: 'jpeg', width: 400, height: 300, orientation: 8 });
  assert.deepStrictEqual(readImageInfo(jpeg(400, 300, 99)), { type: 'jpeg', width: 400, height: 300, orientation: 1 });
  assert.deepStrictEqual(readImageInfo(png(5, 3)), { type: 'png', width: 5, height: 3, orientation: 1 });
  assert.strictEqual(readImageInfo(Buffer.from('not a picture')), null);
  assert.strictEqual(readImageInfo(Buffer.from([0xFF, 0xD8, 0xFF])), null);
  assert.deepStrictEqual(shownSize({ width: 400, height: 300, orientation: 6 }), { width: 300, height: 400 });
  assert.ok(isImagePath('C:\\a\\photo.JPG') && isImagePath('x.jpeg') && isImagePath('y.png'));
  assert.ok(!isImagePath('scan.heic') && !isImagePath('a.pdf') && !isImagePath(null));
});

test('pictures: every orientation puts the top of the photo at the top of the page', () => {
  const { imageMatrix } = require('../lib/images');
  const box = [10, 20, 300, 400];
  const apply = ([a, b, c, d, e, f], u, v) => [a * u + c * v + e, b * u + d * v + f];
  // Where the stored picture's top-left corner (u 0, v 1) has to end up on the page.
  const topLeftGoesTo = {
    1: [10, 420], // stays top left
    2: [310, 420], // mirrored: top right
    3: [310, 20], // upside down: bottom right
    4: [10, 20], // flipped: bottom left
    5: [10, 420], // turned and mirrored: top left
    6: [310, 420], // turned a quarter clockwise: top right
    7: [310, 20],
    8: [10, 20], // turned a quarter the other way: bottom left
  };
  for (let orientation = 1; orientation <= 8; orientation++) {
    const m = imageMatrix(orientation, box);
    assert.deepStrictEqual(apply(m, 0, 1).map(Math.round), topLeftGoesTo[orientation], `orientation ${orientation}`);
    // The whole picture covers exactly the box.
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => apply(m, u, v));
    assert.deepStrictEqual([Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[0]))], [10, 310]);
    assert.deepStrictEqual([Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[1]))], [20, 420]);
  }
});

test('pictures: A4 turns to suit the picture; "fit" makes a page of its own shape', () => {
  const { pageLayout } = require('../lib/images');
  const wide = pageLayout({ width: 4000, height: 3000 }, 'A4');
  assert.deepStrictEqual(wide.size, [841.89, 595.28]);
  assert.ok(Math.abs(wide.box[3] - 595.28) < 0.01 && wide.box[1] === 0, 'a wide photo fills the height of a sideways sheet');
  const tall = pageLayout({ width: 1000, height: 3000 }, 'A4');
  assert.deepStrictEqual(tall.size, [595.28, 841.89]);
  assert.ok(Math.abs(tall.box[0] - (595.28 - tall.box[2]) / 2) < 0.01, 'and is centred');
  const fit = pageLayout({ width: 1000, height: 500 }, 'fit');
  assert.deepStrictEqual(fit.size.map((n) => Math.round(n)), [842, 421]);
  assert.deepStrictEqual(pageLayout({ width: 10, height: 10 }, 'odd').size, [595.28, 841.89]);
});

test('pictures and PDFs merge into one file, a page per picture, turned the right way', async () => {
  const { mergeFiles } = require('../lib/pages');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-images-'));
  try {
    const photo = path.join(folder, 'photo.jpg');
    const shot = path.join(folder, 'shot.png');
    fs.writeFileSync(photo, jpeg(400, 300, 6));
    fs.writeFileSync(shot, png(6, 2));
    const target = path.join(folder, 'out.pdf');
    const result = await mergeFiles([{ image: photo }, fixture('mixed.pdf'), { image: shot }], target, { imagePaper: 'A4' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.strictEqual(result.pages, 6);
    const doc = await PDFDocument.load(fs.readFileSync(target));
    const sizes = doc.getPages().map((page) => page.getSize()).map(({ width, height }) => [Math.round(width), Math.round(height)]);
    // The photo is stored wide but shown tall, so its page is upright; the screenshot is wide.
    assert.deepStrictEqual(sizes[0], [595, 842]);
    assert.deepStrictEqual(sizes[5], [842, 595]);
    // The picture itself has to be in the file: a page that only names it comes out blank.
    for (const index of [0, 5]) {
      const drawn = doc.getPage(index).node.Resources().lookup(PDFName.of('XObject'), PDFDict);
      const pictures = drawn.keys().map((key) => drawn.lookup(key)).filter((object) => object instanceof PDFStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
      assert.strictEqual(pictures.length, 1, `page ${index + 1} holds its picture`);
    }
    const bad = path.join(folder, 'bad.jpg');
    fs.writeFileSync(bad, 'not a picture');
    const failed = await mergeFiles([{ image: bad }], path.join(folder, 'x.pdf'));
    assert.deepStrictEqual([failed.ok, failed.reason, failed.file], [false, 'BAD_IMAGE', 'bad.jpg']);
    const gone = await mergeFiles([{ image: path.join(folder, 'gone.jpg') }], path.join(folder, 'y.pdf'));
    assert.strictEqual(gone.reason, 'CANNOT_READ');
    assert.strictEqual((await mergeFiles([{ image: 7 }], path.join(folder, 'z.pdf'))).reason, 'BAD_REQUEST');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// ---- Updating from GitHub, only when asked ----------------------------------

test('a version is newer number by number, not letter by letter', () => {
  const { isNewer } = require('../lib/updater');
  assert.ok(isNewer('1.10.0', '1.9.3'));
  assert.ok(isNewer('2.0.0', '1.99.99'));
  assert.ok(isNewer('1.4.1', '1.4.0'));
  assert.ok(!isNewer('1.4.0', '1.4.0'));
  assert.ok(!isNewer('1.3.9', '1.4.0'));
  assert.ok(!isNewer(undefined, '1.4.0'));
});

test('updating: check, download and install are separate steps, and nothing starts by itself', async () => {
  const { EventEmitter } = require('events');
  const { createUpdater } = require('../lib/updater');
  const calls = [];
  const fake = Object.assign(new EventEmitter(), {
    version: '1.4.0',
    fails: false,
    async checkForUpdates() {
      calls.push('check');
      if (this.fails) throw new Error('offline');
      return { updateInfo: { version: this.version } };
    },
    async downloadUpdate() {
      calls.push('download');
      this.emit('download-progress', { percent: 41.6 });
      if (this.fails) throw new Error('offline');
    },
    quitAndInstall(...args) {
      calls.push(`install ${args.join()}`);
    },
  });
  let loads = 0;
  let unsaved = false;
  const progress = [];
  const updater = createUpdater({
    load: () => {
      loads++;
      return fake;
    },
    isPackaged: true,
    currentVersion: '1.4.0',
    canQuit: () => !unsaved,
    onProgress: (percent) => progress.push(percent),
  });
  assert.strictEqual(loads, 0, 'the update library is not even loaded until asked');
  assert.deepStrictEqual(await updater.download(), { ok: false, reason: 'NOTHING' });
  assert.deepStrictEqual(updater.install(), { ok: false, reason: 'NOT_READY' });
  assert.deepStrictEqual(await updater.check(), { status: 'LATEST', current: '1.4.0' });
  assert.ok(fake.autoDownload === false && fake.autoInstallOnAppQuit === false);
  fake.fails = true;
  assert.strictEqual((await updater.check()).status, 'FAILED');
  fake.fails = false;
  fake.version = '1.5.0';
  assert.deepStrictEqual(await updater.check(), { status: 'AVAILABLE', current: '1.4.0', version: '1.5.0', downloaded: false });
  assert.deepStrictEqual(updater.install(), { ok: false, reason: 'NOT_READY' });
  fake.fails = true;
  assert.deepStrictEqual(await updater.download(), { ok: false, reason: 'FAILED' });
  fake.fails = false;
  assert.deepStrictEqual(await updater.download(), { ok: true, version: '1.5.0' });
  assert.deepStrictEqual(progress, [42, 42]);
  assert.strictEqual((await updater.check()).downloaded, true);
  unsaved = true;
  assert.deepStrictEqual(updater.install(), { ok: false, reason: 'UNSAVED' });
  unsaved = false;
  assert.deepStrictEqual(updater.install(), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(calls.at(-1), 'install true,true', 'installs without more questions and starts the program again');
  assert.strictEqual(loads, 1);

  const copy = createUpdater({ load: () => { throw new Error('must not load'); }, isPackaged: false, currentVersion: '1.4.0', canQuit: () => true, onProgress: () => {} });
  assert.deepStrictEqual(await copy.check(), { status: 'NOT_INSTALLED', current: '1.4.0' });
});
