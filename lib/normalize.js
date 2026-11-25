const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Sumatra already turns landscape pages counter-clockwise when printing, so the
// default direction needs no change to the file. For clockwise, each landscape
// page's rotation setting is changed on a temporary copy; once a page is upright
// Sumatra leaves it alone. Only /Rotate changes, so annotations and forms stay intact.

const normalizeAngle = (angle) => ((angle % 360) + 360) % 360;

function visibleSize(page) {
  const { width, height } = page.getCropBox();
  const quarterTurned = normalizeAngle(page.getRotation().angle) % 180 !== 0;
  return quarterTurned ? { width: height, height: width } : { width, height };
}

async function rotateLandscapeClockwise(bytes) {
  // pdf-lib is only loaded when someone actually prints clockwise, to keep startup fast.
  const { PDFDocument, degrees } = require('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let rotated = 0;
  for (const page of doc.getPages()) {
    const { width, height } = visibleSize(page);
    if (width > height) {
      page.setRotation(degrees((normalizeAngle(page.getRotation().angle) + 90) % 360));
      rotated++;
    }
  }
  return { bytes: await doc.save(), rotated };
}

async function writeClockwiseCopy(sourcePath, tempDir) {
  const { bytes } = await rotateLandscapeClockwise(await fs.promises.readFile(sourcePath));
  await fs.promises.mkdir(tempDir, { recursive: true });
  const target = path.join(tempDir, `print-${crypto.randomUUID()}.pdf`);
  await fs.promises.writeFile(target, bytes);
  return target;
}

// A copy can outlive the app if it quits mid-print, so old ones are cleared at startup.
async function removeOldTempFiles(tempDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  let names;
  try {
    names = await fs.promises.readdir(tempDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(names.filter((name) => /^print-.*\.pdf$/.test(name)).map(async (name) => {
    const file = path.join(tempDir, name);
    try {
      if ((await fs.promises.stat(file)).mtimeMs < cutoff) await fs.promises.rm(file, { force: true });
    } catch {
      // In use or already gone; the next start tries again.
    }
  }));
}

module.exports = { normalizeAngle, rotateLandscapeClockwise, writeClockwiseCopy, removeOldTempFiles, visibleSize };
