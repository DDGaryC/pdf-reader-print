// "最近開啟的檔案": in the file menu and on the empty start screen. The list itself is
// kept by the main program in the settings file, so every window shows the same one.

const MENU_COUNT = 6;
const START_COUNT = 8;

const baseName = (filePath) => filePath.split(/[\\/]/).pop();
const folderOf = (filePath) => filePath.replace(/[\\/][^\\/]*$/, '');

function entryButton(filePath, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.path = filePath;
  button.title = filePath;
  button.innerHTML = '<svg><use href="#i-file"/></svg>';
  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = baseName(filePath);
  button.append(name);
  return button;
}

// menu: the section in the file menu; start: the list on the empty screen.
// open(path): opens a file from the list.
export function wireRecentFiles({ menuList, menuSection, startList, startSection, clearButton, open }) {
  let paths = [];

  function render() {
    menuList.replaceChildren(...paths.slice(0, MENU_COUNT).map((filePath) => {
      const button = entryButton(filePath, 'menu-item recent-item');
      button.setAttribute('role', 'menuitem');
      return button;
    }));
    menuSection.hidden = paths.length === 0;
    startList.replaceChildren(...paths.slice(0, START_COUNT).map((filePath) => {
      const item = document.createElement('li');
      const button = entryButton(filePath, 'recent-start-item');
      const folder = document.createElement('span');
      folder.className = 'recent-folder';
      folder.textContent = folderOf(filePath);
      button.append(folder);
      item.append(button);
      return item;
    }));
    startSection.hidden = paths.length === 0;
  }

  async function reload() {
    try {
      paths = await window.api.recentFiles();
    } catch {
      paths = [];
    }
    render();
  }

  startList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-path]');
    if (button) open(button.dataset.path);
  });
  clearButton.addEventListener('click', async () => {
    await window.api.clearRecent();
    reload();
  });

  return { reload };
}
