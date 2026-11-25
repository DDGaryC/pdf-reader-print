import { dropTarget, keysBetween } from './page-list.js';

const DRAG_STARTS_AFTER = 5;
const SCROLL_EDGE = 48;
const SCROLL_STEP = 16;
const SCROLL_EVERY_MS = 30;
const REDRAW_DELAY_MS = 200;
// Pages this far outside the visible part are kept drawn; further away they are let go.
const KEEP_DRAWN_WITHIN = '600px 0px';
// The shape a page is shown in until it has been read.
const UNREAD_SHAPE = [0.707, 1];
// A scanned page holds over 100 MB of decoded images, so these do not get to pile up.
const RELEASE_MEMORY_EVERY = 3;
// One notch of a mouse wheel; a touchpad sends many small amounts that add up to this.
const WHEEL_NOTCH = 60;

// The pages as a grid of pictures: drawing them, choosing them, dragging them.
// It shows whatever list it is given and only reports what the user wants changed.
//   docOf(source), describe(page), isLocked(), onSelect(), onMove(target), releaseMemory(),
//   onWheelSize(direction, event)
export class PageGrid {
  selected = new Set();
  #pane;
  #content;
  #line;
  #options;
  #cells = new Map();
  #order = [];
  #anchor = null;
  #size;
  #visible = new Set();
  #pumping = false;
  #renderTask = null;
  #redrawTimer = null;
  #destroyed = false;
  #observer;
  #drag = null;
  #wheelTotal = 0;

  constructor(pane, { size, ...options }) {
    this.#pane = pane;
    this.#options = options;
    this.#size = size;
    pane.style.setProperty('--organize-size', `${size}px`);
    this.#content = document.createElement('div');
    this.#content.className = 'organize-pages';
    this.#line = document.createElement('div');
    this.#line.className = 'organize-drop-line';
    this.#line.hidden = true;
    pane.append(this.#content);
    this.#observer = new IntersectionObserver((entries) => this.#onIntersect(entries), {
      root: pane,
      rootMargin: KEEP_DRAWN_WITHIN,
    });
    pane.addEventListener('pointerdown', (event) => this.#pointerDown(event));
    pane.addEventListener('wheel', (event) => this.#onWheel(event), { passive: false });
  }

  get size() {
    return this.#size;
  }

  show(pages) {
    const alive = new Set(pages.map((page) => page.key));
    for (const [key, cell] of this.#cells) {
      if (!alive.has(key)) this.#dropCell(key, cell);
    }
    this.#order = pages;
    const elements = pages.map((page, position) => {
      const cell = this.#cells.get(page.key) ?? this.#addCell(page);
      cell.page = page;
      cell.number.textContent = position + 1;
      cell.element.setAttribute('aria-label', `第 ${position + 1} 頁`);
      cell.element.title = this.#options.describe(page);
      cell.canvas.style.transform = page.turn ? `rotate(${page.turn}deg)` : '';
      return cell.element;
    });
    this.#content.replaceChildren(...elements, this.#line);
    this.selected = new Set([...this.selected].filter((key) => alive.has(key)));
    this.#showSelection();
    this.#pump();
  }

  // Forgets every page, for when the list is about to be a different one.
  reset() {
    this.cancelDrag();
    this.#renderTask?.cancel();
    for (const [key, cell] of this.#cells) this.#dropCell(key, cell);
    this.#anchor = null;
    this.selected = new Set();
    this.#order = [];
  }

  // The page under the pointer stays where it is; without a pointer, the top page does.
  setSize(size, event) {
    const anchor = this.#anchorAt(event);
    this.#size = size;
    this.#pane.style.setProperty('--organize-size', `${size}px`);
    if (anchor) {
      const box = anchor.element.getBoundingClientRect();
      this.#pane.scrollTop += box.top + anchor.share * box.height - anchor.y;
    }
    clearTimeout(this.#redrawTimer);
    this.#redrawTimer = setTimeout(() => this.#pump(), REDRAW_DELAY_MS);
  }

  #anchorAt(event) {
    const top = this.#pane.getBoundingClientRect().top;
    const element = event?.target.closest?.('.organize-cell')
      ?? [...this.#cells.values()].map((cell) => cell.element).find((candidate) => candidate.getBoundingClientRect().bottom > top);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const y = event && event.target.closest?.('.organize-cell') ? event.clientY : box.top;
    return { element, y, share: (y - box.top) / box.height };
  }

  #onWheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const sameWay = Math.sign(event.deltaY) === Math.sign(this.#wheelTotal);
    this.#wheelTotal = sameWay ? this.#wheelTotal + event.deltaY : event.deltaY;
    if (Math.abs(this.#wheelTotal) < WHEEL_NOTCH) return;
    const direction = this.#wheelTotal < 0 ? 1 : -1;
    this.#wheelTotal = 0;
    this.#options.onWheelSize(direction, event);
  }

  select(keys) {
    this.selected = new Set(keys);
    this.#anchor = keys[0] ?? null;
    this.#showSelection();
  }

  scrollTo(key) {
    this.#cells.get(key)?.element.scrollIntoView({ block: 'nearest' });
  }

  destroy() {
    this.#destroyed = true;
    this.cancelDrag();
    clearTimeout(this.#redrawTimer);
    this.#observer.disconnect();
    this.#renderTask?.cancel();
    for (const [key, cell] of this.#cells) this.#dropCell(key, cell);
    this.#pane.remove();
  }

  // ---- The cells --------------------------------------------------------------

  #addCell(page) {
    const element = document.createElement('div');
    element.className = 'organize-cell';
    element.dataset.key = page.key;
    element.setAttribute('role', 'option');
    const frame = document.createElement('div');
    frame.className = 'organize-frame';
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    canvas.height = 0;
    this.#shape(canvas, ...UNREAD_SHAPE);
    frame.append(canvas);
    const number = document.createElement('span');
    number.className = 'organize-number';
    element.append(frame, number);
    const cell = { page, element, frame, canvas, number, drawnSize: 0 };
    this.#cells.set(page.key, cell);
    this.#observer.observe(element);
    return cell;
  }

  #dropCell(key, cell) {
    this.#observer.unobserve(cell.element);
    this.#visible.delete(key);
    this.#release(cell);
    cell.element.remove();
    this.#cells.delete(key);
  }

  // A share of the current size, whichever way the page is turned, so it fits the frame.
  #shape(canvas, wide, tall) {
    canvas.style.width = `calc(var(--organize-size) * ${wide})`;
    canvas.style.height = `calc(var(--organize-size) * ${tall})`;
  }

  // ---- Drawing: only pages near the visible part, one at a time -------------------

  #onIntersect(entries) {
    for (const entry of entries) {
      const key = Number(entry.target.dataset.key);
      const cell = this.#cells.get(key);
      if (!cell) continue;
      if (entry.isIntersecting) {
        this.#visible.add(key);
      } else {
        this.#visible.delete(key);
        this.#release(cell);
      }
    }
    this.#pump();
  }

  // A canvas holds its memory until garbage collection unless it is emptied first.
  #release(cell) {
    cell.canvas.width = 0;
    cell.canvas.height = 0;
    cell.drawnSize = 0;
    delete cell.element.dataset.drawn;
  }

  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    let sinceRelease = 0;
    try {
      while (!this.#destroyed) {
        const key = [...this.#visible].find((candidate) => this.#needsDrawing(this.#cells.get(candidate)));
        if (key === undefined) break;
        await this.#draw(this.#cells.get(key));
        sinceRelease++;
        if (sinceRelease === RELEASE_MEMORY_EVERY) {
          sinceRelease = 0;
          await this.#options.releaseMemory();
        }
      }
      if (sinceRelease > 0 && !this.#destroyed) await this.#options.releaseMemory();
    } finally {
      this.#pumping = false;
    }
  }

  // A bigger picture shrinks well enough, and drawing a scanned page takes seconds. Only
  // one much too big is drawn again, because of the memory it holds.
  #needsDrawing(cell) {
    return Boolean(cell) && (cell.drawnSize < this.#size || cell.drawnSize > this.#size * 2);
  }

  #wanted(cell) {
    return !this.#destroyed && this.#cells.get(cell.page.key) === cell && this.#visible.has(cell.page.key);
  }

  // The old picture stays up, stretched, until the new one is ready.
  async #draw(cell) {
    const size = this.#size;
    cell.drawnSize = size;
    const { source, index } = cell.page;
    let canvas = null;
    try {
      const page = await this.#options.docOf(source).getPage(index + 1);
      if (!this.#wanted(cell)) return;
      const whole = page.getViewport({ scale: 1 });
      const longest = Math.max(whole.width, whole.height);
      const viewport = page.getViewport({ scale: (size * window.devicePixelRatio) / longest });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      // A canvas without alpha starts black; keep it white until the page is drawn.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.#renderTask = page.render({ canvasContext: context, viewport });
      await this.#renderTask.promise;
      page.cleanup();
      if (!this.#wanted(cell)) return;
      this.#shape(canvas, whole.width / longest, whole.height / longest);
      canvas.style.transform = cell.page.turn ? `rotate(${cell.page.turn}deg)` : '';
      cell.canvas.width = 0;
      cell.canvas.height = 0;
      cell.frame.replaceChildren(canvas);
      cell.canvas = canvas;
      canvas = null;
      cell.element.dataset.drawn = 'true';
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !this.#destroyed) {
        console.warn(`organize picture of page ${index + 1} failed:`, err);
      }
    } finally {
      this.#renderTask = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  // ---- Choosing pages -----------------------------------------------------------

  #showSelection() {
    for (const [key, cell] of this.#cells) {
      const chosen = this.selected.has(key);
      cell.element.classList.toggle('selected', chosen);
      cell.element.setAttribute('aria-selected', String(chosen));
    }
    this.#options.onSelect();
  }

  selectAll() {
    this.selected = new Set(this.#order.map((page) => page.key));
    this.#showSelection();
  }

  clearSelection() {
    this.selected = new Set();
    this.#anchor = null;
    this.#showSelection();
  }

  #selectOnly(key) {
    this.selected = new Set([key]);
    this.#anchor = key;
    this.#showSelection();
  }

  #pointerDown(event) {
    if (event.button !== 0 || this.#drag || this.#options.isLocked()) return;
    const pane = this.#pane;
    if (event.clientX - pane.getBoundingClientRect().left >= pane.clientWidth) return; // the scrollbar
    const element = event.target.closest('.organize-cell');
    const adding = event.ctrlKey || event.metaKey;
    if (!element) {
      if (!adding && !event.shiftKey) this.clearSelection();
      return;
    }
    const key = Number(element.dataset.key);
    let narrowTo = null;
    if (event.shiftKey) {
      this.selected = new Set(keysBetween(this.#order, this.#anchor ?? key, key));
      this.#anchor ??= key;
      this.#showSelection();
    } else if (adding) {
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.#anchor = key;
      this.#showSelection();
    } else if (this.selected.has(key)) {
      // It may be the start of dragging all of them; only a plain click narrows it down.
      narrowTo = key;
    } else {
      this.#selectOnly(key);
    }
    if (this.selected.has(key)) this.#armDrag(event, narrowTo);
  }

  // ---- Dragging pages -----------------------------------------------------------

  #armDrag(event, narrowTo) {
    const pane = this.#pane;
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      narrowTo,
      active: false,
      target: null,
      boxes: null,
      gap: 0,
      ghost: null,
      timer: null,
      stop: null,
    };
    const move = (moved) => {
      drag.x = moved.clientX;
      drag.y = moved.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= DRAG_STARTS_AFTER) this.#startDrag(drag);
      if (drag.active) this.#followPointer(drag);
    };
    const up = () => this.#finishDrag(drag);
    const cancel = () => this.cancelDrag();
    pane.setPointerCapture(event.pointerId);
    pane.addEventListener('pointermove', move);
    pane.addEventListener('pointerup', up);
    pane.addEventListener('pointercancel', cancel);
    pane.addEventListener('lostpointercapture', cancel);
    drag.stop = () => {
      pane.removeEventListener('pointermove', move);
      pane.removeEventListener('pointerup', up);
      pane.removeEventListener('pointercancel', cancel);
      pane.removeEventListener('lostpointercapture', cancel);
    };
    this.#drag = drag;
  }

  #startDrag(drag) {
    drag.active = true;
    drag.boxes = this.#order.map((page) => {
      const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = this.#cells.get(page.key).element;
      return { left, top, width, height };
    });
    drag.gap = parseFloat(getComputedStyle(this.#content).columnGap) || 0;
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'organize-ghost';
    drag.ghost.textContent = `${this.selected.size} 頁`;
    document.body.append(drag.ghost);
    this.#pane.classList.add('dragging-pages');
    for (const key of this.selected) this.#cells.get(key)?.element.classList.add('dragged');
    drag.timer = setInterval(() => {
      const box = this.#pane.getBoundingClientRect();
      const step = drag.y < box.top + SCROLL_EDGE ? -SCROLL_STEP : drag.y > box.bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
      if (step === 0) return;
      this.#pane.scrollTop += step;
      this.#followPointer(drag);
    }, SCROLL_EVERY_MS);
  }

  // The boxes count from the top of the content, so scrolling does not change them.
  #followPointer(drag) {
    const content = this.#content.getBoundingClientRect();
    const y = drag.y - content.top;
    drag.target = dropTarget(drag.boxes, drag.x - content.left, y);
    drag.ghost.style.left = `${drag.x}px`;
    drag.ghost.style.top = `${drag.y}px`;

    const before = drag.boxes[drag.target];
    const after = drag.boxes[drag.target - 1];
    // Past the end of a row the line stays on that row, next to the pointer.
    const onEarlierRow = after && (!before || (before.top > after.top && y <= after.top + after.height));
    const box = onEarlierRow ? after : before;
    this.#line.hidden = !box;
    if (!box) return;
    const left = onEarlierRow ? box.left + box.width + drag.gap / 2 : box.left - drag.gap / 2;
    this.#line.style.left = `${left}px`;
    this.#line.style.top = `${box.top}px`;
    this.#line.style.height = `${box.height}px`;
  }

  #endDrag(drag) {
    drag.stop();
    clearInterval(drag.timer);
    drag.ghost?.remove();
    this.#line.hidden = true;
    this.#pane.classList.remove('dragging-pages');
    for (const cell of this.#cells.values()) cell.element.classList.remove('dragged');
    this.#drag = null;
  }

  #finishDrag(drag) {
    this.#endDrag(drag);
    if (drag.active) {
      if (drag.target !== null) this.#options.onMove(drag.target);
    } else if (drag.narrowTo !== null) {
      this.#selectOnly(drag.narrowTo);
    }
  }

  // True if there was a drag to stop.
  cancelDrag() {
    if (!this.#drag) return false;
    const { active } = this.#drag;
    this.#endDrag(this.#drag);
    return active;
  }
}
