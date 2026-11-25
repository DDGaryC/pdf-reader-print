// The width of the thumbnail column: dragging its edge, and remembering the choice.

const STORAGE_KEY = 'sidebarWidth';
const DEFAULT_WIDTH = 172;
const MIN_WIDTH = 120;
const MAX_WIDTH = 560;
// The pages always keep at least this much of the window.
const ROOM_FOR_PAGES = 320;

let resizing = false;

export const isResizingSidebar = () => resizing;

export function clampWidth(width, windowWidth) {
  const most = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, windowWidth - ROOM_FOR_PAGES));
  return Math.round(Math.min(most, Math.max(MIN_WIDTH, width)));
}

function apply(width) {
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
}

// onResized() is called once the width has settled.
export function wireSidebarWidth({ sidebar, handle, onResized }) {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (saved > 0) apply(clampWidth(saved, Infinity));

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebar.offsetWidth;
    const move = (moved) => apply(clampWidth(startWidth + moved.clientX - startX, window.innerWidth));
    resizing = true;
    document.body.classList.add('resizing-sidebar');
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', () => {
      handle.removeEventListener('pointermove', move);
      resizing = false;
      document.body.classList.remove('resizing-sidebar');
      localStorage.setItem(STORAGE_KEY, String(sidebar.offsetWidth));
      onResized();
    }, { once: true });
  });

  handle.addEventListener('dblclick', () => {
    apply(DEFAULT_WIDTH);
    localStorage.removeItem(STORAGE_KEY);
    onResized();
  });
}
