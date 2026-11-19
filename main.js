const { app, BrowserWindow, WebContentsView, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const gt = require('./google-tasks');

// Only one instance at a time
if (!app.requestSingleInstanceLock()) app.quit();

let win;
let bar = null;          // slim toolbar shown above a website (back / forward / reload / home)
let current = null;      // the website currently on screen
const sites = new Map(); // url -> { view, url } (kept alive so you return to where you were)

const SITE_PARTITION = 'persist:sites'; // keeps your logins (Google, ALLEN...) between launches
const BAR_H = 36;

// Hides the vertical scrollbar on websites; scrolling itself keeps working.
// (scrollbar-width/-color are forced to "auto" so the ::-webkit-scrollbar rule is honoured.)
const HIDE_VSCROLL_CSS =
  '*{scrollbar-width:auto!important;scrollbar-color:auto!important}' +
  '*::-webkit-scrollbar{width:0!important}';

// Present a normal Chrome user agent (some sites dislike "Electron" in it)
const chromeUA = (ua) =>
  ua.replace(/\sElectron\/\S+/i, '').replace(/\sjuststudy\/\S+/i, '');

/* ---------- fullscreen: native window fullscreen, toggled with F11 only (Esc never leaves it) ---------- */
function toggleFullScreen() {
  if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
}

// Shortcuts that must work whichever view has focus (main page, website or toolbar)
function hookKeys(wc, isSite) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const plain = !input.alt && !input.control && !input.meta && !input.shift;
    if (input.key === 'F11' && plain) {
      event.preventDefault();
      if (!input.isAutoRepeat) toggleFullScreen();
      return;
    }
    if (!isSite || !current) return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (input.alt && !mod && input.key === 'ArrowLeft') { event.preventDefault(); navBack(); }
    else if (input.alt && !mod && input.key === 'ArrowRight') { event.preventDefault(); navForward(); }
    else if ((mod && !input.alt && input.key.toLowerCase() === 'r') || (plain && input.key === 'F5')) {
      event.preventDefault(); current.view.webContents.reload();
    } else if (mod && !input.alt && input.key.toLowerCase() === 'w') { event.preventDefault(); goHome(); }
  });
}

/* ---------- websites open inside the main window ---------- */
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  if (bar) bar.setBounds({ x: 0, y: 0, width: w, height: BAR_H });
  if (current) current.view.setBounds({ x: 0, y: BAR_H, width: w, height: Math.max(0, h - BAR_H) });
}

function ensureBar() {
  if (bar) return;
  bar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'sitebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  hookKeys(bar.webContents, false);
  bar.webContents.loadFile(path.join(__dirname, 'app', 'sitebar.html'));
}

function pushState() {
  if (!bar || bar.webContents.isDestroyed()) return;
  const wc = current && !current.view.webContents.isDestroyed() ? current.view.webContents : null;
  bar.webContents.send('site:state', wc ? {
    title: wc.getTitle() || wc.getURL(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading()
  } : null);
}

function createSite(url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: SITE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const wc = view.webContents;
  wc.setUserAgent(chromeUA(wc.getUserAgent()));
  hookKeys(wc, true);

  // Links that want a new tab just load in this same view
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) wc.loadURL(u);
    else if (/^mailto:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });

  wc.on('dom-ready', () => { wc.insertCSS(HIDE_VSCROLL_CSS).catch(() => {}); });
  ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']
    .forEach((ev) => wc.on(ev, () => { if (current && current.view === view) pushState(); }));

  wc.loadURL(url);
  const entry = { view, url };
  sites.set(url, entry);
  return entry;
}

function openSite(url) {
  if (!/^https?:/i.test(url)) {
    if (/^mailto:/i.test(url)) shell.openExternal(url);
    return;
  }
  if (!win || win.isDestroyed()) return;

  const entry = sites.get(url) || createSite(url);
  if (current && current !== entry) current.view.setVisible(false);
  current = entry;

  ensureBar();
  win.contentView.addChildView(entry.view);
  win.contentView.addChildView(bar); // toolbar stays on top
  entry.view.setVisible(true);
  bar.setVisible(true);
  layout();
  entry.view.webContents.focus();
  pushState();
}

function goHome() {
  if (current) { current.view.setVisible(false); current = null; }
  if (bar) bar.setVisible(false);
  if (win && !win.isDestroyed()) win.webContents.focus();
}
function navBack() {
  const wc = current && current.view.webContents;
  if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}
function navForward() {
  const wc = current && current.view.webContents;
  if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

// Toolbar buttons (only the toolbar itself may send these)
ipcMain.on('site:cmd', (e, cmd) => {
  if (!bar || e.sender !== bar.webContents || !current) return;
  if (cmd === 'back') navBack();
  else if (cmd === 'forward') navForward();
  else if (cmd === 'reload') current.view.webContents.reload();
  else if (cmd === 'home') goHome();
});
ipcMain.on('site:ready', (e) => { if (bar && e.sender === bar.webContents) pushState(); });

// ---- Google Tasks (official API) ----
const str = (v) => String(v == null ? '' : v);
ipcMain.handle('gt:status', () => ({ configured: gt.isConfigured(), signedIn: gt.isSignedIn() }));
ipcMain.handle('gt:signIn', (_, mode) => gt.signIn(mode === 'browser' ? 'browser' : 'app'));
ipcMain.handle('gt:signOut', () => gt.signOut());
ipcMain.handle('gt:lists', () => gt.getLists());
ipcMain.handle('gt:tasks', (_, listId) => gt.getTasks(str(listId)));
ipcMain.handle('gt:add', (_, listId, title) => gt.addTask(str(listId), str(title)));
ipcMain.handle('gt:done', (_, listId, id, done) => gt.setDone(str(listId), str(id), !!done));
ipcMain.handle('gt:delete', (_, listId, id) => gt.deleteTask(str(listId), str(id)));

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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // keep the study timer accurate when minimized
    }
  });

  hookKeys(win.webContents, false);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // ALLEN, NEET PYQ... open inside this same window (and stay fullscreen if it is)
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

  ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) =>
    win.on(ev, () => { layout(); setTimeout(layout, 120); })
  );
  win.on('app-command', (e, cmd) => {
    if (!current) return;
    if (cmd === 'browser-backward') navBack();
    if (cmd === 'browser-forward') navForward();
  });

  win.on('closed', () => {
    for (const { view } of sites.values()) { try { view.webContents.close(); } catch (e) {} }
    if (bar) { try { bar.webContents.close(); } catch (e) {} }
    sites.clear(); current = null; bar = null; win = null;
  });
}

app.whenReady().then(() => {
  // Private DNS (DNS-over-HTTPS) through AdGuard: blocks ad and tracker domains.
  // 'secure' = never fall back to the normal DNS. Change to 'automatic' if a network blocks DoH.
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'secure',
    secureDnsServers: ['https://dns.adguard.com/dns-query']
  });

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
