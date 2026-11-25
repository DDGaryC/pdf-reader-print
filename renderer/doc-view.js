import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';
import { OutlinePane } from './outline.js';
import { ThumbnailStrip } from './thumbnails.js';

// pdf_viewer.mjs looks for pdf.mjs on globalThis while it loads.
globalThis.pdfjsLib = pdfjsLib;
const pdfjsViewer = await import('./vendor/pdfjs/pdf_viewer.mjs');

const vendorUrl = (relative) => new URL(`./vendor/pdfjs/${relative}`, window.location.href).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.mjs');
const sharedWorker = new pdfjsLib.PDFWorker();

const DEFAULT_SCALE = 'page-fit';
// Caps one page image at 64 MB. Very high zoom gets a little softer instead of using more.
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const FIT_SCALES = new Set(['auto', 'page-actual', 'page-fit', 'page-width']);

// pdf.js draws pages at the screen's pixel ratio. On an ordinary screen that turns
// small Chinese text into blots, so pages are drawn at twice the size and shrunk.
// pdf.js has no option for this and reads the ratio from window, hence the override.
const screenRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio').get.bind(window);
Object.defineProperty(window, 'devicePixelRatio', {
  get: () => (screenRatio() >= 2 ? screenRatio() : screenRatio() * 2),
  configurable: true,
});

// Hands pdf.js the file piece by piece over IPC instead of loading it whole.
class FileRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  #fileId;
  #onError;

  constructor(file, onError) {
    super(file.size, null);
    this.#fileId = file.id;
    this.#onError = onError;
  }

  requestDataRange(begin, end) {
    window.api.readPdfRange(this.#fileId, begin, end).then(
      (chunk) => this.onDataRange(begin, chunk),
      (err) => this.#onError(err),
    );
  }
}

export const LOAD_ERRORS = {
  InvalidPDFException: '檔案損毀，或不是 PDF',
  MissingPDFException: '找不到這個檔案',
  PasswordException: '密碼不正確',
};
export const REGISTER_ERRORS = {
  NOT_PDF: '只能開啟 PDF 檔案',
  NOT_FOUND: '找不到這個檔案',
  EMPTY: '這個檔案是空的',
  CANNOT_READ: '無法讀取這個檔案，可能正被其他程式鎖定',
};

export function openDocumentTask(file, onReadError, password = undefined) {
  return pdfjsLib.getDocument({
    range: new FileRangeTransport(file, onReadError),
    ...(typeof password === 'string' ? { password } : {}),
    worker: sharedWorker,
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    isEvalSupported: false,
    disableAutoFetch: true,
    rangeChunkSize: 256 * 1024,
  });
}

// Asks for the password when a file needs one. The answer says whether the user gave up.
export function askPasswordFor(task, fileName, askPassword) {
  const answer = { canceled: false };
  task.onPassword = (updatePassword, reason) => {
    askPassword(fileName, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((password) => {
      if (password === null) {
        answer.canceled = true;
        task.destroy();
      } else {
        updatePassword(password);
      }
    });
  };
  return answer;
}

// A scrolling view of pages without thumbnails or search, for the compare mode.
export function createPageViewer(host) {
  const viewerElement = document.createElement('div');
  viewerElement.className = 'pdfViewer';
  host.append(viewerElement);
  const eventBus = new pdfjsViewer.EventBus();
  const linkService = new pdfjsViewer.PDFLinkService({
    eventBus,
    externalLinkTarget: pdfjsViewer.LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer nofollow',
  });
  const viewer = new pdfjsViewer.PDFViewer({
    container: host,
    viewer: viewerElement,
    eventBus,
    linkService,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    imageResourcesPath: vendorUrl('images/'),
    maxCanvasPixels: MAX_CANVAS_PIXELS,
  });
  linkService.setViewer(viewer);
  return { viewer, eventBus, linkService };
}

export const PAGE_DRAWN = pdfjsViewer.RenderingStates.FINISHED;
export { pdfjsLib };

// What a print dialog has to warn about for this document.
export async function printInfoOf(doc) {
  const [permissions, metadata] = await Promise.all([doc.getPermissions(), doc.getMetadata()]);
  return {
    printForbidden: permissions !== null && !permissions.includes(pdfjsLib.PermissionFlag.PRINT),
    isProtected: Boolean(metadata.info?.EncryptFilterName),
  };
}

// One open PDF: its scrolling viewer, its thumbnails and its search state.
export class DocView {
  ready = false;
  canceled = false;
  doc = null;
  findCurrent = 0;
  findTotal = 0;
  findNotFound = false;

  #task = null;
  #strip = null;
  #destroyed = false;
  #askedForPassword = false;
  // The password that opened the file, kept in memory only, for printing it.
  #password = null;
  #askPassword;
  #onChange;
  #onReadError;
  #outline = null;
  #twoPage = false;
  // Where to start: the page this file was left at last time.
  startPage = null;

  constructor(file, { stage, sidebar, askPassword, onChange, onReadError, twoPage = false }) {
    this.file = file;
    this.#twoPage = twoPage;
    this.#askPassword = askPassword;
    this.#onChange = onChange;
    this.#onReadError = onReadError;

    this.host = document.createElement('div');
    this.host.className = 'viewer-host';
    this.host.tabIndex = 0;
    const viewerElement = document.createElement('div');
    viewerElement.className = 'pdfViewer';
    this.host.append(viewerElement);
    stage.append(this.host);

    this.thumbPane = document.createElement('div');
    this.thumbPane.className = 'thumb-pane';
    sidebar.append(this.thumbPane);
    this.outlinePane = document.createElement('div');
    this.outlinePane.className = 'outline-pane';
    sidebar.append(this.outlinePane);

    this.eventBus = new pdfjsViewer.EventBus();
    this.linkService = new pdfjsViewer.PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: pdfjsViewer.LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    this.findController = new pdfjsViewer.PDFFindController({
      eventBus: this.eventBus,
      linkService: this.linkService,
    });
    this.viewer = new pdfjsViewer.PDFViewer({
      container: this.host,
      viewer: viewerElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
      imageResourcesPath: vendorUrl('images/'),
      maxCanvasPixels: MAX_CANVAS_PIXELS,
    });
    this.linkService.setViewer(this.viewer);
    this.viewer.renderingQueue.onIdle = () => this.releaseMemory();

    this.eventBus.on('pagesinit', () => {
      this.viewer.currentScaleValue = DEFAULT_SCALE;
      const start = this.startPage;
      if (Number.isInteger(start) && start > 1 && start <= this.viewer.pagesCount) this.viewer.currentPageNumber = start;
    });
    this.eventBus.on('pagechanging', ({ pageNumber }) => {
      this.#strip?.setCurrent(pageNumber);
      this.#onChange(this);
    });
    // The picture is on the page's canvas now, so the decoded images can go. A scanned
    // page holds over 100 MB of them, and they would otherwise pile up while flipping.
    this.eventBus.on('pagerendered', ({ source }) => source.pdfPage?.cleanup());
    this.eventBus.on('scalechanging', () => this.#onChange(this));
    this.eventBus.on('updatefindmatchescount', ({ matchesCount }) => this.#setFindCount(matchesCount));
    this.eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
      this.findNotFound = state === pdfjsViewer.FindState.NOT_FOUND;
      this.#setFindCount(matchesCount);
    });

    this.host.addEventListener('wheel', (event) => {
      if (!event.ctrlKey || !this.ready) return;
      event.preventDefault();
      this.viewer.updateScale({ steps: event.deltaY < 0 ? 1 : -1, origin: [event.clientX, event.clientY] });
    }, { passive: false });
  }

  async load() {
    this.#task = openDocumentTask(this.file, (err) => {
      if (!this.#destroyed) this.#onReadError(this, err);
    });
    this.#task.onPassword = (updatePassword, reason) => {
      this.#askedForPassword = true;
      const wrong = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      this.#askPassword(this.file.name, wrong).then((password) => {
        if (password === null) {
          this.canceled = true;
          this.#task.destroy();
        } else {
          this.#password = password;
          updatePassword(password);
        }
      });
    };

    const doc = await this.#task.promise;
    if (this.#destroyed) return;
    this.doc = doc;
    this.linkService.setDocument(doc);
    this.viewer.setDocument(doc);
    // Set after the document, which starts every viewer at one page.
    if (this.#twoPage) this.viewer.spreadMode = pdfjsViewer.SpreadMode?.ODD ?? 1;
    this.#outline = new OutlinePane(this.outlinePane, doc, {
      onGo: (item) => this.#goToOutlineItem(item),
    });

    const firstPage = await doc.getPage(1);
    if (this.#destroyed) return;
    const { width, height } = firstPage.getViewport({ scale: 1 });
    this.#strip = new ThumbnailStrip(this.thumbPane, doc, {
      firstPageRatio: height / width,
      pixelRatio: screenRatio,
      onPick: (pageNumber) => this.goToPage(pageNumber),
    });
    this.#strip.setCurrent(1);
    this.ready = true;
    this.#onChange(this);
  }

  setActive(active) {
    this.host.classList.toggle('active', active);
    this.thumbPane.classList.toggle('active', active);
    this.outlinePane.classList.toggle('active', active);
    if (active) this.host.focus({ preventScroll: true });
    else this.closeFind();
  }

  get pageNumber() {
    return this.viewer.currentPageNumber;
  }

  get pageCount() {
    return this.viewer.pagesCount;
  }

  get rotation() {
    return this.viewer.pagesRotation;
  }

  get scaleValue() {
    return this.viewer.currentScaleValue;
  }

  get scale() {
    return this.viewer.currentScale;
  }

  goToPage(pageNumber) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) return false;
    this.viewer.currentPageNumber = pageNumber;
    return true;
  }

  nextPage() {
    this.viewer.nextPage();
  }

  previousPage() {
    this.viewer.previousPage();
  }

  setScale(value) {
    this.viewer.currentScaleValue = value;
  }

  zoomIn() {
    this.viewer.increaseScale();
  }

  zoomOut() {
    this.viewer.decreaseScale();
  }

  // Two pages side by side, 1 and 2, then 3 and 4, like an open book.
  setTwoPage(on) {
    this.#twoPage = on;
    if (!this.doc) return;
    this.viewer.spreadMode = on ? (pdfjsViewer.SpreadMode?.ODD ?? 1) : (pdfjsViewer.SpreadMode?.NONE ?? 0);
  }

  get twoPage() {
    return this.#twoPage;
  }

  // The bookmarks are read the first time they are shown.
  showOutline() {
    return this.#outline?.build() ?? Promise.resolve(0);
  }

  #goToOutlineItem(item) {
    if (item.dest) {
      this.linkService.goToDestination(item.dest).catch((err) => console.warn('bookmark target not found:', err));
    } else if (item.url && /^(https?|mailto):/i.test(item.url)) {
      window.open(item.url);
    }
    this.host.focus({ preventScroll: true });
  }

  rotateView(degrees) {
    const rotation = (this.viewer.pagesRotation + degrees + 360) % 360;
    this.viewer.pagesRotation = rotation;
    this.#strip?.setRotation(rotation);
  }

  find(query, { previous = false, again = false } = {}) {
    this.eventBus.dispatch('find', {
      source: this,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  closeFind() {
    this.eventBus.dispatch('findbarclose', { source: this });
    this.findCurrent = 0;
    this.findTotal = 0;
    this.findNotFound = false;
  }

  // pdf.js only frees decoded pages and fonts when asked. Pages already on screen stay.
  releaseMemory() {
    if (!this.ready) return;
    this.viewer.cleanup();
    this.doc.cleanup().catch(() => {
      // Something is still drawing; the next idle moment gets it.
    });
  }

  openPassword() {
    return this.#askedForPassword ? this.#password : null;
  }

  // What the print dialog has to warn about for this file.
  async printInfo() {
    return { needsOpenPassword: this.#askedForPassword, ...await printInfoOf(this.doc) };
  }

  // The window changed size: fit-to-width and whole-page zoom have to be redone.
  refit() {
    if (!this.ready) return;
    const value = this.viewer.currentScaleValue;
    if (FIT_SCALES.has(value)) this.viewer.currentScaleValue = value;
    this.viewer.update();
    this.#strip?.fit();
  }

  async destroy() {
    this.#destroyed = true;
    this.ready = false;
    this.#strip?.destroy();
    // Empties each page's image now instead of waiting for garbage collection.
    for (let i = 0; i < this.viewer.pagesCount; i++) this.viewer.getPageView(i)?.destroy();
    this.viewer.setDocument(null);
    this.linkService.setDocument(null);
    this.host.remove();
    this.thumbPane.remove();
    this.outlinePane.remove();
    this.#password = null;
    await this.#task?.destroy().catch(() => {});
    await window.api.closePdf(this.file.id);
  }

  #setFindCount(matchesCount) {
    this.findCurrent = matchesCount?.current ?? 0;
    this.findTotal = matchesCount?.total ?? 0;
    this.#onChange(this);
  }
}
