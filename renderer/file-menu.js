// The "檔案" menu at the top left. It sits outside the toolbar, which would cut it off.
// actions: what each menu item's id does; actions.recent(path) opens a recent file.
// onOpen(): called just before it shows, to bring the list of recent files up to date.
export function wireFileMenu({ button, menu, actions, onOpen = () => {} }) {
  const isOpen = () => !menu.hidden;
  // Items in a hidden part of the menu cannot take the keyboard.
  const items = () => [...menu.querySelectorAll('.menu-item:not(:disabled)')].filter((item) => item.getClientRects().length > 0);

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function open() {
    onOpen();
    const box = button.getBoundingClientRect();
    menu.style.left = `${box.left}px`;
    menu.style.top = `${box.bottom + 4}px`;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  }

  button.addEventListener('click', () => {
    if (isOpen()) close();
    else open();
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('.menu-item');
    if (!item || item.disabled) return;
    close();
    if (item.dataset.path) actions.recent?.(item.dataset.path);
    else actions[item.id]?.();
  });
  menu.addEventListener('keydown', (event) => {
    // Nothing typed here reaches the page behind the menu.
    event.stopPropagation();
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      close();
      button.focus();
    } else if (event.key === 'ArrowDown') {
      list[(at + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      list[(at - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      list[0]?.focus();
    } else if (event.key === 'End') {
      list.at(-1)?.focus();
    } else {
      return;
    }
    event.preventDefault();
  });
  // Clicking anywhere else, or leaving the window, closes it.
  document.addEventListener('pointerdown', (event) => {
    if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) close();
  }, true);
  window.addEventListener('blur', close);
}
