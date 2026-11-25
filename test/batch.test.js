const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../renderer/batch-run.js');

const file = (name, extra = {}) => ({ name, path: `C:\\docs\\${name}.pdf`, state: 'ready', pages: 2, landscape: 1, problem: null, ...extra });

// Hands out print results by file name and records what was started, in order.
function fakePrinter(results = {}) {
  const started = [];
  return {
    started,
    print: async (item) => {
      started.push(item.name);
      return results[item.name] ?? { ok: true };
    },
  };
}

const run = async (runBatch, items, printer, options = {}) => runBatch(items, {
  print: printer.print,
  shouldStop: () => false,
  stopOnCancel: false,
  onStart: () => {},
  ...options,
});

test('files go out in list order, the next only after the previous has finished', async () => {
  const { runBatch } = await load();
  const events = [];
  const items = [file('a'), file('b'), file('c')];
  await runBatch(items, {
    print: async (item) => {
      events.push(`start ${item.name}`);
      await new Promise((resolve) => setTimeout(resolve, item.name === 'a' ? 20 : 1));
      events.push(`end ${item.name}`);
      return { ok: true };
    },
    shouldStop: () => false,
    stopOnCancel: false,
    onStart: () => {},
  });
  assert.deepStrictEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('progress counts only the files that will print', async () => {
  const { runBatch } = await load();
  const seen = [];
  const items = [file('a'), file('bad', { problem: '檔案損毀' }), file('b')];
  await run(runBatch, items, fakePrinter(), {
    onStart: (item, position, total) => seen.push([item.name, position, total]),
  });
  assert.deepStrictEqual(seen, [['a', 1, 2], ['b', 2, 2]]);
});

test('a file with a problem is never sent, and the rest carry on', async () => {
  const { runBatch } = await load();
  const printer = fakePrinter();
  const bad = file('bad', { problem: '有開啟密碼' });
  const items = [file('a'), bad, file('b')];
  const { outcomes, stopped } = await run(runBatch, items, printer);
  assert.deepStrictEqual(printer.started, ['a', 'b']);
  assert.strictEqual(outcomes.get(bad).status, 'skipped');
  assert.strictEqual(stopped, null);
});

test('a failed print does not end the batch', async () => {
  const { runBatch } = await load();
  const printer = fakePrinter({ b: { ok: false, reason: 'PRINT_FAILED' } });
  const items = [file('a'), file('b'), file('c')];
  const { outcomes, stopped } = await run(runBatch, items, printer);
  assert.deepStrictEqual(printer.started, ['a', 'b', 'c']);
  assert.deepStrictEqual(items.map((item) => outcomes.get(item).status), ['sent', 'failed', 'sent']);
  assert.strictEqual(stopped, null);
});

test('a failure keeps its reason, so a file that cannot be laid out can say so', async () => {
  const { runBatch } = await load();
  const printer = fakePrinter({ a: { ok: false, reason: 'CANNOT_ARRANGE' } });
  const items = [file('a'), file('b')];
  const { outcomes } = await run(runBatch, items, printer);
  assert.deepStrictEqual(outcomes.get(items[0]), { status: 'failed', reason: 'CANNOT_ARRANGE' });
  assert.strictEqual(outcomes.get(items[1]).status, 'sent');
});

test('an error while sending counts as a failure and the batch carries on', async () => {
  const { runBatch } = await load();
  const items = [file('a'), file('b')];
  const started = [];
  const { outcomes } = await runBatch(items, {
    print: async (item) => {
      started.push(item.name);
      if (item.name === 'a') throw new Error('lost contact');
      return { ok: true };
    },
    shouldStop: () => false,
    stopOnCancel: false,
    onStart: () => {},
  });
  assert.deepStrictEqual(started, ['a', 'b']);
  assert.deepStrictEqual(items.map((item) => outcomes.get(item).status), ['failed', 'sent']);
});

test('stopping lets the current file finish and sends no more', async () => {
  const { runBatch } = await load();
  let stop = false;
  const printer = fakePrinter();
  const items = [file('a'), file('b'), file('c')];
  const { outcomes, stopped } = await run(runBatch, items, printer, {
    shouldStop: () => stop,
    onStart: () => { stop = true; },
  });
  assert.deepStrictEqual(printer.started, ['a']);
  assert.deepStrictEqual(items.map((item) => outcomes.get(item).status), ['sent', 'waiting', 'waiting']);
  assert.strictEqual(stopped, 'user');
});

test('cancelling a Save As window stops the batch instead of opening the next one', async () => {
  const { runBatch } = await load();
  const printer = fakePrinter({ b: { ok: false, reason: 'PRINT_FAILED' } });
  const items = [file('a'), file('b'), file('c')];
  const { outcomes, stopped } = await run(runBatch, items, printer, { stopOnCancel: true });
  assert.deepStrictEqual(printer.started, ['a', 'b']);
  assert.deepStrictEqual(items.map((item) => outcomes.get(item).status), ['sent', 'canceled', 'waiting']);
  assert.strictEqual(stopped, 'canceled');
});

test('other errors on a Save As printer are not taken for a cancel', async () => {
  const { runBatch } = await load();
  const printer = fakePrinter({ a: { ok: false, reason: 'NOT_OPEN' } });
  const items = [file('a'), file('b')];
  const { outcomes, stopped } = await run(runBatch, items, printer, { stopOnCancel: true });
  assert.strictEqual(outcomes.get(items[0]).status, 'failed');
  assert.strictEqual(stopped, null);
  assert.deepStrictEqual(printer.started, ['a', 'b']);
});

test('moving a file in the list', async () => {
  const { moveItem } = await import('../renderer/list-order.js');
  const [a, b, c] = [file('a'), file('b'), file('c')];
  const names = (items) => items.map((item) => item.name).join('');
  assert.strictEqual(names(moveItem([a, b, c], c, a)), 'cab');
  assert.strictEqual(names(moveItem([a, b, c], a, c)), 'bac');
  assert.strictEqual(names(moveItem([a, b, c], a, null)), 'bca');
  assert.strictEqual(names(moveItem([a, b, c], b, b)), 'abc');
  assert.strictEqual(names(moveItem([a, b, c], a, b)), 'abc');
});

test('files already on the list are not added twice, whatever the case', async () => {
  const { newPaths } = await import('../renderer/list-order.js');
  const items = [{ path: 'C:\\docs\\a.pdf' }];
  assert.deepStrictEqual(
    newPaths(items, ['C:\\DOCS\\A.PDF', 'C:\\docs\\b.pdf', 'c:\\docs\\B.pdf']),
    ['C:\\docs\\b.pdf'],
  );
});

test('the messages after a batch', async () => {
  const { batchMessage } = await load();
  const outcomes = (...statuses) => new Map(statuses.map((status, i) => [i, typeof status === 'string' ? { status } : status]));
  assert.strictEqual(
    batchMessage({ outcomes: outcomes('sent', 'sent'), stopped: null }),
    '已送出 2 個檔案到印表機。',
  );
  assert.strictEqual(
    batchMessage({ outcomes: outcomes('sent', 'failed', 'skipped'), stopped: null }),
    '已送出 1 個檔案，2 個沒有印出，原因列在清單上。',
  );
  assert.ok(batchMessage({ outcomes: outcomes('sent', 'waiting', 'waiting'), stopped: 'user' }).includes('還有 2 個沒有印'));
  assert.ok(batchMessage({ outcomes: outcomes('failed', 'skipped', 'waiting'), stopped: 'user' }).includes('還有 2 個沒有印'));
  assert.ok(batchMessage({ outcomes: outcomes('sent', 'canceled', 'waiting'), stopped: 'canceled' }).includes('還有 2 個沒有印'));
  assert.ok(batchMessage({ outcomes: outcomes({ status: 'sent', fellBack: true }, 'sent'), stopped: null }).includes('其中 1 個無法改成順時針'));
});

test('the summary above the list', async () => {
  const { batchSummary } = await load();
  assert.strictEqual(batchSummary([]), '還沒有加入檔案');
  assert.ok(batchSummary([file('a'), file('b', { state: 'checking' })]).includes('還剩 1 個'));
  assert.strictEqual(batchSummary([file('a'), file('b')]), '共 2 個檔案、4 頁，其中 2 頁橫向已自動轉向');
  assert.strictEqual(batchSummary([file('a', { landscape: 0 })]), '共 1 個檔案、2 頁，沒有橫向頁');
  assert.strictEqual(
    batchSummary([file('a'), file('bad', { problem: '損毀', pages: null, landscape: null })]),
    '共 1 個檔案、2 頁，其中 1 頁橫向已自動轉向；另有 1 個不能印',
  );
  assert.strictEqual(batchSummary([file('bad', { problem: '損毀' })]), '1 個檔案都不能印');
});

test('the summary counts paper when files are laid out several pages to a sheet', async () => {
  const { batchSummary } = await load();
  const two = [file('a'), file('b')];
  assert.strictEqual(
    batchSummary(two, { perSheet: 2, merged: 2, sheets: 2, twoSided: false, perCopy: false }),
    '共 2 個檔案、4 頁，2 個多頁檔案每張紙印 2 頁，要用 2 張紙',
  );
  assert.strictEqual(
    batchSummary(two, { perSheet: 4, merged: 1, sheets: 3, twoSided: true, perCopy: true }),
    '共 2 個檔案、4 頁，1 個多頁檔案每張紙印 4 頁，雙面印，每份要用 3 張紙',
  );
  assert.strictEqual(
    batchSummary([file('a', { pages: 1 })], { perSheet: 2, merged: 0, sheets: 1, twoSided: false, perCopy: false }),
    '共 1 個檔案、1 頁，都只有 1 頁，不用合併，要用 1 張紙',
  );
  assert.strictEqual(
    batchSummary([file('a'), file('bad', { problem: '損毀' })], { perSheet: 2, merged: 1, sheets: 1, twoSided: false, perCopy: false }),
    '共 1 個檔案、2 頁，1 個多頁檔案每張紙印 2 頁，要用 1 張紙；另有 1 個不能印',
  );
});
