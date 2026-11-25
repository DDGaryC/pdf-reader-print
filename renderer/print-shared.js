// What the print dialog and the batch print dialog have in common.

import { describePages, sideName } from './n-up.js';

const $ = (id) => document.getElementById(id);

export const PAPER_POINTS = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
};
// Matches what Sumatra does: counter-clockwise is its own built-in turn.
const TURN_DEGREES = { counterclockwise: 270, clockwise: 90 };
const NEVER_PAINTED = new Set(['Link', 'Popup']);
// Caps one preview page at 64 MB, like the reader. Very high zoom gets a little softer.
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const CSS_PER_POINT = 96 / 72;
const ZOOM_CHOICES = [
  ['auto', '自動'],
  ['page-fit', '整頁'],
  ['page-width', '符合寬度'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
  ['4', '400%'],
];
const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const MIN_SHEET_WIDTH = 100;
const REDRAW_DELAY_MS = 150;

// Page directions and unprintable annotations of a document.
export function scanPages(doc) {
  const scan = { landscape: [], hiddenAnnotations: [], done: null };
  scan.done = (async () => {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      scan.landscape[n] = width > height;
      const shown = (await page.getAnnotations({ intent: 'display' })).filter((a) => !NEVER_PAINTED.has(a.subtype));
      if (shown.length === 0) {
        scan.hiddenAnnotations[n] = 0;
      } else {
        const printed = new Set((await page.getAnnotations({ intent: 'print' })).map((a) => a.id));
        scan.hiddenAnnotations[n] = shown.filter((a) => !printed.has(a.id)).length;
      }
    }
  })();
  return scan;
}

// The form fields have the same ids in both dialogs, apart from their prefix.
export function readPrintSettings(prefix) {
  return {
    printer: $(`${prefix}-printer`).value || null,
    direction: document.querySelector(`input[name="${prefix}-direction"]:checked`).value,
    scale: $(`${prefix}-scale`).value,
    paper: $(`${prefix}-paper`).value,
    grayscale: $(`${prefix}-grayscale`).checked,
    duplex: $(`${prefix}-duplex`).value,
  };
}

export function applyPrintSettings(prefix, settings) {
  $(`${prefix}-printer`).value = settings.printer ?? '';
  document.querySelector(`input[name="${prefix}-direction"][value="${settings.direction}"]`).checked = true;
  $(`${prefix}-scale`).value = settings.scale;
  $(`${prefix}-paper`).value = settings.paper;
  $(`${prefix}-grayscale`).checked = settings.grayscale;
  $(`${prefix}-duplex`).value = settings.duplex;
}

export function fillPrinters(select, printers) {
  select.replaceChildren(...printers.map((printer) => {
    const option = document.createElement('option');
    option.value = printer.name;
    option.textContent = printer.isDefault ? `${printer.displayName}（預設）` : printer.displayName;
    return option;
  }));
}

// Sheets read sideways turn over differently from upright ones. The paper goes through the
// printer upright, so the long edge of a sideways sheet is its top: turned over sideways,
// like a book page, the back comes out upside down.
export function sidewaysDuplexHint(duplex) {
  return duplex === 'duplexlong'
    ? '這次紙要橫著看。長邊翻頁時，背面要往上翻（像翻月曆）才是正的；想左右翻（像翻書），請改選「雙面短邊翻頁」。'
    : '這次紙要橫著看。短邊翻頁時，左右翻（像翻書）背面就是正的。';
}

export function validCopies(input) {
  const copies = Number(input.value);
  return Number.isInteger(copies) && copies >= 1 && copies <= 999 ? copies : null;
}

// Each page on a sheet of paper, the way it will print. Only sheets near the visible
// part are drawn, so a long document does not pile up hundreds of page images.
export class SheetPreview {
  #box;
  #readSettings;
  #zoomSelect;
  // 'auto', 'page-fit', 'page-width', or a number where 1 is the paper's real size.
  #zoom = 'auto';
  #redrawTimer = null;
  #doc = null;
  #generation = 0;
  #renderTask = null;
  #observer = null;
  #visible = new Set();
  #drawn = new Set();
  #items = [];
  #pumping = false;
  // Several pages per sheet, from planSheets in n-up.js; null for one page per sheet.
  #plan = null;
  #framed = false;
  #twoSided = false;

  constructor(box, readSettings, prefix) {
    this.#box = box;
    this.#readSettings = readSettings;
    this.#zoomSelect = $(`${prefix}-zoom`);
    this.#wireZoom(prefix);
    this.#wirePan();
    this.resetZoom();
  }

  resetZoom() {
    this.#zoom = 'auto';
    this.#showZoom();
    this.#box.classList.remove('zoomed');
  }

  clear() {
    this.#generation++;
    clearTimeout(this.#redrawTimer);
    this.#renderTask?.cancel();
    this.#renderTask = null;
    this.#observer?.disconnect();
    for (const item of this.#items) this.#release(item);
    this.#visible.clear();
    this.#drawn.clear();
    this.#items = [];
    this.#doc = null;
    this.#plan = null;
    this.#box.replaceChildren();
  }

  // Paper size in points, the way the sheets are shown.
  #sheetSize() {
    return this.#plan ? [this.#plan.width, this.#plan.height] : PAPER_POINTS[this.#readSettings().paper];
  }

  show(doc, pages) {
    this.clear();
    this.#doc = doc;
    this.#build(pages.map((pageNumber) => ({ page: pageNumber, label: `第 ${pageNumber} 頁` })));
  }

  // plan comes from planSheets in n-up.js.
  showSheets(doc, plan, { border = false, twoSided = false } = {}) {
    this.clear();
    this.#doc = doc;
    this.#plan = plan;
    this.#framed = border;
    this.#twoSided = twoSided;
    this.#build(plan.sheets.map(({ slots }, index) => ({ page: slots[0].page, label: this.#sheetLabel(index) })));
  }

  // Printed on both sides, sheets are named front and back; the pages are not drawn again.
  setTwoSided(twoSided) {
    this.#twoSided = twoSided;
    if (!this.#plan) return;
    this.#items.forEach((item, index) => {
      item.querySelector('.sheet-label').textContent = this.#sheetLabel(index);
    });
  }

  #sheetLabel(index) {
    return `${sideName(index, this.#twoSided)}：${describePages(this.#plan.sheets[index].slots.map((slot) => slot.page))}`;
  }

  // Frames go on and off without drawing the pages again.
  setBorder(border) {
    this.#framed = border;
    for (const sheet of this.#box.querySelectorAll('.sheet')) sheet.classList.toggle('framed', border && Boolean(this.#plan));
  }

  #build(entries) {
    const [paperWidth, paperHeight] = this.#sheetSize();
    const fragment = document.createDocumentFragment();
    this.#items = entries.map(({ page, label: labelText }, index) => {
      const item = document.createElement('div');
      item.className = 'sheet-item';
      item.dataset.index = index;
      item.dataset.page = page;
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.classList.toggle('framed', this.#framed && Boolean(this.#plan));
      sheet.style.aspectRatio = `${paperWidth} / ${paperHeight}`;
      const label = document.createElement('span');
      label.className = 'sheet-label';
      label.textContent = labelText;
      item.append(sheet, label);
      fragment.append(item);
      return item;
    });
    this.#box.append(fragment);
    this.#applyZoom();

    const generation = this.#generation;
    this.#observer = new IntersectionObserver((entries) => {
      if (this.#generation !== generation) return;
      for (const entry of entries) {
        const index = Number(entry.target.dataset.index);
        if (entry.isIntersecting) {
          this.#visible.add(index);
        } else {
          // Sheets scrolled far away are redrawn when they come back.
          this.#visible.delete(index);
          this.#drawn.delete(index);
          this.#release(entry.target);
        }
      }
      this.#pump();
    }, { root: this.#box, rootMargin: '400px 0px' });
    for (const item of this.#items) this.#observer.observe(item);
  }

  // ---- Zoom -----------------------------------------------------------------

  #wireZoom(prefix) {
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.hidden = true;
    this.#zoomSelect.append(custom, ...ZOOM_CHOICES.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    this.#zoomSelect.addEventListener('change', () => {
      const number = Number(this.#zoomSelect.value);
      this.#zoomTo(Number.isNaN(number) ? this.#zoomSelect.value : number);
    });
    $(`${prefix}-zoom-in`).addEventListener('click', () => this.#stepZoom(ZOOM_STEP));
    $(`${prefix}-zoom-out`).addEventListener('click', () => this.#stepZoom(1 / ZOOM_STEP));
    this.#box.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.#stepZoom(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, [event.clientX, event.clientY]);
    }, { passive: false });
    this.#box.closest('dialog').addEventListener('keydown', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key === '=' || event.key === '+') this.#stepZoom(ZOOM_STEP);
      else if (event.key === '-') this.#stepZoom(1 / ZOOM_STEP);
      else if (event.key === '0') this.#zoomTo('auto');
      else return;
      event.preventDefault();
    });
    new ResizeObserver(() => {
      if (this.#items.length === 0) return;
      this.#applyZoom();
      this.#redrawSoon();
    }).observe(this.#box);
  }

  #showZoom() {
    const select = this.#zoomSelect;
    const value = String(this.#zoom);
    if ([...select.options].some((option) => option.value === value && !option.hidden)) {
      select.value = value;
      return;
    }
    select.options[0].textContent = `${Math.round(this.#zoom * 100)}%`;
    select.value = select.options[0].value;
  }

  #stepZoom(factor, origin) {
    const first = this.#items[0];
    if (!first) return;
    const [paperWidth] = this.#sheetSize();
    const current = typeof this.#zoom === 'number'
      ? this.#zoom
      : first.querySelector('.sheet').clientWidth / (paperWidth * CSS_PER_POINT);
    const next = Math.round(current * factor * 100) / 100;
    this.#zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)), origin);
  }

  #zoomTo(zoom, origin) {
    this.#zoom = zoom;
    this.#showZoom();
    if (this.#items.length === 0) return;
    const anchor = this.#anchorAt(origin);
    this.#applyZoom();
    // The spot being looked at stays where it is on screen.
    const rect = anchor.sheet.getBoundingClientRect();
    this.#box.scrollLeft += rect.left + anchor.shareX * rect.width - anchor.x;
    this.#box.scrollTop += rect.top + anchor.shareY * rect.height - anchor.y;
    this.#redrawSoon();
  }

  // The wheel keeps what is under the pointer; buttons and keys keep the top page.
  #anchorAt(origin) {
    const box = this.#box.getBoundingClientRect();
    const [x, y] = origin ?? [box.left + box.width / 2, box.top];
    const item = this.#items.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom >= y && (!origin || rect.right >= x);
    }) ?? this.#items.at(-1);
    const sheet = item.querySelector('.sheet');
    const rect = sheet.getBoundingClientRect();
    const shareX = origin ? (x - rect.left) / rect.width : 0.5;
    return { sheet, x, y, shareX, shareY: (y - rect.top) / rect.height };
  }

  #applyZoom() {
    // A single page has nothing to sit next to, so automatic shows it as large as fits.
    const zoom = this.#zoom === 'auto' && this.#items.length === 1 ? 'page-fit' : this.#zoom;
    this.#box.classList.toggle('zoomed', zoom !== 'auto');
    if (zoom !== 'auto') this.#box.style.setProperty('--sheet-width', `${this.#sheetWidth(zoom)}px`);
    const box = this.#box;
    box.classList.toggle('pannable', box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight);
  }

  // Dragging the page moves it, the same as using the scrollbars.
  #wirePan() {
    const box = this.#box;
    box.addEventListener('pointerdown', (event) => {
      const rect = box.getBoundingClientRect();
      const onScrollbar = event.clientX - rect.left >= box.clientWidth || event.clientY - rect.top >= box.clientHeight;
      if (event.button !== 0 || onScrollbar || !box.classList.contains('pannable')) return;
      const start = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
      const move = (moved) => {
        box.scrollLeft = start.left - (moved.clientX - start.x);
        box.scrollTop = start.top - (moved.clientY - start.y);
      };
      box.setPointerCapture(event.pointerId);
      box.classList.add('panning');
      box.addEventListener('pointermove', move);
      box.addEventListener('lostpointercapture', () => {
        box.classList.remove('panning');
        box.removeEventListener('pointermove', move);
      }, { once: true });
    });
  }

  #sheetWidth(zoom) {
    const [paperWidth, paperHeight] = this.#sheetSize();
    if (typeof zoom === 'number') return zoom * paperWidth * CSS_PER_POINT;
    const style = getComputedStyle(this.#box);
    const width = this.#box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (zoom === 'page-width') return Math.max(width, MIN_SHEET_WIDTH);
    const first = this.#items[0];
    const labelSpace = first.offsetHeight - first.querySelector('.sheet').offsetHeight;
    const height = this.#box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - labelSpace;
    return Math.max(Math.min(width, height * paperWidth / paperHeight), MIN_SHEET_WIDTH);
  }

  #redrawSoon() {
    clearTimeout(this.#redrawTimer);
    this.#redrawTimer = setTimeout(() => this.#redraw(), REDRAW_DELAY_MS);
  }

  // The old pictures stay up, stretched, until the sharp ones are ready.
  #redraw() {
    let outdated = false;
    for (const index of [...this.#drawn]) {
      const item = this.#items[index];
      if (Number(item.dataset.drawnWidth) === item.querySelector('.sheet').clientWidth) continue;
      this.#drawn.delete(index);
      delete item.dataset.drawn;
      outdated = true;
    }
    if (!outdated) return;
    this.#renderTask?.cancel();
    this.#pump();
  }

  // ---- Drawing --------------------------------------------------------------

  // A canvas holds its memory until garbage collection unless it is emptied first.
  #release(item) {
    for (const canvas of item.querySelectorAll('canvas')) {
      canvas.width = 0;
      canvas.height = 0;
    }
    item.querySelector('.sheet').replaceChildren();
    delete item.dataset.drawn;
    delete item.dataset.drawnWidth;
  }

  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const index = [...this.#visible].find((i) => !this.#drawn.has(i));
        if (index === undefined) break;
        this.#drawn.add(index);
        await this.#draw(index);
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #draw(index) {
    if (this.#plan) {
      await this.#drawSheet(index);
      return;
    }
    const generation = this.#generation;
    const doc = this.#doc;
    const item = this.#items[index];
    const pageNumber = Number(item.dataset.page);
    const stale = () => this.#generation !== generation;
    let canvas = null;
    try {
      const page = await doc.getPage(pageNumber);
      if (stale()) return;
      const upright = page.getViewport({ scale: 1 });
      const isLandscape = upright.width > upright.height;
      const settings = this.#readSettings();
      const rotation = (page.rotate + (isLandscape ? TURN_DEGREES[settings.direction] : 0)) % 360;
      const size = page.getViewport({ scale: 1, rotation });

      const sheet = item.querySelector('.sheet');
      const sheetWidth = sheet.clientWidth;
      const [paperWidth, paperHeight] = PAPER_POINTS[settings.paper];
      const fit = Math.min(paperWidth / size.width, paperHeight / size.height);
      const scale = { fit, shrink: Math.min(1, fit), noscale: 1 }[settings.scale];
      const cssPerPoint = sheetWidth / paperWidth;
      const shownPixels = (size.width * scale * cssPerPoint) * (size.height * scale * cssPerPoint);
      const pixelRatio = Math.min(window.devicePixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / shownPixels));
      const viewport = page.getViewport({ scale: scale * cssPerPoint * pixelRatio, rotation });

      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // A share of the sheet, so the picture follows the sheet's size until it is redrawn.
      canvas.style.width = `${(size.width * scale / paperWidth) * 100}%`;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      // The print intent leaves out annotations that will not print, like the printout.
      this.#renderTask = page.render({ canvasContext: context, viewport, intent: 'print' });
      await this.#renderTask.promise;
      page.cleanup();
      // It may have scrolled away while it was being drawn.
      if (stale() || !this.#drawn.has(index)) return;

      // "Actual size" starts at the sheet's top-left corner, the others are centred.
      sheet.classList.toggle('actual-size', settings.scale === 'noscale');
      sheet.querySelector('canvas')?.setAttribute('width', 0);
      sheet.replaceChildren(canvas);
      canvas = null;
      if (isLandscape) {
        const badge = document.createElement('span');
        badge.className = 'sheet-badge';
        badge.textContent = '已轉向';
        sheet.append(badge);
      }
      item.dataset.drawnWidth = sheetWidth;
      item.dataset.drawn = 'true';
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !stale()) console.warn(`preview of page ${pageNumber} failed:`, err);
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  // One sheet with several pages, each drawn into its place from the plan.
  async #drawSheet(index) {
    const generation = this.#generation;
    const doc = this.#doc;
    const plan = this.#plan;
    const item = this.#items[index];
    const { slots } = plan.sheets[index];
    const stale = () => this.#generation !== generation;
    const canvases = [];
    try {
      const sheet = item.querySelector('.sheet');
      const sheetWidth = sheet.clientWidth;
      const cssPerPoint = sheetWidth / plan.width;
      for (const slot of slots) {
        const page = await doc.getPage(slot.page);
        if (stale()) return;
        const shownPixels = (slot.rect.width * cssPerPoint) * (slot.rect.height * cssPerPoint);
        const pixelRatio = Math.min(window.devicePixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / slots.length / shownPixels));
        const viewport = page.getViewport({ scale: slot.scale * cssPerPoint * pixelRatio, rotation: slot.rotation });
        const canvas = document.createElement('canvas');
        canvases.push(canvas);
        canvas.className = 'sheet-slot';
        canvas.dataset.page = slot.page;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        // Shares of the sheet, so the pictures follow the sheet's size until they are redrawn.
        Object.assign(canvas.style, {
          left: `${(slot.rect.x / plan.width) * 100}%`,
          top: `${(slot.rect.y / plan.height) * 100}%`,
          width: `${(slot.rect.width / plan.width) * 100}%`,
          height: `${(slot.rect.height / plan.height) * 100}%`,
        });
        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        this.#renderTask = page.render({ canvasContext: context, viewport, intent: 'print' });
        await this.#renderTask.promise;
        page.cleanup();
        if (stale() || !this.#drawn.has(index)) return;
      }
      for (const old of sheet.querySelectorAll('canvas')) old.width = 0;
      sheet.replaceChildren(...canvases);
      canvases.length = 0;
      item.dataset.drawnWidth = sheetWidth;
      item.dataset.drawn = 'true';
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !stale()) console.warn(`preview of sheet ${index + 1} failed:`, err);
    } finally {
      for (const canvas of canvases) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }
}
