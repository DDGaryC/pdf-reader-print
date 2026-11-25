const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Printing a file that needs a password to open. Sumatra cannot be given a password,
// so the file is opened here with the password the user typed and handed over as a
// temporary copy without the lock, which is deleted once printing is done.

const pdfLib = () => require('@cantoo/pdf-lib');

// A password worth trying: anything else is refused before it reaches pdf-lib.
const usablePassword = (password) => typeof password === 'string' && password.length <= 1024;

// What the lock leaves behind once the file is open: the lock's own settings, and the
// file's old index (cross-reference stream), which pdf-lib keeps as raw bytes and which
// still names the lock. A reader that goes through the file from the top, pdf-lib among
// them, would take the copy for a locked file again, so both go.
function dropOldLock(context) {
  const { PDFDict, PDFInvalidObject, PDFName, PDFStream } = pdfLib();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject) {
      if (Buffer.from(object.data).toString('latin1', 0, 2048).includes('/XRef')) context.delete(ref);
      continue;
    }
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
    if (!dict) continue;
    const isOldIndex = dict.get(PDFName.of('Type')) === PDFName.of('XRef');
    const isLockSettings = !(object instanceof PDFStream) && dict.has(PDFName.of('Filter'))
      && dict.has(PDFName.of('O')) && dict.has(PDFName.of('U'));
    if (isOldIndex || isLockSettings) context.delete(ref);
  }
}

// Throws { code: 'WRONG_PASSWORD' } when the password does not open the file.
async function loadUnlocked(bytes, password) {
  const { PDFDocument } = pdfLib();
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { password, updateMetadata: false });
  } catch (err) {
    if (/password/i.test(String(err?.message))) throw Object.assign(new Error('wrong password'), { code: 'WRONG_PASSWORD' });
    throw err;
  }
  dropOldLock(doc.context);
  return doc;
}

async function unlockedBytes(bytes, password) {
  return (await loadUnlocked(bytes, password)).save();
}

// The name matches what removeOldTempFiles clears at startup, in case printing is cut short.
async function writeUnlockedCopy(sourcePath, password, tempDir) {
  const bytes = await unlockedBytes(await fs.promises.readFile(sourcePath), password);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const target = path.join(tempDir, `print-${crypto.randomUUID()}.pdf`);
  await fs.promises.writeFile(target, bytes);
  return target;
}

module.exports = { usablePassword, loadUnlocked, unlockedBytes, writeUnlockedCopy };
