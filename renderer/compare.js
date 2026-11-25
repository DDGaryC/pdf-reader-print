import { boxesOf, compareDocuments, gapAt, hasLittleText, readText, splitAtEdges } from './compare-text.js';
import { LOAD_ERRORS, PAGE_DRAWN, REGISTER_ERRORS, askPasswordFor, createPageViewer, openDocumentTask } from './doc-view.js';

const $ = (id) => document.getElementById(id);
const FIT_SCALES = new Set(['auto', 'page-actual', 'page-fit', 'page-width']);
const SIDE_NAMES = { left: '左邊', right: '右邊' };

let shown = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const nameOf = (filePath) => filePath.split(/[\\/]/).pop();
const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();

// One side of the comparison: a file, its pages, and the marks on them.
class ComparePane {
  // What is shown: { doc, file, owned, task, text }. owned means this side opened the file
  // and closes it again; otherwise it belongs to the tab.
  content = null;
  // Page number -> [{ rect, kind, index }], in the file's own units.
  marks = new Map();
  // Where each difference is on this side: index -> { page, rect }.
  anchors = [];
  lastTop = 0;
  lastLeft = 0;
  #session;

  constructor(parent, side, session) {
    this.side = side;
    this.#session = session;
    this.column = element('section', `compare-side ${side}`);
    this.column.setAttribute('aria-label', `${SIDE_NAMES[side]}的檔案`);
    const head = element('div', 'compare-head');
    this.label = element('span', 'compare-label', side === 'left' ? '左' : '右');
    this.name = element('span', 'compare-name');
    this.pages = element('span', 'compare-pages');
    head.append(this.label, this.name, this.pages);
    if (side === 'right') {
      this.change = element('button', 'compare-change', '更換檔案');
      this.change.type = 'button';
      this.change.title = '換一份 PDF 來比對，也可以把檔案拖到這一邊';
      this.change.hidden = true;
      this.change.addEventListener('click', () => session.chooseRight());
      head.append(this.change);
    }
    this.body = element('div', 'compare-body');
    this.host = element('div', 'compare-host');
    this.host.tabIndex = 0;
    this.body.append(this.host);
    this.column.append(head, this.body);
    parent.append(this.column);

    const { viewer, eventBus, linkService } = createPageViewer(this.host);
    this.viewer = viewer;
    this.linkService = linkService;
    eventBus.on('pagesinit', () => {
      viewer.currentScaleValue = session.scaleValue;
      this.showPages();
    });
    eventBus.on('pagerendered', ({ source }) => {
      this.drawMarks(source);
      source.pdfPage?.cleanup();
    });
    eventBus.on('pagechanging', () => this.showPages());
    eventBus.on('scalechanging', () => session.changed());
    viewer.renderingQueue.onIdle = () => this.releaseMemory();

    this.host.addEventListener('scroll', () => session.paneScrolled(this));
    // Whoever the user is moving leads; the other side follows.
    for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
      this.host.addEventListener(type, () => session.lead(this), { capture: true, passive: true });
    }
    this.host.addEventListener('wheel', (event) => {
      if (!event.ctrlKey || !this.content) return;
      event.preventDefault();
      session.zoomStep(event.deltaY < 0 ? 1 : -1, this, [event.clientX, event.clientY]);
    }, { passive: false });
  }

  get ready() {
    return this.content !== null && this.viewer.pagesCount > 0;
  }

  get pageNumber() {
    return this.viewer.currentPageNumber;
  }

  show(content) {
    this.#dropPages();
    this.content = content;
    this.marks = new Map();
    this.anchors = [];
    this.viewer.setDocument(content?.doc ?? null);
    this.linkService.setDocument(content?.doc ?? null);
    this.host.scrollTop = 0;
    this.host.scrollLeft = 0;
    this.lastTop = 0;
    this.lastLeft = 0;
    this.name.textContent = content?.file.name ?? '';
    this.name.title = content?.file.path ?? '';
    if (this.change) this.change.hidden = !content;
    this.showPages();
  }

  showPages() {
    this.pages.textContent = this.ready ? `第 ${this.pageNumber} / ${this.viewer.pagesCount} 頁` : '';
    this.#session.changed();
  }

  // Lets go of the file, closing it if this side opened it.
  release() {
    const { content } = this;
    this.show(null);
    if (content?.owned) {
      content.task.destroy().catch(() => {});
      window.api.closePdf(content.file.id);
    }
  }

  setMarks(marks, anchors) {
    this.marks = marks;
    this.anchors = anchors;
    for (let i = 0; i < this.viewer.pagesCount; i++) {
      const pageView = this.viewer.getPageView(i);
      if (pageView?.renderingState === PAGE_DRAWN) this.drawMarks(pageView);
    }
  }

  // Marks sit in a layer of their own on the page, placed in percent so they keep their
  // place while the page is being zoomed.
  drawMarks(pageView) {
    pageView.div.querySelector(':scope > .compare-marks')?.remove();
    const list = this.marks.get(pageView.id);
    if (!list?.length) return;
    const { viewport } = pageView;
    const layer = element('div', 'compare-marks');
    for (const { rect, kind, index } of list) {
      const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(rect);
      const mark = element('div', `compare-mark ${kind}`);
      if (index === this.#session.current) mark.classList.add('current');
      mark.dataset.index = index;
      mark.style.left = `${(Math.min(x0, x1) / viewport.width) * 100}%`;
      mark.style.top = `${(Math.min(y0, y1) / viewport.height) * 100}%`;
      mark.style.width = `${(Math.abs(x1 - x0) / viewport.width) * 100}%`;
      mark.style.height = `${(Math.abs(y1 - y0) / viewport.height) * 100}%`;
      layer.append(mark);
    }
    pageView.div.append(layer);
  }

  markCurrent(index) {
    for (const mark of this.host.querySelectorAll('.compare-mark.current')) mark.classList.remove('current');
    for (const mark of this.host.querySelectorAll(`.compare-mark[data-index="${index}"]`)) mark.classList.add('current');
  }

  // Scrolls so that the place sits a third of the way down, and in view sideways.
  reveal(anchor) {
    const pageView = anchor && this.viewer.getPageView(anchor.page - 1);
    if (!pageView) return;
    const [x0, y0, x1, y1] = pageView.viewport.convertToViewportRectangle(anchor.rect);
    const { host } = this;
    const pageBox = pageView.div.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    const pageTop = pageBox.top - hostBox.top + host.scrollTop + pageView.div.clientTop;
    const pageLeft = pageBox.left - hostBox.left + host.scrollLeft + pageView.div.clientLeft;
    host.scrollTop = pageTop + Math.min(y0, y1) - host.clientHeight / 3;
    const left = pageLeft + Math.min(x0, x1);
    const right = pageLeft + Math.max(x0, x1);
    if (left < host.scrollLeft || right > host.scrollLeft + host.clientWidth) host.scrollLeft = left - host.clientWidth / 4;
  }

  goToPage(pageNumber) {
    if (!this.ready) return;
    this.viewer.currentPageNumber = Math.min(Math.max(1, pageNumber), this.viewer.pagesCount);
  }

  refit() {
    if (!this.ready) return;
    const value = this.viewer.currentScaleValue;
    if (FIT_SCALES.has(value)) this.viewer.currentScaleValue = value;
    this.viewer.update();
  }

  releaseMemory() {
    if (!this.ready) return;
    this.viewer.cleanup();
    this.content.doc.cleanup().catch(() => {
      // Something is still drawing; the next idle moment gets it.
    });
  }

  // Empties each page's image now instead of waiting for garbage collection.
  #dropPages() {
    for (let i = 0; i < this.viewer.pagesCount; i++) this.viewer.getPageView(i)?.destroy();
  }
}

// Two files side by side, with the words that differ marked on both.
export class CompareSession {
  current = -1;
  differences = [];
  scaleValue = 'page-fit';
  sync = true;
  status = '';
  rough = false;
  #options;
  #root;
  #picker;
  #leader = null;
  #run = 0;
  #destroyed = false;
  #opening = false;

  // options: stage, askPassword(name, wrong), showToast(message), onChange(), onExit()
  constructor(view, options) {
    this.#options = options;
    this.#root = element('div', 'compare-pane active');
    this.#root.setAttribute('role', 'region');
    this.#root.setAttribute('aria-label', '左右比對');
    options.stage.append(this.#root);
    this.left = new ComparePane(this.#root, 'left', this);
    this.right = new ComparePane(this.#root, 'right', this);
    this.#picker = this.#buildPicker();
    this.right.body.append(this.#picker);
    this.left.show({ doc: view.doc, file: view.file, owned: false, task: null, text: null });
    this.status = '請選擇要放在右邊比對的 PDF。';
    this.#showPicker();
  }

  get panes() {
    return [this.left, this.right];
  }

  get title() {
    const right = this.right.content?.file.name ?? '（選擇右邊的檔案）';
    return `比對：${this.left.content?.file.name ?? ''} ↔ ${right}`;
  }

  get ready() {
    return this.left.ready && this.right.ready;
  }

  changed() {
    if (shown === this) refreshBar();
    this.#options.onChange();
  }

  setActive(active) {
    this.#root.classList.toggle('active', active);
  }

  focusTarget() {
    return (this.#leader ?? this.left).host;
  }

  destroy() {
    this.#destroyed = true;
    this.#run++;
    for (const pane of this.panes) pane.release();
    this.#root.remove();
    if (shown === this) shown = null;
  }

  exit() {
    this.#options.onExit();
  }

  // ---- Choosing the file on the right ----------------------------------------------

  #buildPicker() {
    const picker = element('div', 'compare-pick');
    const choose = element('button', 'compare-choose');
    choose.type = 'button';
    choose.innerHTML = '<svg><use href="#i-file"/></svg>';
    choose.append(element('span', '', '選擇要比對的 PDF'), element('small', '', '也可以把檔案拖到這裡'));
    choose.addEventListener('click', () => this.chooseRight());
    this.openList = element('div', 'compare-open-list');
    picker.append(choose, this.openList);
    return picker;
  }

  // Files already open in any window are offered as well.
  async #showPicker() {
    this.#picker.hidden = false;
    const paths = await window.api.openPathsEverywhere().catch(() => []);
    if (this.#destroyed) return;
    const leftPath = this.left.content?.file.path ?? '';
    const others = paths.filter((p, i) => !samePath(p, leftPath) && paths.findIndex((q) => samePath(p, q)) === i);
    this.openList.replaceChildren();
    if (others.length === 0) return;
    this.openList.append(element('span', '', '或選一個已經開啟的檔案：'));
    for (const filePath of others) {
      const button = element('button', 'compare-open-file', nameOf(filePath));
      button.type = 'button';
      button.title = filePath;
      button.addEventListener('click', () => this.setRight(filePath));
      this.openList.append(button);
    }
  }

  async chooseRight() {
    const paths = await window.api.pickPdfs();
    if (paths.length > 0) this.setRight(paths[0]);
  }

  // Whether a file dropped here is meant for the comparison.
  takesDrop(target) {
    return this.#root.contains(target);
  }

  async setRight(filePath) {
    if (this.#opening || this.#destroyed) return;
    this.#opening = true;
    try {
      const content = await this.#open(filePath);
      if (!content) return;
      if (this.#destroyed) {
        content.task.destroy().catch(() => {});
        window.api.closePdf(content.file.id);
        return;
      }
      this.right.release();
      this.#picker.hidden = true;
      this.right.show(content);
      this.#compare();
    } finally {
      this.#opening = false;
    }
  }

  async #open(filePath) {
    const name = nameOf(filePath);
    const registered = await window.api.registerPdf(filePath);
    if (!registered.ok) {
      this.#options.showToast(`無法開啟「${name}」：${REGISTER_ERRORS[registered.code] ?? '無法讀取這個檔案'}`);
      return null;
    }
    const task = openDocumentTask(registered.file, () => {
      this.#options.showToast(`讀取「${name}」時發生問題，檔案可能已被移動或刪除。`);
    });
    const answer = askPasswordFor(task, registered.file.name, this.#options.askPassword);
    try {
      const doc = await task.promise;
      return { doc, file: registered.file, owned: true, task, text: null };
    } catch (err) {
      if (!answer.canceled) this.#options.showToast(`無法開啟「${name}」：${LOAD_ERRORS[err?.name] ?? '無法讀取這個檔案'}`);
      await task.destroy().catch(() => {});
      window.api.closePdf(registered.file.id);
      return null;
    }
  }

  // ---- Comparing --------------------------------------------------------------------

  #setStatus(status) {
    this.status = status;
    this.changed();
  }

  async #compare() {
    const run = ++this.#run;
    const stale = () => run !== this.#run || this.#destroyed;
    this.differences = [];
    this.current = -1;
    this.rough = false;
    for (const pane of this.panes) pane.setMarks(new Map(), []);
    for (const pane of this.panes) {
      const { content } = pane;
      if (content.text) continue;
      const which = SIDE_NAMES[pane.side];
      this.#setStatus(`正在讀取${which}的文字…`);
      const text = await readText(content.doc, {
        isCanceled: stale,
        onPage: (n, total) => {
          if (!stale()) this.#setStatus(`正在讀取${which}的文字…（${n} / ${total} 頁）`);
        },
      }).catch(() => null);
      if (stale()) return;
      if (!text) {
        this.#setStatus(`無法讀取${which}檔案的文字，只能並排看。`);
        return;
      }
      content.text = text;
    }
    const leftText = this.left.content.text;
    const rightText = this.right.content.text;
    const [leftEmpty, rightEmpty] = [hasLittleText(leftText), hasLittleText(rightText)];
    if (leftEmpty || rightEmpty) {
      const which = leftEmpty && rightEmpty ? '兩邊的檔案都' : `${SIDE_NAMES[leftEmpty ? 'left' : 'right']}的檔案`;
      this.#setStatus(`${which}幾乎沒有文字，可能是掃描檔，無法標出不同的地方，請直接對照著看。`);
      return;
    }
    this.#setStatus('正在比對…');
    // Lets the message show before the work starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (stale()) return;
    for (const { content } of this.panes) content.parts ??= splitAtEdges(content.text);
    const { differences, rough } = compareDocuments(this.left.content.parts, this.right.content.parts);
    this.rough = rough;
    this.#placeMarks(differences);
    if (differences.length === 0) this.#setStatus('兩份的文字完全相同。');
    else this.#setStatus(`找到 ${differences.length} 處不同。${rough ? '有些地方差太多，只標出大概的範圍。' : ''}`);
  }

  // Marks every difference on both sides, numbered from the top of the left file down.
  #placeMarks(found) {
    const sides = [
      { pane: this.left, start: 'aStart', end: 'aEnd', kind: 'removed' },
      { pane: this.right, start: 'bStart', end: 'bEnd', kind: 'added' },
    ];
    const placed = found.map((difference) => ({
      difference,
      boxes: sides.map(({ pane, start, end, kind }) => {
        const text = pane.content.parts[difference.part];
        const boxes = boxesOf(text, difference[start], difference[end]).map((box) => ({ ...box, kind }));
        if (boxes.length > 0) return boxes;
        const gap = gapAt(text, difference[start]);
        return gap ? [{ ...gap, kind: 'gap' }] : [];
      }),
    }));
    // Page numbers and headers are compared apart from the body, so they are put back in
    // place: by page, then from the top of the page.
    const place = ({ boxes }) => {
      const box = boxes[0][0] ?? boxes[1][0];
      return box ? [box.page, -box.rect[3]] : [Infinity, 0];
    };
    placed.sort((p, q) => {
      const [a, b] = [place(p), place(q)];
      return a[0] - b[0] || a[1] - b[1];
    });
    this.differences = placed.map(({ difference }) => difference);
    sides.forEach(({ pane }, side) => {
      const marks = new Map();
      const anchors = [];
      placed.forEach(({ boxes }, index) => {
        anchors[index] = boxes[side][0] ?? null;
        for (const box of boxes[side]) {
          if (!marks.has(box.page)) marks.set(box.page, []);
          marks.get(box.page).push({ rect: box.rect, kind: box.kind, index });
        }
      });
      pane.setMarks(marks, anchors);
    });
  }

  goToDifference(index) {
    if (this.differences.length === 0) return;
    this.current = (index + this.differences.length) % this.differences.length;
    this.#leader = null;
    for (const pane of this.panes) {
      pane.markCurrent(this.current);
      pane.reveal(pane.anchors[this.current]);
    }
    this.changed();
  }

  nextDifference() {
    this.goToDifference(this.current + 1);
  }

  previousDifference() {
    this.goToDifference(this.current < 0 ? -1 : this.current - 1);
  }

  // ---- Moving both sides together ---------------------------------------------------

  // Called as the user starts moving a side: only what moves from here on is passed to the
  // other side. Chromium sends only the first wheel event of a scroll before the side moves;
  // the rest arrive after it already has, so the starting point is taken only when the user
  // turns to a side, never again while they keep scrolling it.
  lead(pane) {
    if (this.#leader === pane) return;
    this.#leader = pane;
    for (const each of this.panes) {
      each.lastTop = each.host.scrollTop;
      each.lastLeft = each.host.scrollLeft;
    }
  }

  // The other side moves by the same distance on the page, so a place lined up by hand or
  // by jumping to a difference stays lined up.
  paneScrolled(pane) {
    const { scrollTop, scrollLeft } = pane.host;
    const down = scrollTop - pane.lastTop;
    const across = scrollLeft - pane.lastLeft;
    pane.lastTop = scrollTop;
    pane.lastLeft = scrollLeft;
    if (!this.sync || this.#leader !== pane || !this.ready) return;
    const other = pane === this.left ? this.right : this.left;
    const ratio = other.viewer.currentScale / pane.viewer.currentScale;
    if (down) other.host.scrollTop += down * ratio;
    if (across) other.host.scrollLeft += across * ratio;
    // Its own scroll event comes later and is then not taken for a move of its own.
    other.lastTop = other.host.scrollTop;
    other.lastLeft = other.host.scrollLeft;
  }

  setSync(on) {
    this.sync = on;
    this.changed();
  }

  #reference() {
    return this.#leader?.ready ? this.#leader : this.left;
  }

  goToPage(pageNumber) {
    this.#leader = null;
    for (const pane of this.panes) pane.goToPage(pageNumber);
  }

  stepPage(step) {
    this.goToPage(this.#reference().pageNumber + step);
  }

  lastPage() {
    this.goToPage(Math.max(...this.panes.map((pane) => pane.viewer.pagesCount)));
  }

  setScale(value) {
    this.scaleValue = value;
    this.#leader = null;
    for (const pane of this.panes) {
      if (pane.ready) pane.viewer.currentScaleValue = value;
    }
    this.changed();
  }

  zoomStep(steps, pane = this.#reference(), origin = undefined) {
    if (!pane.ready) return;
    pane.viewer.updateScale({ steps, origin });
    this.setScale(pane.viewer.currentScale);
  }

  swap() {
    if (!this.ready || this.#opening) return;
    const leftContent = this.left.content;
    const rightContent = this.right.content;
    this.left.show(rightContent);
    this.right.show(leftContent);
    this.#leader = null;
    // The text already read is kept, so this is quick.
    this.#compare();
  }

  refit() {
    for (const pane of this.panes) pane.refit();
  }

  // ---- Keys and the toolbar -----------------------------------------------------------

  handleKey(event) {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl && (key === '=' || key === '+')) this.zoomStep(1);
    else if (ctrl && key === '-') this.zoomStep(-1);
    else if (ctrl && key === '0') this.setScale('page-fit');
    else if (ctrl) return false;
    else if ((event.altKey && key === 'arrowdown') || (key === 'f7' && !event.shiftKey)) this.nextDifference();
    else if ((event.altKey && key === 'arrowup') || (key === 'f7' && event.shiftKey)) this.previousDifference();
    else if (event.altKey) return false;
    else if (key === 'pagedown' || key === 'arrowright') this.stepPage(1);
    else if (key === 'pageup' || key === 'arrowleft') this.stepPage(-1);
    else if (key === 'home') this.goToPage(1);
    else if (key === 'end') this.lastPage();
    else if (key === 'escape') this.exit();
    else return false;
    return true;
  }

  barState() {
    const count = this.differences.length;
    return {
      ready: this.ready,
      count: count === 0 ? '—' : this.current < 0 ? `共 ${count} 處` : `${this.current + 1} / ${count}`,
      hasDifferences: count > 0,
      sync: this.sync,
      scaleValue: this.scaleValue,
      scale: this.left.ready ? this.left.viewer.currentScale : 1,
      status: this.status,
    };
  }
}

function refreshBar() {
  if (!shown) return;
  const state = shown.barState();
  for (const id of ['cmp-zoom-out', 'cmp-zoom', 'cmp-zoom-in', 'cmp-prev-page', 'cmp-next-page']) $(id).disabled = !shown.left.ready;
  $('cmp-swap').disabled = !state.ready;
  $('cmp-prev-diff').disabled = !state.hasDifferences;
  $('cmp-next-diff').disabled = !state.hasDifferences;
  $('cmp-diff-count').textContent = state.count;
  $('cmp-sync').classList.toggle('on', state.sync);
  $('cmp-sync').setAttribute('aria-pressed', String(state.sync));
  $('cmp-status').textContent = state.status;
  $('cmp-legend').hidden = !state.hasDifferences;
  const select = $('cmp-zoom');
  const value = String(state.scaleValue);
  if ([...select.options].some((option) => option.value === value && !option.hidden)) {
    select.value = value;
  } else {
    select.options[0].textContent = `${Math.round(state.scale * 100)}%`;
    select.value = select.options[0].value;
  }
}

// Which session the toolbar belongs to; null while reading.
export function showCompareBar(session) {
  shown = session;
  refreshBar();
}

function wire() {
  const onClick = (id, action) => $(id).addEventListener('click', () => {
    if (shown) action(shown);
  });
  onClick('cmp-swap', (session) => session.swap());
  onClick('cmp-sync', (session) => session.setSync(!session.sync));
  onClick('cmp-zoom-out', (session) => session.zoomStep(-1));
  onClick('cmp-zoom-in', (session) => session.zoomStep(1));
  onClick('cmp-prev-page', (session) => session.stepPage(-1));
  onClick('cmp-next-page', (session) => session.stepPage(1));
  onClick('cmp-prev-diff', (session) => session.previousDifference());
  onClick('cmp-next-diff', (session) => session.nextDifference());
  onClick('cmp-exit', (session) => session.exit());
  $('cmp-zoom').addEventListener('change', (event) => {
    shown?.setScale(event.target.value);
    event.target.blur();
    shown?.focusTarget()?.focus({ preventScroll: true });
  });
}

wire();
