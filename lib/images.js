const path = require('path');

// Pictures (JPG and PNG) made into PDF pages, one picture to a page. Photos from a
// phone are often stored sideways with a note saying which way is up; that note is
// followed here, the same as Windows does when it shows the photo.

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
// Paper for the pages, portrait. "fit" makes each page the shape of its picture.
const PAPER_POINTS = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
  letter: [612, 792],
};
const IMAGE_PAPERS = [...Object.keys(PAPER_POINTS), 'fit'];
const FIT_LONG_EDGE = 841.89;
const JPEG_FRAME_MARKERS = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const pdfLib = () => require('@cantoo/pdf-lib');

const isImagePath = (filePath) => typeof filePath === 'string' && IMAGE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());

// Which way up a JPEG says it is, from its EXIF block (TIFF layout). 1 when it says nothing.
function exifOrientation(bytes, start, end) {
  if (end - start < 14 || bytes.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1;
  const tiff = start + 6;
  const order = bytes.toString('latin1', tiff, tiff + 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const little = order === 'II';
  const u16 = (at) => (at + 2 <= end ? (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at)) : null);
  const u32 = (at) => (at + 4 <= end ? (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at)) : null);
  const firstDirectory = u32(tiff + 4);
  if (firstDirectory === null) return 1;
  const directory = tiff + firstDirectory;
  const count = u16(directory);
  if (count === null) return 1;
  for (let i = 0; i < count; i++) {
    const entry = directory + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

// Type, size in pixels as stored, and orientation. Null for anything else.
function readImageInfo(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { type: 'png', width, height, orientation: 1 } : null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let orientation = 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xFF) return null;
    const marker = bytes[at + 1];
    if (marker === 0xFF) {
      at++;
      continue;
    }
    if (marker === 0xD9 || marker === 0xDA) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    const end = Math.min(bytes.length, at + 2 + length);
    if (marker === 0xE1) {
      // A file can carry more than one APP1 block (EXIF and XMP); the EXIF one counts.
      const found = exifOrientation(bytes, at + 4, end);
      if (found !== 1) orientation = found;
    }
    if (JPEG_FRAME_MARKERS.has(marker) && at + 9 <= bytes.length) {
      const height = bytes.readUInt16BE(at + 5);
      const width = bytes.readUInt16BE(at + 7);
      return width > 0 && height > 0 ? { type: 'jpeg', width, height, orientation } : null;
    }
    at += 2 + length;
  }
  return null;
}

// The size the picture is seen at, once turned the way it says.
const shownSize = ({ width, height, orientation }) => (orientation >= 5 ? { width: height, height: width } : { width, height });

// Where a picture goes: maps the picture's unit square onto the box, turned or flipped
// the way its orientation says, so the top of the photo ends up at the top of the page.
function imageMatrix(orientation, [x, y, w, h]) {
  switch (orientation) {
    case 2: return [-w, 0, 0, h, x + w, y];
    case 3: return [-w, 0, 0, -h, x + w, y + h];
    case 4: return [w, 0, 0, -h, x, y + h];
    case 5: return [0, -h, -w, 0, x + w, y + h];
    case 6: return [0, -h, w, 0, x, y + h];
    case 7: return [0, h, w, 0, x, y];
    case 8: return [0, h, -w, 0, x + w, y];
    default: return [w, 0, 0, h, x, y];
  }
}

// The page size and the box the picture fills: on paper, turned to suit the picture
// and as large as fits, centred; with "fit", a page of the picture's own shape.
function pageLayout({ width, height }, paper) {
  if (paper === 'fit' || !PAPER_POINTS[paper]) {
    if (paper === 'fit') {
      const scale = FIT_LONG_EDGE / Math.max(width, height);
      const size = [width * scale, height * scale];
      return { size, box: [0, 0, size[0], size[1]] };
    }
    paper = 'A4';
  }
  const [short, long] = PAPER_POINTS[paper];
  const size = width > height ? [long, short] : [short, long];
  const scale = Math.min(size[0] / width, size[1] / height);
  const w = width * scale;
  const h = height * scale;
  return { size, box: [(size[0] - w) / 2, (size[1] - h) / 2, w, h] };
}

async function addImagePage(doc, bytes, paper) {
  const {
    concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState,
  } = pdfLib();
  const info = readImageInfo(bytes);
  if (!info) throw Object.assign(new Error('not a picture'), { code: 'BAD_IMAGE' });
  const image = info.type === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const { size, box } = pageLayout(shownSize(info), paper);
  const page = doc.addPage(size);
  const name = page.node.newXObject('Image', image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...imageMatrix(info.orientation, box)),
    drawObject(name),
    popGraphicsState(),
  );
  return page;
}

// A document of one page holding the picture, ready to be copied into a merge.
async function imageDocument(bytes, paper) {
  const doc = await pdfLib().PDFDocument.create();
  try {
    await addImagePage(doc, bytes, paper);
    // The picture's own data only goes into the document here; a page copied out of
    // it before this would point at nothing and come out blank.
    await doc.flush();
  } catch (err) {
    throw Object.assign(err, { code: err.code ?? 'BAD_IMAGE' });
  }
  return doc;
}

module.exports = {
  IMAGE_EXTENSIONS, IMAGE_PAPERS, MAX_IMAGE_BYTES, isImagePath, readImageInfo, shownSize, imageMatrix, pageLayout,
  addImagePage, imageDocument,
};
