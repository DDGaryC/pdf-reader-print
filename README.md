# PDF閱讀列印

Windows 用的 PDF 閱讀和列印程式，介面是繁體中文。重點是把列印這件事做好：橫向頁自動轉正、一次印很多個檔案、一張紙印多頁。不做改字、簽名這類內容編輯。

## 下載安裝

到 [Releases](https://github.com/DDGaryC/pdf-reader-print/releases/latest) 下載 `PDF-Reader-Print-Setup-版本.exe`，執行後照畫面安裝。

安裝程式沒有購買數位簽章，所以下載和第一次執行時，瀏覽器和 Windows 會先擋一下。這是對所有沒簽章的新程式都會有的提醒，照下面按就可以：

- **下載時被瀏覽器擋住**
  - Edge：下載列上那個檔案旁的「…」→「保留」→「顯示更多」→「仍要保留」
  - Chrome：下載列的箭頭 →「保留」
- **執行時出現藍色的「Windows 已保護您的電腦」**：按「其他資訊」，再按「仍要執行」
- 每台電腦只有第一次安裝會遇到。之後用程式裡的「檢查更新」是程式自己下載，不經過瀏覽器，不會再被擋
- 也可以請已經有安裝檔的人用隨身碟或共用資料夾傳給你，這樣不會經過瀏覽器

之後要更新：打開程式，「檔案」→「設定」→「檢查更新」。程式平常不會自己連網路，按了才會到 GitHub 看有沒有新版。

## 功能

**閱讀**
- 多個檔案用分頁或各自的視窗開啟，縮圖欄、搜尋、縮放、旋轉檢視
- 書籤目錄、雙頁並排、最近開啟的檔案（重開時回到上次看的那頁）、文件資訊
- 左右比對兩份 PDF，標出文字不同的地方

**列印**
- 橫向頁自動轉成直向（可選逆時針或順時針），列印前可以預覽每一張紙
- 批次列印：一次印很多個檔案，照清單順序
- 一張紙印 2、4、6、9、16 頁；雙面時會算實際要用幾張紙
- 常用設定：把印表機、雙面、每張幾頁存成一組，下次一選就套用
- 有開啟密碼的檔案，輸入密碼後可以直接印

**整理檔案**
- 合併、拆分、調整頁面順序、刪除頁面、旋轉頁面、另存新檔
- 圖片（JPG、PNG）轉 PDF，手機照片會自動轉正

## 開發

需要 Node.js 和 Windows。

```
npm install
npm start            啟動程式
npm test             單元測試
npm run test:e2e     用隱藏視窗跑真正的程式，不會印出任何東西
npm run dist         做出安裝程式，放在 dist-installer
```

`renderer/vendor/pdfjs` 是從 pdfjs-dist 複製並調整過設定的檔案，用 `npm run vendor` 可以重新產生。

## 內含的其他程式

- [SumatraPDF](https://www.sumatrapdfreader.org/)（`resources/SumatraPDF.exe`）：實際送印用，GPLv3 授權，授權條款在 `resources/SumatraPDF-LICENSE.txt`
- [PDF.js](https://mozilla.github.io/pdf.js/)：顯示 PDF，Apache 2.0 授權
- [pdf-lib（@cantoo/pdf-lib）](https://github.com/cantoo-scribe/pdf-lib)：合併、拆分、旋轉等，MIT 授權
- [Electron](https://www.electronjs.org/) 和 [electron-updater](https://www.electron.build/auto-update)：MIT 授權
