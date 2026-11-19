const { app, BrowserWindow, WebContentsView, shell, Menu, ipcMain, session } = require('electron');
const path = require('path');
const gt = require('./google-tasks');

// ---- memory savers ----
// One renderer process per site-isolation frame is a big cost; sites and ads often embed many cross-origin frames.
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');

// Only one instance at a time
if (!app.requestSingleInstanceLock()) app.quit();

let win;
let current = null;      // the website currently on screen
let lastLeft = null;     // the website you just left for JustStudy (Forward on the JustStudy screen returns to it)
const sites = new Map(); // url -> { view, url } (kept alive so you return to where you were)

const MAX_SITES = 2;                    // websites kept in memory at once (the one on screen + the most recent other)
const SITE_IDLE_MS = 10 * 60 * 1000;    // a website left alone on the JustStudy screen this long is closed to free memory
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

/* ---------- small translucent floating Back / Forward buttons (top left of every website) ---------- */
let navView = null;
const NAV_HTML = '<!doctype html><meta charset=utf-8><style>' +
  'html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none}' +
  'body{display:flex;gap:6px;padding:4px;box-sizing:border-box}' +
  'button{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(20,20,20,.45);' +
  'color:#fff;opacity:.55;display:grid;place-items:center;padding:0;cursor:pointer;backdrop-filter:blur(6px);transition:opacity .15s,background .15s}' +
  'button:hover{opacity:1;background:rgba(20,20,20,.75)}button:disabled{opacity:.22;cursor:default}' +
  'svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}' +
  '</style><body>' +
  '<button id=b title="Back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>' +
  '<button id=f title="Forward" aria-label="Forward"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>' +
  '<script>b.onclick=()=>navApi.back();f.onclick=()=>navApi.forward();' +
  'navApi.onState(s=>{f.disabled=!s.canForward});</script>';
function ensureNav() {
  if (navView) return navView;
  navView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'nav-preload.js') } });
  navView.setBackgroundColor('#00000000');
  navView.webContents.on('did-finish-load', updateNav);
  navView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(NAV_HTML));
  return navView;
}
function updateNav() {
  if (!navView || navView.webContents.isDestroyed()) return;
  const can = !!(current && !current.view.webContents.isDestroyed() && current.view.webContents.navigationHistory.canGoForward());
  navView.webContents.send('nav:state', { canForward: can });
}
function showNav() {
  if (!win || win.isDestroyed() || !current) return;
  const v = ensureNav();
  win.contentView.addChildView(v); // added last = above the website
  v.setBounds({ x: 10, y: 10, width: 72, height: 36 });
  v.setVisible(true);
  updateNav();
}
function hideNav() { if (navView) { try { navView.setVisible(false); } catch (e) {} } }
const refocus = () => { if (current && !current.view.webContents.isDestroyed()) current.view.webContents.focus(); };
// Mouse side buttons / app-commands: de-duplicated, because Windows can report one click through both paths
let lastSide = 0;
function sideNav(dir) {
  const n = Date.now();
  if (n - lastSide < 300) return;
  lastSide = n;
  if (dir === 'back') navBack(); else navForward();
  refocus();
}
ipcMain.on('nav:side', (_, dir) => sideNav(dir === 'back' ? 'back' : 'forward'));
ipcMain.on('nav:back', () => { navBack(); refocus(); });
ipcMain.on('nav:forward', () => { navForward(); refocus(); });

/* ---------- AQI card: recolour to #0B0B0B and centre its content top/bottom ---------- */
const AQI_BASE_TOP = 52, AQI_BASE_H = 88; // the window the app cuts out of aqi.in's card (see .wx-aqi in index.html)
const AQI_MEASURE = `(() => {
  const T = ${AQI_BASE_TOP}, B = ${AQI_BASE_TOP + AQI_BASE_H}, BG = '#0B0B0B';
  const st = document.createElement('style');
  st.textContent = 'html,body{background:' + BG + '!important}';
  document.documentElement.appendChild(st);
  const W = window.innerWidth, sy = window.scrollY;
  let top = 1e9, bot = -1e9, n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const bgc = cs.backgroundColor, opaque = bgc && bgc !== 'transparent' && !/rgba\\(.*,\\s*0\\)$/.test(bgc);
    // wide opaque containers (the card itself) take the new background
    if (el.children.length && opaque && r.width > W * 0.6) { el.style.setProperty('background-color', BG, 'important'); continue; }
    let content = false;
    if (el.tagName === 'SVG' || el.tagName === 'svg') content = !el.parentElement.closest('svg');
    else if (/^(IMG|CANVAS|VIDEO)$/.test(el.tagName)) content = true;
    else if (!el.closest('svg')) {
      for (const c of el.childNodes) if (c.nodeType === 3 && c.textContent.trim()) { content = true; break; }
      if (!content && !el.children.length && (opaque || cs.backgroundImage !== 'none') && r.width < W * 0.9) content = true; // gauge bars, markers
    }
    if (!content) continue;
    const t = r.top + sy, b = r.bottom + sy;
    if (t < T - 1 || b > B + 1) continue; // header / mascot / anything outside the window is ignored
    top = Math.min(top, t); bot = Math.max(bot, b); n++;
  }
  return n ? { top, bot, n } : null;
})()`;
// Dark-grey fills inside the AQI card (the semicircle's centre) become the same #0B0B0B as the outside; the number stays.
const AQI_RECOLOR = `(() => {
  const BG = '#0B0B0B';
  const grey = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c || '');
    if (!m) return false;
    const r = +m[1], g = +m[2], b = +m[3], a = m[4] === undefined ? 1 : +m[4];
    return a > 0.05 && Math.max(r, g, b) - Math.min(r, g, b) <= 18 && Math.max(r, g, b) <= 110 && !(r === 11 && g === 11 && b === 11);
  };
  const run = () => {
    for (const el of document.querySelectorAll('body, body *')) {
      const cs = getComputedStyle(el);
      if (grey(cs.backgroundColor)) el.style.setProperty('background-color', BG, 'important');
      if (/^(path|circle|ellipse|rect)$/i.test(el.tagName) && grey(cs.fill)) {
        const r = el.getBoundingClientRect();
        if (r.width > 40) el.style.setProperty('fill', BG, 'important');
      }
    }
  };
  run();
  if (!window.__jsAqiMo) {
    window.__jsAqiMo = new MutationObserver(() => { clearTimeout(window.__jsAqiT); window.__jsAqiT = setTimeout(run, 60); });
    window.__jsAqiMo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'fill'] });
  }
})()`;
ipcMain.handle('aqi:fit', async () => {
  if (!win || win.isDestroyed()) return null;
  try {
    const frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame && /aqi\.in/i.test(f.url));
    for (const f of frames) {
      try { await f.executeJavaScript(AQI_RECOLOR); } catch (e) {}
      const r = await f.executeJavaScript(AQI_MEASURE);
      if (!r) continue;
      const gapTop = r.top - AQI_BASE_TOP, gapBot = AQI_BASE_TOP + AQI_BASE_H - r.bot;
      const p = Math.max(0, Math.min(gapTop, gapBot));          // equal space above and below the content
      const height = Math.round(r.bot - r.top + 2 * p), top = Math.round(r.top - p);
      if (height >= 30 && height <= 140) return { top, height };
    }
  } catch (e) { /* widget not ready: the app keeps its default window and asks again */ }
  return null;
});

/* ---------- 2 s transition (1 s fade to black, swap, 1 s fade back) between JustStudy and a website ---------- */
const FADE_MS = 1000; // each half; the whole fade takes 2 x FADE_MS
let curtain = null, curtainReady = null, moving = false, queued = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureCurtain() {
  if (curtainReady) return curtainReady;
  curtain = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  curtain.setBackgroundColor('#00000000');
  curtainReady = curtain.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><style>html{background:transparent}body{margin:0;height:100vh;background:#000;opacity:0;transition:opacity '+(FADE_MS/1000)+'s ease}</style><body>'));
  return curtainReady;
}
function sizeCurtain() {
  if (!curtain || !win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  curtain.setBounds({ x: 0, y: 0, width: w, height: h });
}
// No fade any more: the swap happens instantly (the curtain code above is kept but unused).
function transition(swap) {
  if (!win || win.isDestroyed()) return;
  swap();
}

function destroySite(entry) {
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view); } catch (e) {}
  try { entry.view.webContents.close(); } catch (e) {}
  sites.delete(entry.url);
  if (lastLeft === entry) lastLeft = null;
}
const audible = (e) => { try { return e.view.webContents.isCurrentlyAudible(); } catch (x) { return false; } };
// Keep at most MAX_SITES websites alive (least recently used go first; a site that is playing sound is never closed)
function trimSites() {
  const others = [...sites.values()].filter((e) => e !== current && !audible(e)).sort((a, b) => b.used - a.used);
  others.slice(Math.max(0, MAX_SITES - (current ? 1 : 0))).forEach(destroySite);
}
setInterval(() => {
  const now = Date.now();
  for (const e of [...sites.values()]) if (e !== current && now - e.used > SITE_IDLE_MS && !audible(e)) destroySite(e);
}, 60 * 1000);

function createSite(url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: SITE_PARTITION,
      preload: path.join(__dirname, 'site-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
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

  const navChanged = () => { if (current && current.view === view) updateNav(); };
  wc.on('did-navigate', navChanged);
  wc.on('did-navigate-in-page', navChanged);
  wc.on('dom-ready', () => {
    wc.insertCSS(HIDE_VSCROLL_CSS).catch(() => {});
    if (current && current.view === view) pushHud();
  });

  ensureExtensions().then(() => { if (!wc.isDestroyed()) wc.loadURL(url); }); // extensions start with the first website, not at launch
  const entry = { view, url, used: Date.now() };
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
    entry.used = Date.now();
    lastLeft = null;
    win.contentView.addChildView(entry.view);
    entry.view.setVisible(true);
    layout();
    entry.view.webContents.focus();
    startHud();
    showNav();
    trimSites();
  });
}

function goHome() {
  if (!current) return;
  transition(() => {
    stopHud();
    hideNav();
    if (current) { lastLeft = current; current.used = Date.now(); current.view.setVisible(false); current = null; }
    trimSites();
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
    fullscreen: true, // opens full-screen (F11 toggles it)
    title: 'JustStudy',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
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
    if (cmd === 'browser-backward') sideNav('back');   // does nothing on the JustStudy screen
    if (cmd === 'browser-forward') sideNav('forward'); // on the JustStudy screen: back to the website you just left
  });

  win.on('closed', () => {
    for (const { view } of sites.values()) { try { view.webContents.close(); } catch (e) {} }
    stopHud(); clearEsc(); navView = null; curtain = null; curtainReady = null; moving = false; queued = null;
    sites.clear(); current = null; lastLeft = null; win = null;
  });
}

/* ---------- Chrome extensions (unpacked folders in ./extensions, e.g. extensions/ublock) for the websites ---------- */
let extP = null;
function ensureExtensions() { return extP || (extP = loadExtensions()); }
function loadExtensions() {
  const fs = require('fs');
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'extensions') : path.join(__dirname, 'extensions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return Promise.resolve(); }
  const ses = session.fromPartition(SITE_PARTITION);
  return Promise.all(names.map((n) => {
    const full = path.join(dir, n);
    if (!fs.existsSync(path.join(full, 'manifest.json'))) return null;
    return ses.loadExtension(full, { allowFileAccess: true })
      .then((x) => console.log('Extension loaded:', x.name))
      .catch((e) => console.warn('Extension failed:', n, e && e.message));
  }));
}

app.whenReady().then(() => {
  // Private DNS (DNS-over-HTTPS) through AdGuard: blocks ad and tracker domains.
  // 'secure' = never fall back to the normal DNS. Change to 'automatic' if a network blocks DoH.
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'automatic',
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
