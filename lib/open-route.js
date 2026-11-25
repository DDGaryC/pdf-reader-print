const path = require('path');

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const holds = (state, filePath) => [...state.tabPaths, ...state.pendingPaths].some((held) => samePath(held, filePath));
const isEmpty = (state) => state.tabPaths.length === 0 && state.pendingPaths.length === 0;

// Which window a file being opened belongs in; null means a new one. Each state lists the
// files showing in that window and those still on their way to it.
//   mode: 'window' gives each file its own window, 'tab' adds it to a window already open.
//   asking: the window whose Open button was used, if any.
function chooseWindow(states, filePath, { mode, asking = null, lastActive = null }) {
  const holding = states.find((state) => holds(state, filePath));
  if (holding) return holding;
  if (mode === 'tab') return asking ?? lastActive ?? states[0] ?? null;
  if (asking && isEmpty(asking)) return asking;
  return states.find(isEmpty) ?? null;
}

module.exports = { chooseWindow };
