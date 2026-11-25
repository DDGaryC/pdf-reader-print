// Input methods such as 華碩智慧輸入法 show a small 中／英 box when a window becomes active. With
// no text box holding the caret they do not know where it goes, so it sticks at the top left of
// the window. So the caret waits in an invisible text box in a corner while the window is not
// active: the box then flashes there and goes away by itself, and the caret goes back.
const WAKE_AFTER_MS = 2000;

const holdsText = (element) => element instanceof HTMLTextAreaElement
  || (element instanceof HTMLInputElement && !['checkbox', 'radio', 'range'].includes(element.type));

// fallback(): where the caret goes if it has nowhere to go back to.
export function wireImeAnchor(anchor, fallback) {
  let returnTo = null;
  let wakeTimer = null;

  function rest() {
    const focused = document.activeElement;
    if (focused === anchor) return;
    // Someone typing keeps their place. Focusing the box would also lose text selected on a page.
    if (holdsText(focused) || document.querySelector('dialog[open]')) return;
    if (!window.getSelection().isCollapsed) return;
    returnTo = focused === document.body ? null : focused;
    anchor.focus({ preventScroll: true });
  }

  function wake() {
    clearTimeout(wakeTimer);
    if (document.activeElement !== anchor) return;
    const target = returnTo?.isConnected ? returnTo : fallback();
    returnTo = null;
    if (target) target.focus({ preventScroll: true });
    else anchor.blur();
  }

  window.addEventListener('blur', () => {
    clearTimeout(wakeTimer);
    rest();
  });
  window.addEventListener('focus', () => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(wake, WAKE_AFTER_MS);
  });
  // Using the keyboard or the mouse means the wait is over.
  window.addEventListener('keydown', wake, true);
  window.addEventListener('pointerdown', () => clearTimeout(wakeTimer), true);
  // Nothing typed in the moment before it goes back is kept.
  anchor.addEventListener('input', () => {
    anchor.value = '';
  });
  rest();

  return {
    isAnchor: (element) => element === anchor,
    // For files that finish opening while the window is in the background or not shown yet.
    restIfInactive: () => {
      if (!document.hasFocus()) rest();
    },
  };
}
