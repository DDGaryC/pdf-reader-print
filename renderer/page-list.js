// The list of pages behind the organize mode. Nothing here touches the screen or a file:
// each change gives a new list, so undo only has to go back to an earlier one.
// A page is { key, source, index, turn }: where it comes from, and how far it is turned.

export function pagesOf(source, count, nextKey) {
  return Array.from({ length: count }, (_v, index) => ({ key: nextKey(), source, index, turn: 0 }));
}

// target is the place in the list the pages go in front of; the list's length means the end.
// Unchanged order gives back the same list, so nothing counts as an edit.
export function movePages(pages, keys, target) {
  const moving = pages.filter((page) => keys.has(page.key));
  const staying = pages.filter((page) => !keys.has(page.key));
  if (moving.length === 0 || staying.length === 0) return pages;
  const at = pages.slice(0, target).filter((page) => !keys.has(page.key)).length;
  const next = [...staying.slice(0, at), ...moving, ...staying.slice(at)];
  return next.every((page, i) => page === pages[i]) ? pages : next;
}

export function removePages(pages, keys) {
  const next = pages.filter((page) => !keys.has(page.key));
  return next.length === pages.length ? pages : next;
}

export function turnPages(pages, keys, degrees) {
  if (keys.size === 0) return pages;
  return pages.map((page) => (keys.has(page.key)
    ? { ...page, turn: (page.turn + degrees + 360) % 360 }
    : page));
}

export function insertPages(pages, added, at) {
  if (added.length === 0) return pages;
  return [...pages.slice(0, at), ...added, ...pages.slice(at)];
}

// The place right after the last of these pages; with none, the end of the list.
export function placeAfter(pages, keys) {
  for (let i = pages.length - 1; i >= 0; i--) {
    if (keys.has(pages[i].key)) return i + 1;
  }
  return pages.length;
}

// Every page from one to the other, whichever comes first.
export function keysBetween(pages, oneKey, otherKey) {
  const one = pages.findIndex((page) => page.key === oneKey);
  const other = pages.findIndex((page) => page.key === otherKey);
  if (one < 0 || other < 0) return other < 0 ? [] : [otherKey];
  return pages.slice(Math.min(one, other), Math.max(one, other) + 1).map((page) => page.key);
}

// Where a page let go at (x, y) lands. boxes are the pages' { left, top, width, height },
// in list order, row by row.
export function dropTarget(boxes, x, y) {
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (y < box.top) return i;
    if (y <= box.top + box.height && x < box.left + box.width / 2) return i;
  }
  return boxes.length;
}

function sameLayout(a, b) {
  return a.length === b.length && a.every((page, i) => page.key === b[i].key && page.turn === b[i].turn);
}

export class PageHistory {
  #past = [];
  #future = [];
  #saved;

  constructor(pages) {
    this.pages = pages;
    this.#saved = pages;
  }

  get canUndo() {
    return this.#past.length > 0;
  }

  get canRedo() {
    return this.#future.length > 0;
  }

  // Compares what is in the list, so turning a page all the way round is no change.
  get dirty() {
    return !sameLayout(this.pages, this.#saved);
  }

  apply(next) {
    if (next === this.pages) return false;
    this.#past.push(this.pages);
    this.#future = [];
    this.pages = next;
    return true;
  }

  undo() {
    if (!this.canUndo) return false;
    this.#future.push(this.pages);
    this.pages = this.#past.pop();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.#past.push(this.pages);
    this.pages = this.#future.pop();
    return true;
  }

  markSaved() {
    this.#saved = this.pages;
  }
}
