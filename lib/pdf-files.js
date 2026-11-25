const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 16 * 1024 * 1024;

// Open PDF files, addressed by random id. The screen only ever gets the bytes of
// files registered here, read piece by piece so big files stay out of memory.
class PdfFiles {
  #open = new Map();

  async register(filePath) {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, code: 'NOT_FOUND' };
    if (path.extname(filePath).toLowerCase() !== '.pdf') return { ok: false, code: 'NOT_PDF' };
    let handle;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      if (stat.size === 0) {
        await handle.close();
        return { ok: false, code: 'EMPTY' };
      }
      const id = crypto.randomUUID();
      this.#open.set(id, { handle, path: filePath, size: stat.size });
      return { ok: true, file: { id, path: filePath, name: path.basename(filePath), size: stat.size } };
    } catch (err) {
      await handle?.close().catch(() => {});
      return { ok: false, code: err.code === 'ENOENT' ? 'NOT_FOUND' : 'CANNOT_READ' };
    }
  }

  async read(id, begin, end) {
    const entry = this.#open.get(id);
    if (!entry) throw new Error('file is not open');
    const valid = Number.isInteger(begin) && Number.isInteger(end)
      && begin >= 0 && begin < end && end <= entry.size && end - begin <= MAX_READ_BYTES;
    if (!valid) throw new Error('invalid range');
    const buffer = Buffer.alloc(end - begin);
    const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, begin);
    return buffer.subarray(0, bytesRead);
  }

  // Size and last change, for the document information window.
  async stat(id) {
    const entry = this.#open.get(id);
    if (!entry) return null;
    try {
      const stat = await entry.handle.stat();
      return { size: stat.size, modified: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  pathOf(id) {
    return this.#open.get(id)?.path ?? null;
  }

  isOpen(filePath) {
    const wanted = path.resolve(filePath).toLowerCase();
    return [...this.#open.values()].some((entry) => path.resolve(entry.path).toLowerCase() === wanted);
  }

  async close(id) {
    const entry = this.#open.get(id);
    if (!entry) return;
    this.#open.delete(id);
    await entry.handle.close().catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.#open.keys()].map((id) => this.close(id)));
  }
}

module.exports = { PdfFiles };
