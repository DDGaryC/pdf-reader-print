import { LOAD_ERRORS, REGISTER_ERRORS, openDocumentTask, printInfoOf } from './doc-view.js';
import { PageGrid } from './organize-grid.js';
import { PageHistory, insertPages, movePages, pagesOf, placeAfter, removePages, turnPages } from './page-list.js';

const $ = (id) => document.getElementById(id);

export const ORGANIZE_PROTECTED = '此檔案受保護，無法整理頁面。';
const failureOf = (how, { reason, file }) => ({
  IN_USE: how === 'overwrite'
    ? '檔案正在被其他程式使用，請先關閉後再試，或改用另存新檔。'
    : '這個檔案正在被其他程式使用，請先關閉後再試，或換一個檔名。',
  OPEN_ELSEWHERE: '這個檔案已在其他分頁或視窗開啟，請先關閉它，或換一個檔名。',
  SAME_FILE: '不能另存到正在整理的檔案上。要覆蓋原檔請按「儲存」，或換一個檔名。',
  CANNOT_WRITE: '無法存檔，請確認資料夾可以寫入。',
  PROTECTED: `「${file}」受保護，無法整理頁面。`,
  CANNOT_READ: file ? `無法讀取「${file}」，檔案可能已損毀或被移動。` : '無法存檔，請確認原檔還在。',
}[reason] ?? '無法存檔。');

let shown = null;
const DEFAULT_SIZE = 180;
let thumbnailSize = DEFAULT_SIZE;

function nameOf(filePath) {
  return filePath.split(/[\\/]/).pop();
}

// Organizing one document. Nothing is written until saving: the changes are only a list
// of which page goes where and how it is turned.
export class OrganizeSession {
  busy = false;
  #view;
  #sources;
  #history;
  #grid;
  #pane;
  #nextKey = 1;
  #options;

  // options: stage, onChange(), onReopen(path) -> reopened?, onSplit(), onExit(), showToast(message)
  constructor(view, options) {
    this.#view = view;
    this.#options = options;
    this.#pane = document.createElement('div');
    this.#pane.className = 'organize-pane active';
    this.#pane.tabIndex = 0;
    this.#pane.setAttribute('role', 'listbox');
    this.#pane.setAttribute('aria-multiselectable', 'true');
    this.#pane.setAttribute('aria-label', '頁面，可拖曳調整順序');
    options.stage.append(this.#pane);
    this.#sources = [{ file: view.file, doc: view.doc, task: null }];
    this.#grid = new PageGrid(this.#pane, {
      size: thumbnailSize,
      docOf: (source) => this.#sources[source].doc,
      describe: (page) => this.#describe(page),
      isLocked: () => this.busy,
      onSelect: () => this.#changed(),
      onMove: (target) => this.#apply(movePages(this.#pages, this.#grid.selected, target)),
      onWheelSize: (direction, event) => this.stepSize(direction, event),
      // It refuses while something is still drawing; the next round gets it.
      releaseMemory: () => Promise.all(this.#sources.map(({ doc }) => doc.cleanup().catch(() => {}))),
    });
    this.#history = new PageHistory(pagesOf(0, view.doc.numPages, () => this.#nextKey++));
    this.#grid.show(this.#pages);
  }

  get #pages() {
    return this.#history.pages;
  }

  get dirty() {
    return this.#history?.dirty ?? false;
  }

  get name() {
    return this.#view.file.name;
  }

  setActive(active) {
    this.#pane.classList.toggle('active', active);
  }

  destroy() {
    this.#grid.destroy();
    this.#closeInserted();
    if (shown === this) shown = null;
  }

  #describe(page) {
    const where = `第 ${page.index + 1} 頁`;
    return page.source === 0 ? `原本的${where}` : `來自「${this.#sources[page.source].file.name}」${where}`;
  }

  #changed() {
    if (shown === this) refreshBar();
    this.#options.onChange();
  }

  #apply(next) {
    if (!this.#history.apply(next)) return false;
    this.#grid.show(this.#pages);
    this.#changed();
    return true;
  }

  #setBusy(busy) {
    this.busy = busy;
    this.#changed();
  }

  // ---- Changes --------------------------------------------------------------------

  undo() {
    if (!this.#history.undo()) return;
    this.#grid.show(this.#pages);
    this.#changed();
  }

  redo() {
    if (!this.#history.redo()) return;
    this.#grid.show(this.#pages);
    this.#changed();
  }

  turn(degrees) {
    this.#apply(turnPages(this.#pages, this.#grid.selected, degrees));
  }

  deleteSelected() {
    const { selected } = this.#grid;
    if (selected.size === 0) return;
    if (selected.size === this.#pages.length) {
      this.#options.showToast('不能刪除所有頁面，至少要留一頁。');
      return;
    }
    this.#apply(removePages(this.#pages, selected));
  }

  async insert() {
    const paths = await window.api.pickPdfs();
    if (paths.length === 0 || this.busy) return;
    this.#setBusy(true);
    const added = [];
    for (const filePath of paths) {
      const source = await this.#openSource(filePath);
      if (source === null) continue;
      added.push(...pagesOf(source, this.#sources[source].doc.numPages, () => this.#nextKey++));
    }
    this.#setBusy(false);
    if (added.length === 0) return;
    this.#apply(insertPages(this.#pages, added, placeAfter(this.#pages, this.#grid.selected)));
    this.#grid.select(added.map((page) => page.key));
    this.#grid.scrollTo(added[0].key);
  }

  // Gives the place in the list of sources, or null with the reason shown.
  async #openSource(filePath) {
    const name = nameOf(filePath);
    const registered = await window.api.registerPdf(filePath);
    if (!registered.ok) {
      this.#options.showToast(`無法插入「${name}」：${REGISTER_ERRORS[registered.code] ?? '無法讀取這個檔案'}`);
      return null;
    }
    // Without a password prompt pdf.js simply reports that one is needed.
    const task = openDocumentTask(registered.file, () => {});
    try {
      const doc = await task.promise;
      if ((await printInfoOf(doc)).isProtected) throw Object.assign(new Error('protected'), { name: 'PasswordException' });
      this.#sources.push({ file: registered.file, doc, task });
      return this.#sources.length - 1;
    } catch (err) {
      this.#options.showToast(err?.name === 'PasswordException'
        ? `「${name}」受保護，無法插入。`
        : `無法插入「${name}」：${LOAD_ERRORS[err?.name] ?? '無法讀取這個檔案'}`);
      await task.destroy().catch(() => {});
      window.api.closePdf(registered.file.id);
      return null;
    }
  }

  #closeInserted() {
    for (const { file, task } of this.#sources.slice(1)) {
      task.destroy().catch(() => {});
      window.api.closePdf(file.id);
    }
    this.#sources = this.#sources.slice(0, 1);
  }

  // ---- Saving ---------------------------------------------------------------------

  async #write(how, pages) {
    this.#setBusy(true);
    try {
      return await window.api.organize({
        sourceIds: this.#sources.map(({ file }) => file.id),
        layout: pages.map(({ source, index, turn }) => ({ source, index, turn })),
        how,
      });
    } finally {
      this.#setBusy(false);
    }
  }

  async extract() {
    const pages = this.#pages.filter((page) => this.#grid.selected.has(page.key));
    if (pages.length === 0) return;
    const result = await this.#write('extract', pages);
    if (result.ok) this.#options.showToast(`已把 ${pages.length} 頁擷取到「${result.name}」。`);
    else if (result.reason !== 'CANCELED') this.#options.showToast(failureOf('extract', result));
  }

  // True once the file is saved. The tab then shows the saved file, and what is listed
  // here starts over from it, so there is nothing left to undo.
  async #saveAndReopen(how) {
    const result = await this.#write(how, this.#pages);
    if (!result.ok) {
      if (result.reason !== 'CANCELED') this.#options.showToast(failureOf(how, result));
      return false;
    }
    this.#setBusy(true);
    const reopened = await this.#options.onReopen(result.path);
    this.#setBusy(false);
    if (!reopened) {
      this.#history.markSaved();
      this.#changed();
      this.#options.showToast(`已存成「${result.name}」，但無法重新開啟它。`);
    } else {
      this.#options.showToast(how === 'overwrite'
        ? `已儲存「${result.name}」。`
        : `已另存成「${result.name}」，現在開啟的就是這份新檔案，原檔沒有改動。`);
    }
    return true;
  }

  saveAs() {
    return this.#saveAndReopen('saveAs');
  }

  overwrite() {
    return this.#saveAndReopen('overwrite');
  }

  async save() {
    const choice = await choose('要覆蓋原檔嗎？', `「${this.name}」會被整理後的內容取代，存檔後無法復原。不想動到原檔，請用「另存新檔」。`, ['cancel', 'overwrite']);
    return choice === 'overwrite' ? this.overwrite() : false;
  }

  // The file was saved and opened again: the list starts over from it.
  rebase(view) {
    const chosen = this.#pages.flatMap((page, position) => (this.#grid.selected.has(page.key) ? [position] : []));
    const { scrollTop } = this.#pane;
    this.#grid.reset();
    this.#closeInserted();
    this.#view = view;
    this.#sources = [{ file: view.file, doc: view.doc, task: null }];
    this.#history = new PageHistory(pagesOf(0, view.doc.numPages, () => this.#nextKey++));
    this.#grid.show(this.#pages);
    this.#grid.select(chosen.flatMap((position) => this.#pages[position]?.key ?? []));
    this.#pane.scrollTop = scrollTop;
  }

  // ---- Keys and the toolbar ---------------------------------------------------------

  handleKey(event) {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (key === 'escape' && this.#grid.cancelDrag()) return true;
    if (ctrl && (key === '=' || key === '+')) this.stepSize(1);
    else if (ctrl && key === '-') this.stepSize(-1);
    else if (ctrl && key === '0') this.setSize(DEFAULT_SIZE);
    else if (this.busy) return false;
    else if (ctrl && key === 'z' && event.shiftKey) this.redo();
    else if (ctrl && key === 'z') this.undo();
    else if (ctrl && key === 'y') this.redo();
    else if (ctrl && key === 'a') this.#grid.selectAll();
    else if (ctrl && key === 's') this.saveAs();
    else if (!ctrl && key === 'delete') this.deleteSelected();
    else if (!ctrl && key === 'escape') this.#grid.clearSelection();
    else return false;
    return true;
  }

  setSize(size, event) {
    thumbnailSize = size;
    this.#grid.setSize(size, event);
    if (shown === this) refreshBar();
  }

  stepSize(direction, event) {
    const slider = $('org-size');
    const next = this.#grid.size + direction * Number(slider.step);
    if (next >= Number(slider.min) && next <= Number(slider.max)) this.setSize(next, event);
  }

  split() {
    if (this.dirty) this.#options.showToast('有未儲存的變更。拆分用的是存檔後的內容，請先儲存或另存新檔。');
    else this.#options.onSplit();
  }

  exit() {
    this.#options.onExit();
  }

  barState() {
    const { selected } = this.#grid;
    const count = this.#pages.length;
    return {
      busy: this.busy,
      canUndo: this.#history.canUndo,
      canRedo: this.#history.canRedo,
      hasSelection: selected.size > 0,
      dirty: this.dirty,
      size: this.#grid.size,
      count: selected.size > 0 ? `共 ${count} 頁，已選 ${selected.size} 頁` : `共 ${count} 頁`,
      note: this.busy ? '處理中，請稍候…' : this.#view.rotation !== 0 ? '畫面的旋轉不算在內，這裡的左轉、右轉才會存進檔案。' : '',
    };
  }
}

function refreshBar() {
  if (!shown) return;
  const state = shown.barState();
  const idle = !state.busy;
  $('org-undo').disabled = !idle || !state.canUndo;
  $('org-redo').disabled = !idle || !state.canRedo;
  for (const id of ['org-left', 'org-right', 'org-delete', 'org-extract']) $(id).disabled = !idle || !state.hasSelection;
  for (const id of ['org-insert', 'org-split', 'org-saveas', 'org-exit']) $(id).disabled = !idle;
  $('org-save').disabled = !idle || !state.dirty;
  $('org-size').value = state.size;
  $('org-count').textContent = state.count;
  $('org-note').textContent = state.note;
}

// Which session the toolbar and footer belong to; null while reading.
export function showOrganizeBar(session) {
  shown = session;
  refreshBar();
}

function choose(title, text, buttons) {
  const dialog = $('organize-dialog');
  const ids = { cancel: 'org-dialog-cancel', discard: 'org-dialog-discard', overwrite: 'org-dialog-overwrite', saveAs: 'org-dialog-saveas' };
  $('org-dialog-title').textContent = title;
  $('org-dialog-text').textContent = text;
  for (const [choice, id] of Object.entries(ids)) $(id).hidden = !buttons.includes(choice);
  $('org-dialog-overwrite').classList.toggle('primary', !buttons.includes('saveAs'));
  dialog.showModal();
  return new Promise((resolve) => {
    const listeners = Object.entries(ids).map(([choice, id]) => [id, () => finish(choice)]);
    const onCancel = (event) => {
      event.preventDefault();
      finish('cancel');
    };
    const finish = (choice) => {
      for (const [id, listener] of listeners) $(id).removeEventListener('click', listener);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(choice);
    };
    for (const [id, listener] of listeners) $(id).addEventListener('click', listener);
    dialog.addEventListener('cancel', onCancel);
  });
}

// Asks first if there is anything unsaved. True when the session may go.
export async function leaveAllowed(session) {
  if (session.busy) return false;
  if (!session.dirty) return true;
  const choice = await choose('要儲存變更嗎？', `「${session.name}」有未儲存的變更。`, ['cancel', 'discard', 'overwrite', 'saveAs']);
  if (choice === 'discard') return true;
  if (choice === 'saveAs') return session.saveAs();
  if (choice === 'overwrite') return session.overwrite();
  return false;
}

function wire() {
  const onClick = (id, action) => $(id).addEventListener('click', () => {
    if (shown && !shown.busy) action(shown);
  });
  onClick('org-undo', (session) => session.undo());
  onClick('org-redo', (session) => session.redo());
  onClick('org-left', (session) => session.turn(-90));
  onClick('org-right', (session) => session.turn(90));
  onClick('org-delete', (session) => session.deleteSelected());
  onClick('org-insert', (session) => session.insert());
  onClick('org-extract', (session) => session.extract());
  onClick('org-split', (session) => session.split());
  onClick('org-save', (session) => session.save());
  onClick('org-saveas', (session) => session.saveAs());
  onClick('org-exit', (session) => session.exit());
  $('org-size').addEventListener('input', (event) => shown?.setSize(Number(event.target.value)));
}

wire();

