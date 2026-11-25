// Copies the pdf.js files the app needs from node_modules into renderer/vendor/pdfjs.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const from = path.join(root, 'node_modules', 'pdfjs-dist');
const to = path.join(root, 'renderer', 'vendor', 'pdfjs');

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });

const files = {
  'build/pdf.mjs': 'pdf.mjs',
  'build/pdf.worker.mjs': 'pdf.worker.mjs',
  'web/pdf_viewer.mjs': 'pdf_viewer.mjs',
  'web/pdf_viewer.css': 'pdf_viewer.css',
  LICENSE: 'LICENSE',
};
for (const [src, dest] of Object.entries(files)) {
  fs.copyFileSync(path.join(from, src), path.join(to, dest));
}
// Two memory settings pdf.js has no option for. It keeps the images of 10 pages, about
// 100 MB at the double resolution used here, and waits 30 seconds of idle time before
// freeing decoded pages, which on scanned files can mean close to 1 GB in between.
const viewerFile = path.join(to, 'pdf_viewer.mjs');
let viewerSource = fs.readFileSync(viewerFile, 'utf8');
for (const [before, after] of [
  ['const DEFAULT_CACHE_SIZE = 10;', 'const DEFAULT_CACHE_SIZE = 5;'],
  ['const CLEANUP_TIMEOUT = 30000;', 'const CLEANUP_TIMEOUT = 5000;'],
]) {
  if (!viewerSource.includes(before)) throw new Error(`pdf_viewer.mjs changed: "${before}" not found`);
  viewerSource = viewerSource.replace(before, after);
}
fs.writeFileSync(viewerFile, viewerSource);

for (const dir of ['cmaps', 'standard_fonts']) {
  fs.cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
}
fs.cpSync(path.join(from, 'web', 'images'), path.join(to, 'images'), { recursive: true });

console.log('pdf.js copied to', to);
