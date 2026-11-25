// Draws the icons from the pictures in build/ and writes the .ico files. The window stays
// hidden. Run it with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const ICONS = [
  { out: 'icon.ico', large: 'icon.svg', small: 'icon-small.svg' },
  { out: 'pdf.ico', large: 'pdf.svg', small: 'pdf-small.svg' },
];
// Small sizes get a simpler picture, or the details turn to mush.
const SMALL_UP_TO = 32;
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
// Old-style pictures for small sizes, which every part of Windows can read.
const BITMAP_UP_TO = 48;
const RENDERER_ICON = path.join(__dirname, '..', 'renderer', 'app-icon.png');

function bitmapEntry(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const entry = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  entry.writeUInt32LE(40, 0);
  entry.writeInt32LE(size, 4);
  entry.writeInt32LE(size * 2, 8); // Counts the mask below the picture too.
  entry.writeUInt16LE(1, 12);
  entry.writeUInt16LE(32, 14);
  entry.writeUInt32LE(size * size * 4, 20);
  const maskStart = 40 + size * size * 4;
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // Bottom row first.
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = 40 + (row * size + x) * 4;
      entry[to] = rgba[from + 2];
      entry[to + 1] = rgba[from + 1];
      entry[to + 2] = rgba[from];
      entry[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) entry[maskStart + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return entry;
}

function icoFile(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map(({ data }) => data)]);
}

async function draw(win, svgFile, size) {
  const svg = fs.readFileSync(path.join(BUILD, svgFile)).toString('base64');
  return win.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,${svg}';
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${size};
    canvas.height = ${size};
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, ${size}, ${size});
    return {
      png: canvas.toDataURL('image/png').split(',')[1],
      rgba: ${size <= BITMAP_UP_TO} ? Array.from(context.getImageData(0, 0, ${size}, ${size}).data) : null,
    };
  })()`);
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-icon-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('about:blank');
  for (const { out, large, small } of ICONS) {
    const entries = [];
    for (const size of SIZES) {
      const { png, rgba } = await draw(win, size <= SMALL_UP_TO ? small : large, size);
      const data = rgba ? bitmapEntry(size, rgba) : Buffer.from(png, 'base64');
      entries.push({ size, data });
      // Pictures to look at, not used by the program.
      if (process.env.ICON_PREVIEW) fs.writeFileSync(path.join(process.env.ICON_PREVIEW, `${path.parse(out).name}-${size}.png`), Buffer.from(png, 'base64'));
    }
    fs.writeFileSync(path.join(BUILD, out), icoFile(entries));
    console.log(out, fs.statSync(path.join(BUILD, out)).size);
  }
  const { png } = await draw(win, 'icon.svg', 64);
  fs.writeFileSync(RENDERER_ICON, Buffer.from(png, 'base64'));
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
