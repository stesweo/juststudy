const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

// Only one instance at a time
if (!app.requestSingleInstanceLock()) app.quit();

let win;
const SITE_PARTITION = 'persist:sites'; // keeps your logins (Google, ALLEN...) between launches
const siteWins = new Map();

// Present a normal Chrome user agent (some sites dislike "Electron" in it)
const chromeUA = (ua) =>
  ua.replace(/\sElectron\/\S+/i, '').replace(/\sjuststudy\/\S+/i, '');

// Open a website in its own window inside the app
function openSite(url) {
  if (!/^https?:/i.test(url)) {
    if (/^mailto:/i.test(url)) shell.openExternal(url);
    return;
  }
  const existing = siteWins.get(url);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const w = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    autoHideMenuBar: true,
    webPreferences: {
      partition: SITE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  siteWins.set(url, w);
  w.on('closed', () => siteWins.delete(url));

  const wc = w.webContents;
  wc.setUserAgent(chromeUA(wc.getUserAgent()));

  // Back / Forward / Reload (press Alt to show the menu bar)
  w.setMenu(
    Menu.buildFromTemplate([
      { label: 'Back', accelerator: 'Alt+Left', click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
      { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => w.close() }
    ])
  );
  w.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') wc.navigationHistory.goBack();
    if (cmd === 'browser-forward') wc.navigationHistory.goForward();
  });

  // Links that want a new tab just load in this same window
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) wc.loadURL(u);
    return { action: 'deny' };
  });

  w.loadURL(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'JustStudy',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // keep the study timer accurate when minimized
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // ALLEN, NEET PYQ, Google Tasks... open inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSite(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openSite(url);
    }
  });

  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
