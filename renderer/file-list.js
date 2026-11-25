import { LOAD_ERRORS, REGISTER_ERRORS, openDocumentTask, printInfoOf } from './doc-view.js';
import { moveItem, newPaths } from './list-order.js';

const PROBLEM_UNREADABLE = '無法讀取這個檔案';
const IMAGE_PROBLEMS = {
  NOT_IMAGE: '只能加入 JPG 和 PNG 圖片',
  BAD_IMAGE: '不是能用的 JPG 或 PNG 圖片',
  TOO_BIG: '圖片太大（超過 80 MB）',
  EMPTY: '這個檔案是空的',
  NOT_FOUND: '找不到這個檔案',
  CANNOT_READ: '無法讀取這個檔案，可能正被其他程式鎖定',
};
const THUMB_SIZE = 40;
const baseName = (filePath) => filePath.split(/[\\/]/).pop();
export const isImageName = (name) => /\.(jpe?g|png)$/i.test(name);

// A list of PDF files in a dialog: adding, checking each file, removing, dragging to
// change the order, and dragging files in from outside. The dialog decides what the
// rows say and what the files are for.
//   describe(item)      -> { detail, notes: [{ text, kind }], action: { label, icon, run } | null }
//                          the action is a small picture button at the end of the row
//   examine(item, doc)  a look at each opened file, after its page count and protection
//   passwordProblem     what to say about a file that needs a password
//   askPassword(name, wrong)  optional: lets a file that needs a password be unlocked
//   acceptImages        JPG and PNG pictures may be added too, as items of kind 'image'
//   isLocked()          true while the list must not change
//   showStatus(message), onChange(), onAdded(), onReady(item), onRemoved(item, index), onRowClick(item)
export class FileList {
  items = [];
  #dialog;
  #list;
  #empty;
  #options;
  #queue = Promise.resolve();
  // Passwords that opened a file in this list, tried on every other file that needs one.
  // Kept in memory only, and forgotten when the dialog closes.
  #passwords = new Set();
  #dragged = null;
  #dropBefore = null;

  constructor({ dialog, list, empty, ...options }) {
    this.#dialog = dialog;
    this.#list = list;
    this.#empty = empty;
    this.#options = options;
    list.classList.toggle('pickable', Boolean(options.onRowClick));
    this.#wireDragging();
  }

  reset() {
    this.releaseAll();
    this.items = [];
    this.#passwords.clear();
    this.#queue = Promise.resolve();
    this.#list.replaceChildren();
    this.#syncEmpty();
  }

  // Lets go of every file. Their rows stay until the next reset.
  releaseAll() {
    for (const item of this.items) this.#release(item);
  }

  add(paths) {
    if (paths.length === 0) return;
    const fresh = newPaths(this.items, paths);
    this.#options.showStatus(fresh.length < paths.length ? '已在清單上的檔案不會重複加入。' : '');
    for (const filePath of fresh) {
      const item = {
        path: filePath,
        name: baseName(filePath),
        kind: this.#options.acceptImages && isImageName(filePath) ? 'image' : 'pdf',
        image: null,
        state: 'checking',
        file: null,
        task: null,
        pages: 0,
        printForbidden: false,
        isProtected: false,
        problem: null,
        // Needs a password to open, and one can be typed for it.
        locked: false,
        password: null,
        removed: false,
      };
      item.row = this.#buildRow(item);
      this.updateRow(item);
      this.items.push(item);
      this.#list.append(item.row);
      // One at a time, so a long list does not read every file at once.
      this.#queue = this.#queue.then(() => this.#check(item)).catch((err) => console.error(err));
    }
    this.#options.onAdded?.();
    this.#changed();
  }

  remove(item) {
    if (this.#options.isLocked()) return;
    const index = this.items.indexOf(item);
    if (index < 0) return;
    this.items.splice(index, 1);
    item.row.remove();
    this.#release(item);
    this.#options.onRemoved?.(item, index);
    this.#changed();
  }

  updateRow(item) {
    const { detail, notes, action = null } = this.#options.describe(item);
    item.row.querySelector('.file-detail').textContent = detail;
    const button = item.row.querySelector('.file-action');
    button.hidden = !action;
    if (action && button.dataset.icon !== action.icon) {
      button.dataset.icon = action.icon;
      button.innerHTML = `<svg><use href="#${action.icon}"/></svg>`;
    }
    button.title = action?.label ?? '';
    button.setAttribute('aria-label', action ? `${action.label}：${item.name}` : '');
    item.runAction = action?.run ?? null;
    item.row.querySelector('.file-notes').replaceChildren(...notes.map(({ text, kind }) => {
      const note = document.createElement('span');
      note.className = `file-note ${kind}`;
      note.textContent = text;
      return note;
    }));
  }

  updateAllRows() {
    for (const item of this.items) this.updateRow(item);
  }

  setLocked(locked) {
    for (const item of this.items) {
      item.row.draggable = !locked;
      item.row.querySelector('.file-remove').disabled = locked;
      item.row.querySelector('.file-action').disabled = locked;
    }
  }

  // Passwords already known, such as those of files open in the window.
  rememberPasswords(passwords) {
    for (const password of passwords) if (typeof password === 'string') this.#passwords.add(password);
  }

  // Asks for the password of a file that needs one, until it opens or the user gives up.
  async unlock(item) {
    if (!item.locked || !this.#options.askPassword || this.#options.isLocked()) return;
    let wrong = false;
    for (;;) {
      const password = await this.#options.askPassword(item.name, wrong);
      if (password === null || item.removed || !item.locked) return;
      item.state = 'checking';
      this.updateRow(item);
      this.#changed();
      const opened = await this.#open(item, password);
      if (item.removed) return;
      item.state = 'ready';
      this.updateRow(item);
      this.#changed();
      if (opened) {
        this.#passwords.add(password);
        this.#options.onReady?.(item);
        // Files sent together often share one password.
        for (const other of this.items) {
          if (other.locked && other !== item) this.#queue = this.#queue.then(() => this.#retry(other, password)).catch((err) => console.error(err));
        }
        return;
      }
      wrong = true;
    }
  }

  #changed() {
    this.#syncEmpty();
    this.#options.onChange();
  }

  #syncEmpty() {
    this.#empty.hidden = this.items.length > 0;
    this.#list.hidden = this.items.length === 0;
  }

  #release(item) {
    item.removed = true;
    item.task?.destroy().catch(() => {});
    if (item.file) window.api.closePdf(item.file.id);
  }

  async #check(item) {
    if (item.removed) return;
    if (item.kind === 'image') {
      await this.#checkImage(item);
      return;
    }
    const registered = await window.api.registerPdf(item.path);
    if (item.removed) {
      if (registered.ok) window.api.closePdf(registered.file.id);
      return;
    }
    if (registered.ok) {
      item.file = registered.file;
      await this.#inspect(item);
    } else {
      item.problem = REGISTER_ERRORS[registered.code] ?? PROBLEM_UNREADABLE;
    }
    if (item.removed) return;
    item.state = 'ready';
    this.updateRow(item);
    this.#changed();
    this.#options.onReady?.(item);
  }

  // A picture is one page. Its size is read by the main program, which also follows the
  // note in phone photos saying which way is up; the small picture in the row does too.
  async #checkImage(item) {
    const info = await window.api.inspectImage(item.path);
    if (item.removed) return;
    if (info.ok) {
      item.image = info;
      item.pages = 1;
    } else {
      item.problem = IMAGE_PROBLEMS[info.code] ?? PROBLEM_UNREADABLE;
    }
    item.state = 'ready';
    this.updateRow(item);
    this.#changed();
    this.#options.onReady?.(item);
    if (info.ok) await this.#drawThumb(item).catch((err) => console.warn('picture preview failed:', err));
  }

  async #drawThumb(item) {
    const bytes = await window.api.readImage(item.path);
    if (!bytes || item.removed) return;
    const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
    try {
      if (item.removed) return;
      const scale = Math.min(THUMB_SIZE / bitmap.width, THUMB_SIZE / bitmap.height);
      const canvas = item.row.querySelector('.file-thumb');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(bitmap.width * scale * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale * ratio));
      canvas.style.width = `${canvas.width / ratio}px`;
      canvas.style.height = `${canvas.height / ratio}px`;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      canvas.dataset.shape = bitmap.width > bitmap.height ? 'wide' : bitmap.width < bitmap.height ? 'tall' : 'square';
      canvas.hidden = false;
    } finally {
      bitmap.close();
    }
  }

  // Files are checked without asking anything: one that needs a password gets the ones
  // already known, and otherwise waits for the user to type one.
  async #inspect(item) {
    for (const password of [undefined, ...this.#passwords]) {
      if (await this.#open(item, password)) return;
      if (item.removed) return;
    }
    item.problem = this.#options.passwordProblem;
    item.locked = Boolean(this.#options.askPassword);
  }

  async #retry(item, password) {
    if (item.removed || !item.locked) return;
    if (!await this.#open(item, password) || item.removed) return;
    this.updateRow(item);
    this.#changed();
    this.#options.onReady?.(item);
  }

  // False when the file needs a password and this one did not open it; true otherwise,
  // with the item filled in or its problem noted.
  async #open(item, password) {
    const task = openDocumentTask(item.file, () => {
      item.problem = PROBLEM_UNREADABLE;
      task.destroy().catch(() => {});
    }, password);
    item.task = task;
    try {
      const doc = await task.promise;
      item.pages = doc.numPages;
      item.problem = null;
      item.locked = false;
      item.password = password ?? null;
      Object.assign(item, await printInfoOf(doc));
      await this.#options.examine(item, doc);
      return true;
    } catch (err) {
      if (err?.name === 'PasswordException') return false;
      item.problem ??= LOAD_ERRORS[err?.name] ?? PROBLEM_UNREADABLE;
      item.locked = false;
      return true;
    } finally {
      item.task = null;
      await task.destroy().catch(() => {});
    }
  }

  #buildRow(item) {
    const row = document.createElement('li');
    row.className = 'file-row';
    row.draggable = true;
    row.title = item.path;

    const grip = document.createElement('span');
    grip.className = 'file-grip';
    grip.innerHTML = '<svg><use href="#i-grip"/></svg>';
    const thumb = document.createElement('canvas');
    thumb.className = 'file-thumb';
    thumb.hidden = true;

    const body = document.createElement('span');
    body.className = 'file-body';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.name;
    const detail = document.createElement('span');
    detail.className = 'file-detail';
    const notes = document.createElement('span');
    notes.className = 'file-notes';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'file-action';
    action.hidden = true;
    body.append(name, detail, notes);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.title = '從清單移除';
    remove.setAttribute('aria-label', `從清單移除 ${item.name}`);
    remove.innerHTML = '<svg><use href="#i-close"/></svg>';

    row.append(grip, thumb, body, action, remove);
    const { onRowClick } = this.#options;
    if (onRowClick) {
      row.tabIndex = 0;
      row.addEventListener('click', () => onRowClick(item));
      row.addEventListener('keydown', (event) => {
        if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onRowClick(item);
      });
    }
    row.addEventListener('dragstart', (event) => {
      this.#dragged = item;
      event.dataTransfer.effectAllowed = 'move';
      // Not plain text, so the name cannot end up in a text box when dropped on one.
      event.dataTransfer.setData('application/x-file-row', item.name);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => this.#endRowDrag());
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      this.remove(item);
    });
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      item.runAction?.();
    });
    return row;
  }

  #endRowDrag() {
    this.#dragged?.row.classList.remove('dragging');
    this.#dragged = null;
    for (const row of this.#list.children) row.classList.remove('drop-before', 'drop-after');
  }

  // The file the dragged one would land in front of; null means the end of the list.
  #itemAtPointer(y) {
    return this.items.find((item) => {
      const box = item.row.getBoundingClientRect();
      return y < box.top + box.height / 2;
    }) ?? null;
  }

  #wireDragging() {
    const dialog = this.#dialog;
    const list = this.#list;
    const hasFiles = (event) => event.dataTransfer?.types.includes('Files');

    list.addEventListener('dragover', (event) => {
      if (!this.#dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.#dropBefore = this.#itemAtPointer(event.clientY);
      for (const row of list.children) row.classList.remove('drop-before', 'drop-after');
      if (this.#dropBefore) this.#dropBefore.row.classList.add('drop-before');
      else list.lastElementChild?.classList.add('drop-after');
    });
    list.addEventListener('drop', (event) => {
      if (!this.#dragged) return;
      event.preventDefault();
      this.items = moveItem(this.items, this.#dragged, this.#dropBefore);
      list.insertBefore(this.#dragged.row, this.#dropBefore?.row ?? null);
      this.#endRowDrag();
    });

    // Files dragged in from outside are added to the list and do not open as tabs,
    // wherever in the window they are let go.
    dialog.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const accepts = !this.#options.isLocked();
      event.dataTransfer.dropEffect = accepts ? 'copy' : 'none';
      dialog.classList.toggle('dropping', accepts);
    });
    dialog.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget) dialog.classList.remove('dropping');
    });
    dialog.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dialog.classList.remove('dropping');
      if (this.#options.isLocked()) return;
      const files = [...event.dataTransfer.files];
      const images = Boolean(this.#options.acceptImages);
      const usable = files.filter((file) => file.name.toLowerCase().endsWith('.pdf') || (images && isImageName(file.name)));
      this.add(usable.map((file) => window.api.pathForDroppedFile(file)).filter(Boolean));
      if (usable.length < files.length) {
        this.#options.showStatus(images ? '只能加入 PDF、JPG 和 PNG，其他檔案已略過。' : '只能加入 PDF 檔案，其他檔案已略過。');
      }
    });
  }
}
