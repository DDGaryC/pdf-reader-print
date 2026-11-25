const test = require('node:test');
const assert = require('node:assert');
const { chooseWindow } = require('../lib/open-route');

const windowWith = (...tabPaths) => ({ tabPaths, pendingPaths: [] });

test('with one window for each file, a new file gets a new window', () => {
  const states = [windowWith('C:\\a.pdf'), windowWith('C:\\b.pdf')];
  assert.strictEqual(chooseWindow(states, 'C:\\c.pdf', { mode: 'window' }), null);
  assert.strictEqual(chooseWindow(states, 'C:\\c.pdf', { mode: 'window', asking: states[0], lastActive: states[1] }), null);
});

test('a file already open goes to the window showing it, in either mode', () => {
  const states = [windowWith('C:\\a.pdf'), windowWith('C:\\b.pdf', 'C:\\c.pdf')];
  for (const mode of ['window', 'tab']) {
    assert.strictEqual(chooseWindow(states, 'C:\\c.pdf', { mode, asking: states[0] }), states[1]);
    assert.strictEqual(chooseWindow(states, 'c:\\C.PDF', { mode }), states[1], 'whatever the case');
  }
});

test('a file on its way to a window counts as being there', () => {
  const waiting = { tabPaths: [], pendingPaths: ['C:\\a.pdf'] };
  const states = [waiting];
  assert.strictEqual(chooseWindow(states, 'C:\\a.pdf', { mode: 'window' }), waiting);
  assert.strictEqual(chooseWindow(states, 'C:\\b.pdf', { mode: 'window' }), null, 'and that window is not empty');
});

test('an empty window is used before making another', () => {
  const full = windowWith('C:\\a.pdf');
  const empty = windowWith();
  const alsoEmpty = windowWith();
  assert.strictEqual(chooseWindow([full, empty], 'C:\\b.pdf', { mode: 'window' }), empty);
  assert.strictEqual(chooseWindow([full, empty, alsoEmpty], 'C:\\b.pdf', { mode: 'window', asking: alsoEmpty }), alsoEmpty, 'the one asking first');
  assert.strictEqual(chooseWindow([full, empty], 'C:\\b.pdf', { mode: 'window', asking: full }), empty);
});

test('with tabs chosen, a new file joins the window asking, or the one last used', () => {
  const first = windowWith('C:\\a.pdf');
  const second = windowWith('C:\\b.pdf');
  const states = [first, second];
  assert.strictEqual(chooseWindow(states, 'C:\\c.pdf', { mode: 'tab', asking: second, lastActive: first }), second);
  assert.strictEqual(chooseWindow(states, 'C:\\c.pdf', { mode: 'tab', lastActive: second }), second);
  assert.strictEqual(chooseWindow(states, 'C:\\c.pdf', { mode: 'tab' }), first);
  assert.strictEqual(chooseWindow([], 'C:\\c.pdf', { mode: 'tab' }), null, 'with no window at all');
});
