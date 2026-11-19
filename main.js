const { app, BrowserWindow, WebContentsView, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const gt = require('./google-tasks');

// Only one instance at a time
if (!app.requestSingleInstanceLock()) app.quit();

let win;
let current = null;      // the website currently on screen
let lastLeft = null;     // the website you just left for JustStudy (Forward on the JustStudy screen returns to it)
const sites = new Map(); // url -> { view, url } (kept alive so you return to where you were)

const SITE_PARTITION = 'persist:sites'; // keeps your logins (Google, ALLEN...) between launches
const ESC_HOLD_MS = 600;                // hold Esc this long on a website to go back to JustStudy

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

/* ---------- hold Esc on a website -> back to JustStudy (a quick tap still goes to the page) ---------- */
let escTimer = null;
let escConsumed = false; // the hold already fired; swallow the key's auto-repeats until it is released
function clearEsc() { clearTimeout(escTimer); escTimer = null; }

// Shortcuts that must work whichever view has focus (main page or website)
function hookKeys(wc, isSite) {
  wc.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      if (input.type === 'keyUp') { clearEsc(); escConsumed = false; return; }
      if (input.type !== 'keyDown') return;
      if (escConsumed) { event.preventDefault(); return; }
      if (isSite && current && !escTimer && !input.isAutoRepeat) {
        escTimer = setTimeout(() => { escTimer = null; escConsumed = true; goHome(); }, ESC_HOLD_MS);
      }
      return; // taps are left alone so websites keep their own Esc behaviour
    }
    if (input.type !== 'keyDown') return;
    const plain = !input.alt && !input.control && !input.meta && !input.shift;
    if (input.key === 'F11' && plain) {
      event.preventDefault();
      if (!input.isAutoRepeat) toggleFullScreen();
      return;
    }
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!current) {
      // On the JustStudy screen: Forward (Alt+Right) goes back to the website you just left
      if (input.alt && !mod && input.key === 'ArrowRight') { event.preventDefault(); navForward(); }
      return;
    }
    if (!isSite) return;
    if (input.alt && !mod && input.key === 'ArrowLeft') { event.preventDefault(); navBack(); }
    else if (input.alt && !mod && input.key === 'ArrowRight') { event.preventDefault(); navForward(); }
    else if ((mod && !input.alt && input.key.toLowerCase() === 'r') || (plain && input.key === 'F5')) {
      event.preventDefault(); current.view.webContents.reload();
    } else if (mod && !input.alt && input.key.toLowerCase() === 'w') { event.preventDefault(); goHome(); }
  });
}

/* ---------- websites open inside the main window, edge to edge (no toolbar) ---------- */
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  if (current) current.view.setBounds({ x: 0, y: 0, width: w, height: h });
  if (moving) sizeCurtain();
}

/* ---------- click-through clock + stopwatch drawn over the website (same readout as the DVD screen) ---------- */
// Runs inside the website. It is a fixed, pointer-events:none element, so every click goes to the page below.
const HUD_FN = `(d, fonts) => {
  const ID = '__juststudy_hud';
  let el = document.getElementById(ID);
  if (!d.on) { if (el) el.remove(); return !!window.__jsf; }
  // Same fonts as the DVD screen (Fraunces / Space Grotesk), copied in from the app once per page
  if (fonts && !window.__jsf) {
    window.__jsf = true;
    for (const f of fonts) {
      try {
        const bin = atob(f.b64), u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const ff = new FontFace('JS ' + f.family, u.buffer, { weight: f.weight });
        ff.load().then(() => document.fonts.add(ff)).catch(() => {});
      } catch (e) {}
    }
  }
  if (!el || !el.isConnected) {
    el = document.createElement('div');
    el.id = ID;
    el.setAttribute('aria-hidden', 'true');
    const s = (n, css) => { const e = document.createElement('div'); for (const k in css) e.style.setProperty(k, css[k], 'important'); n.append(e); return e; };
    const SERIF = '"JS Fraunces",Fraunces,Georgia,"Times New Roman",serif', SANS = '"JS Space Grotesk","Space Grotesk",system-ui,"Segoe UI",sans-serif';
    const box = { position: 'fixed', 'z-index': '2147483647', 'pointer-events': 'none',
      'user-select': 'none', 'line-height': '1', color: '#fff', 'mix-blend-mode': 'difference',
      margin: '0', padding: '0', background: 'none', border: '0', 'font-weight': '500', 'white-space': 'nowrap' };
    for (const k in box) el.style.setProperty(k, box[k], 'important');
    s(el, { 'font-family': SERIF, 'font-weight': '600', 'font-size': '30px', 'letter-spacing': '-.01em', 'font-variant-numeric': 'tabular-nums' }).dataset.k = 'now';
    s(el, { 'font-family': SANS, 'font-weight': '500', 'font-size': '13px', 'letter-spacing': '.12em', 'text-transform': 'uppercase', margin: '12px 0 8px' }).dataset.k = 'st';
    s(el, { 'font-family': SANS, 'font-weight': '500', 'font-size': '35px', 'letter-spacing': '-.02em', 'font-variant-numeric': 'tabular-nums' }).dataset.k = 'sw';
    document.documentElement.appendChild(el);
  }
  // transparency + position (top/middle/bottom x left/centre/right)
  const P = /^[tmb][lcr]$/.test(d.pos) ? d.pos : 'bl', v = P[0], h = P[1], tf = [];
  const set = (k, val) => el.style.setProperty(k, val, 'important');
  set('opacity', String(Math.min(1, Math.max(.1, d.op))));
  set('left', h === 'l' ? '31px' : h === 'c' ? '50%' : 'auto');
  set('right', h === 'r' ? '31px' : 'auto');
  set('top', v === 't' ? '22px' : v === 'm' ? '50%' : 'auto');
  set('bottom', v === 'b' ? '22px' : 'auto');
  if (h === 'c') tf.push('translateX(-50%)');
  if (v === 'm') tf.push('translateY(-50%)');
  set('transform', tf.join(' ') || 'none');
  set('text-align', h === 'l' ? 'left' : h === 'c' ? 'center' : 'right');
  for (const k of ['now', 'st', 'sw']) { const n = el.querySelector('[data-k=' + k + ']'); if (n && n.textContent !== d[k]) n.textContent = d[k]; }
  return !!window.__jsf;
}`;

let hudTimer = null;
let fontsCache = null, fontsTried = 0;  // fonts are fetched once by the app page, then handed to each website
let fontsNeeded = true;                 // the current website page does not have them yet
async function getFonts() {
  if (fontsCache) return fontsCache;
  if (Date.now() - fontsTried < 30000) return null; // offline: retry at most every 30 s
  fontsTried = Date.now();
  try {
    const f = await win.webContents.executeJavaScript('window.__hudFonts ? window.__hudFonts() : []');
    if (Array.isArray(f) && f.length) fontsCache = f;
  } catch (e) {}
  return fontsCache;
}
async function pushHud() {
  if (!current || !win || win.isDestroyed()) return;
  const site = current.view.webContents;
  if (site.isDestroyed()) return;
  try {
    const d = await win.webContents.executeJavaScript('window.__hud && window.__hud()');
    if (d && current && current.view.webContents === site) {
      const fonts = fontsNeeded && d.on ? await getFonts() : null;
      const has = await site.executeJavaScript('(' + HUD_FN + ')(' + JSON.stringify(d) + ',' + JSON.stringify(fonts) + ')');
      fontsNeeded = !has;
    }
  } catch (e) { /* page is mid-navigation; the next tick will retry */ }
}
function startHud() { clearInterval(hudTimer); fontsNeeded = true; hudTimer = setInterval(pushHud, 1000); pushHud(); }
function stopHud() { clearInterval(hudTimer); hudTimer = null; }

/* ---------- 1 s transition (0.5 s fade to black, swap, 0.5 s fade back) between JustStudy and a website ---------- */
let curtain = null, curtainReady = null, moving = false, queued = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureCurtain() {
  if (curtainReady) return curtainReady;
  curtain = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  curtain.setBackgroundColor('#00000000');
  curtainReady = curtain.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><style>html{background:transparent}body{margin:0;height:100vh;background:#000;opacity:0;transition:opacity .5s ease}</style><body>'));
  return curtainReady;
}
function sizeCurtain() {
  if (!curtain || !win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  curtain.setBounds({ x: 0, y: 0, width: w, height: h });
}
async function transition(swap) {
  if (!win || win.isDestroyed()) return;
  if (moving) { queued = swap; return; }   // the latest request wins
  moving = true;
  let swapped = false;
  const run = () => { if (!swapped) { swapped = true; swap(); } };
  try {
    await ensureCurtain();
    sizeCurtain();
    win.contentView.addChildView(curtain);
    await curtain.webContents.executeJavaScript("document.body.style.opacity='1'");
    await sleep(500);
    run();
    win.contentView.addChildView(curtain); // keep it above the view that just appeared
    await curtain.webContents.executeJavaScript("document.body.style.opacity='0'");
    await sleep(500);
    if (win && !win.isDestroyed()) win.contentView.removeChildView(curtain);
  } catch (e) {
    run();
    try { win.contentView.removeChildView(curtain); } catch (e2) {}
  } finally {
    moving = false;
    if (queued) { const q = queued; queued = null; transition(q); }
  }
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

  // The toolbar is gone, so back / forward / reload / home live in the right-click menu (and the shortcuts)
  wc.on('context-menu', (e, params) => {
    const nav = wc.navigationHistory;
    Menu.buildFromTemplate([
      { label: 'Back', click: navBack }, // on the first page this returns to JustStudy
      { label: 'Forward', enabled: nav.canGoForward(), click: navForward },
      { label: 'Reload', click: () => wc.reload() },
      { label: 'Back to JustStudy  (hold Esc)', click: goHome },
      { type: 'separator' },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' }
    ]).popup({ window: win });
  });

  wc.on('dom-ready', () => {
    wc.insertCSS(HIDE_VSCROLL_CSS).catch(() => {});
    if (current && current.view === view) pushHud();
  });

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
  transition(() => {
    if (!win || win.isDestroyed()) return;
    const entry = sites.get(url) || createSite(url);
    if (current && current !== entry) current.view.setVisible(false);
    current = entry;
    lastLeft = null;
    win.contentView.addChildView(entry.view);
    entry.view.setVisible(true);
    layout();
    entry.view.webContents.focus();
    startHud();
  });
}

function goHome() {
  if (!current) return;
  transition(() => {
    stopHud();
    if (current) { lastLeft = current; current.view.setVisible(false); current = null; }
    if (win && !win.isDestroyed()) win.webContents.focus();
  });
}
// Back: previous page; on the first page of a website it returns to the JustStudy screen.
function navBack() {
  const wc = current && current.view.webContents;
  if (!wc) return;
  if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else goHome();
}
// Forward: next page; on the JustStudy screen it undoes the last "back to JustStudy" (the website
// is kept alive, so you land exactly where you left it).
function navForward() {
  if (!current) {
    if (lastLeft && sites.has(lastLeft.url)) openSite(lastLeft.url);
    return;
  }
  const wc = current.view.webContents;
  if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

// ---- Google Tasks (official API) ----
const str = (v) => String(v == null ? '' : v);
ipcMain.handle('gt:status', () => ({ configured: gt.isConfigured(), signedIn: gt.isSignedIn() }));
ipcMain.handle('gt:signIn', (_, mode) => gt.signIn(mode === 'browser' ? 'browser' : 'app'));
ipcMain.handle('gt:signOut', () => gt.signOut());
ipcMain.handle('gt:lists', () => gt.getLists());
ipcMain.handle('gt:tasks', (_, listId) => gt.getTasks(str(listId)));
ipcMain.handle('gt:createList', (_, title) => gt.createList(str(title)));
ipcMain.handle('gt:renameList', (_, id, title) => gt.renameList(str(id), str(title)));
ipcMain.handle('gt:deleteList', (_, id) => gt.deleteList(str(id)));
ipcMain.handle('gt:clearDone', (_, listId) => gt.clearCompleted(str(listId)));
const obj = (v) => (v && typeof v === 'object' ? v : {});
ipcMain.handle('gt:add', (_, listId, f, o) => gt.addTask(str(listId), obj(f), obj(o)));
ipcMain.handle('gt:update', (_, listId, id, f) => gt.updateTask(str(listId), str(id), obj(f)));
ipcMain.handle('gt:move', (_, listId, id, o) => gt.moveTask(str(listId), str(id), obj(o)));
ipcMain.handle('gt:moveList', (_, from, id, to) => gt.moveToList(str(from), str(id), str(to)));
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
  // The window title always stays "JustStudy" (never the page names)
  win.on('page-title-updated', (e) => e.preventDefault());
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
    if (cmd === 'browser-backward') navBack();   // does nothing on the JustStudy screen
    if (cmd === 'browser-forward') navForward(); // on the JustStudy screen: back to the website you just left
  });

  win.on('closed', () => {
    for (const { view } of sites.values()) { try { view.webContents.close(); } catch (e) {} }
    stopHud(); clearEsc(); curtain = null; curtainReady = null; moving = false; queued = null;
    sites.clear(); current = null; lastLeft = null; win = null;
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
