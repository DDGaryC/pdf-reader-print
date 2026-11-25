// The bookmarks ("目錄") a PDF may carry, shown as a tree in the left column. Clicking
// an entry goes to its place in the file; entries with sections under them fold.

export class OutlinePane {
  #pane;
  #doc;
  #onGo;
  #built = null;

  // onGo(item): goes to the entry's place.
  constructor(pane, doc, { onGo }) {
    this.#pane = pane;
    this.#doc = doc;
    this.#onGo = onGo;
  }

  // Built the first time it is shown. Resolves with the number of top-level entries.
  build() {
    this.#built ??= this.#doc.getOutline().then((outline) => {
      const items = Array.isArray(outline) ? outline : [];
      if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'outline-empty';
        empty.textContent = '這份檔案沒有目錄（書籤）。';
        this.#pane.replaceChildren(empty);
      } else {
        this.#pane.replaceChildren(this.#list(items, 0));
      }
      return items.length;
    }, (err) => {
      console.warn('reading the bookmarks failed:', err);
      const empty = document.createElement('p');
      empty.className = 'outline-empty';
      empty.textContent = '讀不到這份檔案的目錄。';
      this.#pane.replaceChildren(empty);
      return 0;
    });
    return this.#built;
  }

  #list(items, depth) {
    const list = document.createElement('ul');
    list.className = 'outline-list';
    list.setAttribute('role', depth === 0 ? 'tree' : 'group');
    for (const item of items) list.append(this.#entry(item, depth));
    return list;
  }

  #entry(item, depth) {
    const entry = document.createElement('li');
    entry.className = 'outline-entry';
    entry.setAttribute('role', 'treeitem');
    const row = document.createElement('div');
    row.className = 'outline-row';
    row.style.setProperty('--depth', String(depth));

    const children = Array.isArray(item.items) ? item.items : [];
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'outline-fold';
    fold.tabIndex = -1;
    if (children.length === 0) fold.classList.add('leaf');

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'outline-go';
    go.textContent = (item.title ?? '').trim() || '（沒有標題）';
    go.title = go.textContent;
    if (item.bold) go.classList.add('bold');
    if (item.italic) go.classList.add('italic');
    go.addEventListener('click', () => {
      this.#pane.querySelector('.outline-go.current')?.classList.remove('current');
      go.classList.add('current');
      this.#onGo(item);
    });
    row.append(fold, go);
    entry.append(row);

    if (children.length > 0) {
      const sub = this.#list(children, depth + 1);
      const setOpen = (open) => {
        sub.hidden = !open;
        fold.setAttribute('aria-expanded', String(open));
        fold.setAttribute('aria-label', open ? '收合' : '展開');
        entry.setAttribute('aria-expanded', String(open));
      };
      // Folded unless the file says this entry starts open.
      setOpen(item.count > 0);
      fold.addEventListener('click', () => setOpen(sub.hidden));
      entry.append(sub);
    }
    return entry;
  }

  destroy() {
    this.#pane.replaceChildren();
  }
}
