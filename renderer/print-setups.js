// Saved print setups ("常用設定") in the print dialog and the batch print dialog: a
// name for a set of settings, applied with one choice. The list itself is kept by
// the main program, so both dialogs and every window share it.

const DUPLEX_WORDS = { simplex: '單面', duplexlong: '雙面長邊', duplexshort: '雙面短邊' };
const PAPER_WORDS = { A4: 'A4', A3: 'A3', A5: 'A5', letter: 'Letter', legal: 'Legal' };
const MAX_NAME = 40;
const MAX_PRINTER_WORDS = 18;

// A name to start from, made of what sets this setup apart.
export function suggestName(setup, printerLabel = '') {
  const parts = [];
  if (printerLabel) parts.push(printerLabel.length > MAX_PRINTER_WORDS ? printerLabel.slice(0, MAX_PRINTER_WORDS) : printerLabel);
  if (setup.perSheet > 1) parts.push(`每張 ${setup.perSheet} 頁`);
  parts.push(DUPLEX_WORDS[setup.duplex] ?? '單面');
  if (setup.paper && setup.paper !== 'A4') parts.push(PAPER_WORDS[setup.paper] ?? setup.paper);
  if (setup.grayscale) parts.push('灰階');
  if (setup.direction === 'clockwise') parts.push('順時針');
  if (setup.perSheet === 1 && setup.scale && setup.scale !== 'fit') parts.push(setup.scale === 'shrink' ? '只縮不放' : '實際大小');
  return parts.join('、').slice(0, MAX_NAME);
}

// Whether the dialog shows exactly this setup. A setup without a printer fits any printer;
// scaling only counts for one page per sheet, and the direction not at all where the file
// can only turn one way.
export function matches(setup, current, { ignoreDirection = false } = {}) {
  return (setup.printer === null || setup.printer === current.printer)
    && (ignoreDirection || setup.direction === current.direction)
    && setup.paper === current.paper
    && setup.grayscale === current.grayscale
    && setup.duplex === current.duplex
    && setup.perSheet === current.perSheet
    && (setup.perSheet === 1 ? setup.scale === current.scale : setup.border === current.border);
}

export function findMatching(setups, current, options) {
  return setups.find((setup) => matches(setup, current, options)) ?? null;
}

// The controls for one dialog, found by their ids: `${prefix}-setup`, `${prefix}-setup-save` …
//   current()          the dialog's settings now, with perSheet and border
//   apply(setup)       puts a setup into the dialog; false when its printer is not there
//   printerLabel()     the chosen printer's name as shown, for suggesting a name
//   ignoreDirection()  true where the file can only turn one way
export class SetupPicker {
  #prefix;
  #options;
  #setups = [];
  #deleting = null;

  constructor(prefix, options) {
    this.#prefix = prefix;
    this.#options = options;
    this.#wire();
  }

  #el(suffix) {
    return document.getElementById(`${this.#prefix}-setup${suffix}`);
  }

  // When the dialog opens.
  reset(setups) {
    this.#hideForm();
    this.#note('');
    this.#setDeleting(null);
    this.setSetups(setups);
  }

  setSetups(setups) {
    this.#setups = Array.isArray(setups) ? setups : [];
    const select = this.#el('');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = this.#setups.length === 0 ? '（還沒有常用設定）' : '（選一組套用）';
    select.replaceChildren(placeholder, ...this.#setups.map((setup) => {
      const option = document.createElement('option');
      option.value = setup.name;
      option.textContent = setup.name;
      return option;
    }));
    this.sync();
  }

  // Shows the setup the dialog matches now, if any; called after every change.
  sync() {
    const found = findMatching(this.#setups, this.#options.current(), { ignoreDirection: this.#options.ignoreDirection() });
    this.#el('').value = found?.name ?? '';
    this.#el('-delete').disabled = !found;
    if (this.#deleting && this.#deleting !== found?.name) this.#setDeleting(null);
  }

  #note(message) {
    const note = this.#el('-note');
    note.textContent = message;
    note.hidden = !message;
  }

  // The bin turns red while it waits to be pressed a second time.
  #setDeleting(name) {
    this.#deleting = name;
    const button = this.#el('-delete');
    button.classList.toggle('danger', Boolean(name));
    button.title = name ? `再按一次，確定刪除「${name}」` : '刪除左邊選到的常用設定';
    button.setAttribute('aria-label', name ? `確定刪除「${name}」` : '刪除選到的常用設定');
  }

  #hideForm() {
    this.#el('-form').hidden = true;
    this.#el('-actions').hidden = false;
  }

  #showForm() {
    const current = this.#options.current();
    const input = this.#el('-name');
    input.value = this.#el('').value || suggestName(current, this.#options.printerLabel());
    this.#el('-actions').hidden = true;
    this.#el('-form').hidden = false;
    this.#note('同一個名稱會取代原本那一組。');
    input.focus();
    input.select();
  }

  async #save() {
    const name = this.#el('-name').value.replace(/\s+/g, ' ').trim();
    if (!name) {
      this.#note('請輸入名稱。');
      this.#el('-name').focus();
      return;
    }
    const result = await window.api.savePrintSetup({ ...this.#options.current(), name });
    if (!result.ok) {
      this.#note(result.reason === 'TOO_MANY' ? '常用設定太多了，請先刪掉一些。' : '無法儲存，請換個名稱再試。');
      return;
    }
    this.#hideForm();
    this.setSetups(result.setups);
    this.#note(result.replaced ? `已更新「${name}」。` : `已存成「${name}」，下次在上面選它就能套用。`);
  }

  async #delete() {
    const name = this.#el('').value;
    if (!name) return;
    if (this.#deleting !== name) {
      this.#setDeleting(name);
      this.#note(`再按一次垃圾桶，就會刪掉「${name}」。`);
      return;
    }
    this.#setDeleting(null);
    this.setSetups(await window.api.deletePrintSetup(name));
    this.#note(`已刪除「${name}」。`);
  }

  #wire() {
    this.#el('').addEventListener('change', () => {
      const setup = this.#setups.find((one) => one.name === this.#el('').value);
      this.#setDeleting(null);
      if (!setup) {
        this.#note('');
        return;
      }
      const printerFound = this.#options.apply(setup);
      this.#note(printerFound ? '' : `找不到印表機「${setup.printer}」，沿用目前選的印表機。`);
    });
    this.#el('-save').addEventListener('click', () => {
      this.#setDeleting(null);
      this.#showForm();
    });
    this.#el('-ok').addEventListener('click', () => this.#save());
    this.#el('-cancel').addEventListener('click', () => {
      this.#hideForm();
      this.#note('');
    });
    this.#el('-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#save();
      } else if (event.key === 'Escape') {
        // Closes the name box only, not the whole dialog.
        event.preventDefault();
        event.stopPropagation();
        this.#hideForm();
        this.#note('');
      }
    });
    this.#el('-delete').addEventListener('click', () => this.#delete());
  }
}
