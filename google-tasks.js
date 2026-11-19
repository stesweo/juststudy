// Google Tasks integration (main process).
// OAuth 2.0 "Desktop app" client + PKCE + loopback redirect, official Google Tasks REST API.
// The refresh token is stored encrypted with the OS keychain (Electron safeStorage).
const { BrowserWindow, shell, safeStorage, app } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCOPE = 'https://www.googleapis.com/auth/tasks';
const API = 'https://tasks.googleapis.com/tasks/v1';
const PARTITION = 'persist:sites'; // same session as the in-app site windows (shared Google login)

// ---------- config (Client ID / secret) ----------
// Looked up in google-config.json next to main.js, then in the app's userData folder.
// For a Desktop-app client the "secret" is not truly secret, but keep it out of git anyway.
function getConfig() {
  const candidates = [
    path.join(__dirname, 'google-config.json'),
    path.join(app.getPath('userData'), 'google-config.json'),
  ];
  for (const p of candidates) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (c.clientId && c.clientSecret) return c;
    } catch {}
  }
  return null;
}

// ---------- token storage ----------
const tokenFile = () => path.join(app.getPath('userData'), 'gtoken.bin');
let accessToken = null;
let expiresAt = 0;
let memRefresh = null;

const canEncrypt = () => {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
};
function saveRefresh(t) {
  memRefresh = t;
  if (!canEncrypt()) return; // no OS keychain: keep it in memory only (sign in again next launch)
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(t), { mode: 0o600 });
}
function loadRefresh() {
  if (memRefresh) return memRefresh;
  if (!canEncrypt()) return null;
  try {
    memRefresh = safeStorage.decryptString(fs.readFileSync(tokenFile()));
    return memRefresh;
  } catch { return null; }
}
function clearRefresh() {
  memRefresh = null;
  accessToken = null;
  expiresAt = 0;
  try { fs.unlinkSync(tokenFile()); } catch {}
}

// ---------- helpers ----------
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const chromeUA = (ua) => ua.replace(/\sElectron\/\S+/i, '').replace(/\sjuststudy\/\S+/i, '');

async function tokenRequest(params) {
  const cfg = getConfig();
  if (!cfg) throw new Error('NOT_CONFIGURED');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${j.error || 'token_error'}: ${j.error_description || r.status}`);
  return j;
}

function storeTokens(t) {
  accessToken = t.access_token;
  expiresAt = Date.now() + (t.expires_in - 60) * 1000;
  if (t.refresh_token) saveRefresh(t.refresh_token);
}

// ---------- sign-in ----------
let signingIn = false;

// mode "app"     -> Google's login opens in a small JustStudy window (no default browser needed)
// mode "browser" -> Google's login opens in the system browser (fallback if Google refuses the in-app window)
async function signIn(mode = 'app') {
  const cfg = getConfig();
  if (!cfg) throw new Error('NOT_CONFIGURED');
  if (signingIn) throw new Error('Sign-in is already in progress.');
  signingIn = true;

  try {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirectUri;
    let authWin = null;

    const code = await new Promise((resolve, reject) => {
      let settled = false;
      let server;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { server.close(); } catch {}
        if (authWin && !authWin.isDestroyed()) authWin.close();
        fn(value);
      };
      const timeout = setTimeout(() => finish(reject, new Error('Sign-in timed out.')), 5 * 60 * 1000);

      server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/cb') { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><meta charset="utf-8"><title>JustStudy</title>' +
          '<body style="font:16px system-ui;background:#000;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
          '<p>Signed in. You can close this window and return to JustStudy.</p>');
        if (u.searchParams.get('state') !== state) return finish(reject, new Error('Sign-in failed (state mismatch).'));
        const c = u.searchParams.get('code');
        if (c) finish(resolve, c);
        else finish(reject, new Error(u.searchParams.get('error') || 'No authorization code received.'));
      });

      server.on('error', (e) => finish(reject, e));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}/cb`;
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: cfg.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });

        if (mode === 'browser') {
          shell.openExternal(authUrl);
          return;
        }

        authWin = new BrowserWindow({
          width: 520,
          height: 720,
          title: 'Sign in to Google',
          autoHideMenuBar: true,
          parent: BrowserWindow.getFocusedWindow() || undefined,
          webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        const wc = authWin.webContents;
        wc.setUserAgent(chromeUA(wc.getUserAgent()));
        wc.setWindowOpenHandler(({ url }) => {
          if (/^https?:/i.test(url)) wc.loadURL(url);
          return { action: 'deny' };
        });
        authWin.on('closed', () => finish(reject, new Error('Sign-in cancelled.')));
        authWin.loadURL(authUrl);
      });
    });

    storeTokens(await tokenRequest({
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }));
  } finally {
    signingIn = false;
  }
}

async function getAccessToken() {
  if (accessToken && Date.now() < expiresAt) return accessToken;
  const refresh = loadRefresh();
  if (!refresh) throw new Error('NOT_SIGNED_IN');
  try {
    storeTokens(await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' }));
  } catch (e) {
    if (/invalid_grant/.test(e.message)) { clearRefresh(); throw new Error('NOT_SIGNED_IN'); }
    throw e;
  }
  return accessToken;
}

async function signOut() {
  const refresh = loadRefresh();
  clearRefresh();
  if (refresh) {
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh), { method: 'POST' }).catch(() => {});
  }
}

// ---------- Tasks API ----------
async function api(method, p, body, retry = true) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) { accessToken = null; return api(method, p, body, false); }
  if (r.status === 204) return null;
  const text = await r.text();
  const j = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((j && j.error && j.error.message) || `Google Tasks error ${r.status}`);
  return j;
}

async function paged(basePath, extra = {}) {
  const items = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ maxResults: '100', ...extra });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await api('GET', `${basePath}?${q}`);
    items.push(...((j && j.items) || []));
    pageToken = j && j.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

const enc = (s) => encodeURIComponent(String(s));

// Only whitelisted fields ever reach Google; dates must look like YYYY-MM-DD.
function cleanFields(f = {}) {
  const o = {};
  if (typeof f === 'string') f = { title: f };
  if ('title' in f) o.title = String(f.title == null ? '' : f.title).slice(0, 1024);
  if ('notes' in f) o.notes = String(f.notes == null ? '' : f.notes).slice(0, 8192);
  if ('due' in f) {
    const m = f.due && /^(\d{4}-\d{2}-\d{2})/.exec(String(f.due));
    o.due = m ? `${m[1]}T00:00:00.000Z` : null; // the Tasks API only keeps the date part
  }
  if ('status' in f) {
    o.status = f.status === 'completed' ? 'completed' : 'needsAction';
    if (o.status === 'needsAction') o.completed = null;
  }
  return o;
}

const shape = (t) => ({
  id: t.id, title: t.title || '', notes: t.notes || '', status: t.status,
  due: t.due || null, parent: t.parent || null, position: t.position || '',
});

async function getTasks(listId) {
  const items = await paged(`/lists/${enc(listId)}/tasks`, { showCompleted: 'true', showHidden: 'true' });
  return items.map(shape).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

function addTask(listId, fields, opts = {}) {
  const q = new URLSearchParams();
  if (opts.parent) q.set('parent', String(opts.parent));
  if (opts.previous) q.set('previous', String(opts.previous));
  const qs = q.toString();
  return api('POST', `/lists/${enc(listId)}/tasks${qs ? '?' + qs : ''}`, cleanFields(fields)).then(shape);
}

// Reorder / re-parent inside one list.
function moveTask(listId, id, opts = {}) {
  const q = new URLSearchParams();
  if (opts.parent) q.set('parent', String(opts.parent));
  if (opts.previous) q.set('previous', String(opts.previous));
  const qs = q.toString();
  return api('POST', `/lists/${enc(listId)}/tasks/${enc(id)}/move${qs ? '?' + qs : ''}`);
}

// The API cannot move across lists, so copy (with sub-tasks) and delete the original.
async function moveToList(srcId, id, dstId) {
  const all = await getTasks(srcId);
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error('Task not found.');
  const copy = (x, parent) => addTask(dstId, { title: x.title, notes: x.notes, due: x.due, status: x.status }, { parent });
  const created = await copy(t);
  const map = { [t.id]: created.id };
  let prev = null;
  for (const k of all.filter((x) => x.parent === id)) {
    const c = await addTask(dstId, { title: k.title, notes: k.notes, due: k.due, status: k.status }, { parent: created.id, previous: prev });
    map[k.id] = c.id; prev = c.id;
  }
  await api('DELETE', `/lists/${enc(srcId)}/tasks/${enc(id)}`);
  return map;
}

module.exports = {
  isConfigured: () => !!getConfig(),
  isSignedIn: () => !!loadRefresh(),
  signIn,
  signOut,
  getLists: async () => (await paged('/users/@me/lists')).map((l) => ({ id: l.id, title: l.title })),
  createList: (title) => api('POST', '/users/@me/lists', { title: String(title).slice(0, 1024) || 'Untitled list' }).then((l) => ({ id: l.id, title: l.title })),
  renameList: (id, title) => api('PATCH', `/users/@me/lists/${enc(id)}`, { title: String(title).slice(0, 1024) }),
  deleteList: (id) => api('DELETE', `/users/@me/lists/${enc(id)}`),
  clearCompleted: (listId) => api('POST', `/lists/${enc(listId)}/clear`),
  getTasks,
  addTask,
  updateTask: (listId, id, fields) => api('PATCH', `/lists/${enc(listId)}/tasks/${enc(id)}`, cleanFields(fields)).then(shape),
  setDone: (listId, id, done) =>
    api('PATCH', `/lists/${enc(listId)}/tasks/${enc(id)}`, cleanFields({ status: done ? 'completed' : 'needsAction' })),
  deleteTask: (listId, id) => api('DELETE', `/lists/${enc(listId)}/tasks/${enc(id)}`),
  moveTask,
  moveToList,
};
