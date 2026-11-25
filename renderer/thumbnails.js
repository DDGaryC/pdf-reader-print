// What the pictures of one document may hold at most. A wide column makes each picture
// bigger, and a scanned page takes seconds to draw again, so they are kept until this is full.
const PICTURE_BUDGET_BYTES = 128 * 1024 * 1024;
const FIT_DELAY_MS = 200;

// The oldest pictures out of view go first, until what is kept fits the budget.
// kept: Map of page number to { bytes }, oldest first.
export function picturesToLetGo(kept, visible, budget) {
  let total = 0;
  for (const { bytes } of kept.values()) total += bytes;
  const going = [];
  for (const [page, { bytes }] of kept) {
    if (total <= budget) break;
    if (visible.has(page)) continue;
    going.push(page);
    total -= bytes;
  }
  return going;
}

// Page thumbnails for one document. Only pages scrolled into view are drawn,
// one at a time, so a document with hundreds of pages stays responsive.
export class ThumbnailStrip {
  #pane;
  #doc;
  #onPick;
  #pixelRatio;
  #rotation = 0;
  #items = [];
  #visible = new Set();
  // Page number to { width, bytes }: the width it was last drawn for, oldest first.
  #drawn = new Map();
  // The width pictures are drawn for. Changes only when asked to fit, not during a drag.
  #width = 0;
  #fitTimer = null;
  #current = null;
  #renderTask = null;
  #busy = false;
  #destroyed = false;
  #observer;

  constructor(pane, doc, { firstPageRatio, pixelRatio, onPick }) {
    this.#pane = pane;
    this.#doc = doc;
    this.#onPick = onPick;
    this.#pixelRatio = pixelRatio;
    this.#observer = new IntersectionObserver((entries) => this.#onIntersect(entries), {
      root: pane,
      rootMargin: '300px 0px',
    });

    const fragment = document.createDocumentFragment();
    for (let n = 1; n <= doc.numPages; n++) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'thumb';
      item.dataset.page = n;
      item.setAttribute('aria-label', `第 ${n} 頁`);
      const canvas = document.createElement('canvas');
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.aspectRatio = `1 / ${firstPageRatio}`;
      const label = document.createElement('span');
      label.textContent = n;
      item.append(canvas, label);
      item.addEventListener('click', () => this.#onPick(n));
      this.#items.push(item);
      fragment.append(item);
    }
    pane.append(fragment);
    for (const item of this.#items) this.#observer.observe(item);
  }

  setCurrent(pageNumber) {
    this.#current?.classList.remove('current');
    this.#current = this.#items[pageNumber - 1] ?? null;
    if (!this.#current) return;
    this.#current.classList.add('current');
    this.#current.scrollIntoView({ block: 'nearest' });
  }

  setRotation(degrees) {
    this.#rotation = degrees;
    this.#drawn.clear();
    for (const item of this.#items) delete item.dataset.drawn;
    this.#pump();
  }

  // The column may have changed width. The pictures already follow it, stretched;
  // this draws them sharp again once it has settled.
  fit() {
    clearTimeout(this.#fitTimer);
    this.#fitTimer = setTimeout(() => {
      const width = this.#measure();
      if (this.#destroyed || width === 0 || width === this.#width) return;
      this.#width = width;
      this.#pump();
    }, FIT_DELAY_MS);
  }

  destroy() {
    this.#destroyed = true;
    clearTimeout(this.#fitTimer);
    this.#observer.disconnect();
    this.#renderTask?.cancel();
    for (const item of this.#items) {
      const canvas = item.querySelector('canvas');
      canvas.width = 0;
      canvas.height = 0;
    }
    this.#items = [];
    this.#pane.replaceChildren();
  }

  #measure() {
    return this.#items[0]?.querySelector('canvas').clientWidth ?? 0;
  }

  #onIntersect(entries) {
    for (const entry of entries) {
      const n = Number(entry.target.dataset.page);
      if (entry.isIntersecting) this.#visible.add(n);
      else this.#visible.delete(n);
    }
    this.#pump();
  }

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (!this.#destroyed) {
        this.#width ||= this.#measure();
        if (this.#width === 0) break;
        const width = this.#width;
        const next = [...this.#visible].find((n) => this.#drawn.get(n)?.width !== width);
        if (next === undefined) break;
        // Listed last again, as the newest.
        this.#drawn.delete(next);
        this.#drawn.set(next, { width, bytes: 0 });
        await this.#draw(next, width);
        for (const n of picturesToLetGo(this.#drawn, this.#visible, PICTURE_BUDGET_BYTES)) this.#letGo(n);
      }
    } finally {
      this.#busy = false;
    }
  }

  // A canvas holds its memory until garbage collection unless it is emptied first.
  #letGo(n) {
    const item = this.#items[n - 1];
    const canvas = item.querySelector('canvas');
    canvas.width = 0;
    canvas.height = 0;
    delete item.dataset.drawn;
    this.#drawn.delete(n);
  }

  // The old picture stays up, stretched, until the new one is ready.
  async #draw(n, width) {
    const item = this.#items[n - 1];
    let canvas = null;
    try {
      const page = await this.#doc.getPage(n);
      if (this.#destroyed) return;
      const rotation = (page.rotate + this.#rotation) % 360;
      const unscaled = page.getViewport({ scale: 1, rotation });
      const pixels = width * Math.max(this.#pixelRatio(), 1);
      const viewport = page.getViewport({ scale: pixels / unscaled.width, rotation });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${unscaled.width} / ${unscaled.height}`;
      const context = canvas.getContext('2d', { alpha: false });
      // A canvas without alpha starts black; keep it white until the page is drawn.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.#renderTask = page.render({ canvasContext: context, viewport });
      await this.#renderTask.promise;
      page.cleanup();
      // Turned again while this was being drawn: this picture is already out of date.
      const entry = this.#drawn.get(n);
      if (this.#destroyed || !entry) return;
      entry.bytes = canvas.width * canvas.height * 4;
      const old = item.querySelector('canvas');
      old.width = 0;
      old.height = 0;
      old.replaceWith(canvas);
      canvas = null;
      item.dataset.drawn = 'true';
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !this.#destroyed) {
        console.warn(`thumbnail ${n} failed:`, err);
      }
    } finally {
      this.#renderTask = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }
}
