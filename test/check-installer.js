// Runs the installer's own registry steps for real, but redirected to a private test key that is
// removed afterwards, so nothing about the real .pdf settings can change. No window appears.
// Usage: npm run test:installer
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = path.join(__dirname, '..');
const CACHE = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis-3.0.4.1');
const findMakensis = (dir) => {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      const found = findMakensis(full);
      if (found) return found;
    } else if (name.name.toLowerCase() === 'makensis.exe') {
      return full;
    }
  }
  return null;
};
const makensis = findMakensis(CACHE);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfrp-nsis-'));
const TEST_ROOT = 'Software\\PDFReaderPrintTest';

let bad = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) bad += 1;
};

const powershell = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], { windowsHide: true, encoding: 'utf8' });

const readKey = (key) => JSON.parse(powershell(`
  $k = Get-Item -LiteralPath 'HKCU:\\${TEST_ROOT}\\${key}' -ErrorAction SilentlyContinue
  if (-not $k) { 'null' } else {
    $o = @{}
    foreach ($n in $k.GetValueNames()) { $o[$(if ($n -eq '') { '(default)' } else { $n })] = [string]$k.GetValue($n) }
    $o | ConvertTo-Json -Compress
  }`).trim() || 'null');
const seed = (key, name, value) => powershell(`
  $path = 'HKCU:\\${TEST_ROOT}\\${key}'
  New-Item -Path $path -Force | Out-Null
  Set-ItemProperty -LiteralPath $path -Name '${name}' -Value '${value}'`);
const removeTestKey = () => powershell(`Remove-Item -LiteralPath 'HKCU:\\${TEST_ROOT}' -Recurse -Force -ErrorAction SilentlyContinue; exit 0`);
const realPdfKeys = () => powershell(`
  (Get-Item -LiteralPath 'HKCU:\\Software\\Classes\\.pdf').GetValue('')
  (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice').ProgId
  ((Get-Item -LiteralPath 'HKCU:\\Software\\Classes\\.pdf\\OpenWithProgids').GetValueNames() -join ',')
  ((Get-Item -LiteralPath 'HKCU:\\Software\\RegisteredApplications').GetValueNames() -contains 'PDFReaderPrint')`);

// The same steps, with only the place they write to changed.
const macros = fs.readFileSync(path.join(project, 'build/installer.nsh'), 'utf8')
  .replaceAll('"Software\\', `"${TEST_ROOT}\\`);
if (!macros.includes('"Software\\') && macros.includes(TEST_ROOT)) console.log('ok   every registry step is redirected to the test key');
fs.writeFileSync(path.join(work, 'macros.nsh'), macros);
const FAKE_DIR = 'C:\\Fake Folder\\PDF閱讀列印';
fs.writeFileSync(path.join(work, 'test.nsi'), `Unicode true
!include LogicLib.nsh
!define PRODUCT_NAME "PDF閱讀列印"
!macro _neverUpdated _a _b _t _f
  Goto \`\${_f}\`
!macroend
!define isUpdated \`"" neverUpdated ""\`
Var appExe
Var isForceCurrentInstall
!include "macros.nsh"
SilentInstall silent
RequestExecutionLevel user
OutFile "\${OUT}"
Section
  SetShellVarContext current
  StrCpy $INSTDIR "${FAKE_DIR}"
  StrCpy $appExe "$INSTDIR\\PDF閱讀列印.exe"
  !insertmacro customInstallMode
  !insertmacro \${STEP}
SectionEnd
`, { encoding: 'utf8' });

const build = (step, out) => execFileSync(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', `-DSTEP=${step}`, `-DOUT=${out}`, 'test.nsi'], { cwd: work, windowsHide: true, encoding: 'utf8' });
const run = (exe) => execFileSync(path.join(work, exe), [], { windowsHide: true });

const realBefore = realPdfKeys();
try {
  build('customInstall', 'install.exe');
  build('customUnInstall', 'uninstall.exe');
  check('the steps compile', true);

  removeTestKey();
  // As on this computer: PDFgear holds the .pdf setting.
  seed('Classes\\.pdf', '(default)', 'PdfGear.App.1');
  seed('Classes\\.pdf\\OpenWithProgids', 'PdfGear.App.1', '');
  seed('RegisteredApplications', 'OneDrive', 'SOFTWARE\\Microsoft\\OneDrive\\Capabilities');
  run('install.exe');

  const pdf = readKey('Classes\\.pdf');
  check('install: PDFgear keeps the .pdf setting', pdf?.['(default)'] === 'PdfGear.App.1', JSON.stringify(pdf));
  const withs = readKey('Classes\\.pdf\\OpenWithProgids');
  check('install: added under Open with, next to PDFgear', withs && 'PdfGear.App.1' in withs && 'PDFReaderPrint.pdf' in withs, JSON.stringify(withs));
  const command = readKey('Classes\\PDFReaderPrint.pdf\\shell\\open\\command');
  check('install: double-clicking passes the file, quoted', command?.['(default)'] === `"${FAKE_DIR}\\PDF閱讀列印.exe" "%1"`, JSON.stringify(command));
  check('install: the file type has a name', readKey('Classes\\PDFReaderPrint.pdf')?.['(default)'] === 'PDF 文件');
  check('install: the file type has its icon', readKey('Classes\\PDFReaderPrint.pdf\\DefaultIcon')?.['(default)'] === `${FAKE_DIR}\\resources\\pdf.ico`);
  check('install: open is the main action', readKey('Classes\\PDFReaderPrint.pdf\\shell')?.['(default)'] === 'open');
  const capabilities = readKey('PDFReaderPrint\\Capabilities');
  check('install: the program has its name in Windows settings', capabilities?.ApplicationName === 'PDF閱讀列印' && capabilities?.ApplicationIcon === `${FAKE_DIR}\\PDF閱讀列印.exe,0`, JSON.stringify(capabilities));
  check('install: it says it can open .pdf', readKey('PDFReaderPrint\\Capabilities\\FileAssociations')?.['.pdf'] === 'PDFReaderPrint.pdf');
  const registered = readKey('RegisteredApplications');
  check('install: it is listed with the other programs', registered?.PDFReaderPrint === `${TEST_ROOT}\\PDFReaderPrint\\Capabilities` && 'OneDrive' in registered, JSON.stringify(registered));

  run('uninstall.exe');
  check('uninstall: PDFgear still holds the .pdf setting', readKey('Classes\\.pdf')?.['(default)'] === 'PdfGear.App.1');
  const withsAfter = readKey('Classes\\.pdf\\OpenWithProgids');
  check('uninstall: gone from Open with, PDFgear stays', withsAfter && 'PdfGear.App.1' in withsAfter && !('PDFReaderPrint.pdf' in withsAfter), JSON.stringify(withsAfter));
  check('uninstall: the file type is gone', readKey('Classes\\PDFReaderPrint.pdf') === null);
  check('uninstall: gone from the Windows settings list', readKey('PDFReaderPrint') === null);
  const registeredAfter = readKey('RegisteredApplications');
  check('uninstall: other programs stay listed', registeredAfter && !('PDFReaderPrint' in registeredAfter) && 'OneDrive' in registeredAfter, JSON.stringify(registeredAfter));

  // Should something have pointed .pdf at this program, it must not stay that way.
  seed('Classes\\.pdf', '(default)', 'PDFReaderPrint.pdf');
  run('uninstall.exe');
  check('uninstall: a .pdf setting pointing here is cleared', !('(default)' in (readKey('Classes\\.pdf') ?? {})), JSON.stringify(readKey('Classes\\.pdf')));
} finally {
  removeTestKey();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
check('the test key is gone', readKey('') === null);
const realAfter = realPdfKeys();
check('the real .pdf settings did not change', realAfter === realBefore, realAfter.replace(/\r?\n/g, ' | '));
console.log(bad ? `${bad} failed` : 'all good');
process.exit(bad ? 1 : 0);
