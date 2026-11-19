/* Google Tasks side panel for JustStudy (talks to the main process through window.gtasks) */
(function () {
  'use strict';
  var api = window.gtasks;
  var link = document.getElementById('gtasks');
  if (!api || !link) return; // not running inside the Electron app: keep the normal link

  link.setAttribute('aria-label', 'Open Google Tasks panel');
  link.removeAttribute('target');
  link.removeAttribute('rel');

  var lists = [], listId = null, tasks = [], showDone = false, busy = false, timer = null;
  try { listId = localStorage.getItem('gtasks.list'); } catch (e) {}

  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') el.textContent = props[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
      else el.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.append(c); });
    return el;
  }
  function clean(e) {
    return String((e && e.message) || e || 'Something went wrong')
      .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  /* ---------- skeleton ---------- */
  var select = h('select', { class: 'gt-select', 'aria-label': 'Task list', onchange: function () {
    listId = select.value;
    try { localStorage.setItem('gtasks.list', listId); } catch (e) {}
    refresh();
  } });
  var input = h('input', { class: 'gt-input', type: 'text', placeholder: 'Add a task…', maxlength: '1000', 'aria-label': 'New task' });
  var status = h('div', { class: 'gt-status', role: 'status', 'aria-live': 'polite' });
  var body = h('div', { class: 'gt-body' });
  var authBox = h('div', { class: 'gt-auth' });

  var btnRefresh = h('button', { type: 'button', class: 'nbtn', title: 'Refresh', 'aria-label': 'Refresh', text: '↻', onclick: function () { refresh(); } });
  var btnOut = h('button', { type: 'button', class: 'nbtn', title: 'Sign out', onclick: function () {
    api.signOut().catch(function () {}).then(function () { lists = []; tasks = []; listId = null; showAuth(); });
  }, text: 'Sign out' });
  var btnClose = h('button', { type: 'button', class: 'nbtn', title: 'Close', 'aria-label': 'Close tasks', text: '✕', onclick: function () { toggle(false); } });

  var panel = h('aside', { class: 'gt-panel', id: 'gtPanel', role: 'dialog', 'aria-label': 'Google Tasks', 'data-view': 'main' }, [
    h('div', { class: 'gt-head' }, [h('h2', { text: 'Tasks' }), h('span', { class: 'gt-tools' }, [btnRefresh, btnOut]), btnClose]),
    h('div', { class: 'gt-main' }, [
      h('div', { class: 'gt-pick' }, [select]),
      h('div', { class: 'gt-add' }, [input, h('button', { type: 'button', class: 'nbtn', text: 'Add', onclick: add })]),
      status, body
    ]),
    authBox
  ]);
  panel.inert = true;
  document.body.append(panel);

  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('open')) toggle(false); });
  link.addEventListener('click', function (e) { e.preventDefault(); toggle(true); });

  function setStatus(msg, isErr) {
    status.textContent = msg || '';
    status.className = 'gt-status' + (isErr ? ' err' : '');
  }

  /* ---------- views ---------- */
  function showAuth(note, configured) {
    panel.dataset.view = 'auth';
    authBox.textContent = '';
    if (configured === false) {
      authBox.append(
        h('p', { text: 'Google Tasks isn\u2019t set up yet.' }),
        h('p', { class: 'gt-note', text: 'Add your Google Client ID and secret in google-config.json (see the README), then restart the app.' })
      );
      return;
    }
    var go = h('button', { type: 'button', class: 'nbtn gt-go', text: 'Sign in with Google' });
    var alt = h('button', { type: 'button', class: 'gt-alt', text: 'Sign in using my browser instead' });
    var msg = h('p', { class: 'gt-note' + (note ? ' err' : ''), text: note || '' });
    function run(mode) {
      go.disabled = true; alt.disabled = true;
      go.textContent = 'Waiting for Google\u2026';
      msg.className = 'gt-note'; msg.textContent = '';
      api.signIn(mode).then(function () {
        lists = []; tasks = []; return refresh();
      }).catch(function (e) {
        var m = clean(e);
        if (/NOT_CONFIGURED/.test(m)) return showAuth(null, false);
        showAuth(m);
      });
    }
    go.addEventListener('click', function () { run('app'); });
    alt.addEventListener('click', function () { run('browser'); });
    authBox.append(
      h('p', { text: 'Sign in to see, add and tick off your Google Tasks. They stay in sync with your phone and Gmail.' }),
      go, alt, msg
    );
  }

  function dueInfo(t) {
    if (!t.due) return null;
    var d = new Date(t.due);
    var label = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    var n = new Date();
    var today = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
    return { label: label, over: t.status !== 'completed' && t.due.slice(0, 10) < today };
  }

  function row(t, sub) {
    var done = t.status === 'completed';
    var cb = h('input', { type: 'checkbox', 'aria-label': (done ? 'Mark not done: ' : 'Mark done: ') + t.title });
    cb.checked = done;
    cb.addEventListener('change', function () {
      t.status = cb.checked ? 'completed' : 'needsAction';
      renderList();
      api.done(listId, t.id, cb.checked).catch(function (e) { var m = clean(e); refresh().then(function () { setStatus(m, true); }); });
    });
    var del = h('button', { type: 'button', class: 'gt-del', title: 'Delete', 'aria-label': 'Delete ' + t.title, text: '\u00d7', onclick: function () {
      tasks = tasks.filter(function (x) { return x.id !== t.id && x.parent !== t.id; });
      renderList();
      api.remove(listId, t.id).catch(function (e) { var m = clean(e); refresh().then(function () { setStatus(m, true); }); });
    } });
    var due = dueInfo(t);
    return h('div', { class: 'gt-row' + (done ? ' done' : '') + (sub ? ' sub' : '') }, [
      cb, h('span', { class: 't', text: t.title }),
      due ? h('span', { class: 'gt-due' + (due.over ? ' over' : ''), text: due.label }) : null,
      del
    ]);
  }

  function renderList() {
    body.textContent = '';
    var visible = tasks.filter(function (t) { return t.title && t.title.trim(); });
    var ids = {};
    visible.forEach(function (t) { ids[t.id] = true; });
    var kids = {};
    visible.forEach(function (t) { if (t.parent && ids[t.parent]) (kids[t.parent] = kids[t.parent] || []).push(t); });
    var tops = visible.filter(function (t) { return !t.parent || !ids[t.parent]; });
    var active = tops.filter(function (t) { return t.status !== 'completed'; });
    var finished = tops.filter(function (t) { return t.status === 'completed'; });

    function add(list, container) {
      list.forEach(function (t) {
        container.append(row(t, false));
        (kids[t.id] || []).forEach(function (c) { container.append(row(c, true)); });
      });
    }
    if (!active.length) body.append(h('div', { class: 'gt-empty', text: finished.length ? 'All done \ud83c\udf89' : 'No tasks yet.' }));
    add(active, body);

    if (finished.length) {
      var wrap = h('div');
      var toggleBtn = h('button', { type: 'button', class: 'gt-donebtn', 'aria-expanded': String(showDone),
        text: (showDone ? '\u25be ' : '\u25b8 ') + 'Completed (' + finished.length + ')', onclick: function () { showDone = !showDone; renderList(); } });
      body.append(toggleBtn);
      if (showDone) { add(finished, wrap); body.append(wrap); }
    }
  }

  function renderMain() {
    panel.dataset.view = 'main';
    select.textContent = '';
    lists.forEach(function (l) {
      var o = h('option', { value: l.id, text: l.title });
      if (l.id === listId) o.selected = true;
      select.append(o);
    });
    renderList();
  }

  /* ---------- actions ---------- */
  function add() {
    var title = input.value.trim();
    if (!title || !listId) return;
    input.value = '';
    setStatus('Adding\u2026');
    api.add(listId, title).then(function () { setStatus(''); return refresh(); })
      .catch(function (e) { input.value = title; setStatus(clean(e), true); });
  }

  function refresh() {
    if (busy) return Promise.resolve();
    busy = true;
    return api.status().then(function (s) {
      if (!s.configured) return showAuth(null, false);
      if (!s.signedIn) return showAuth();
      return Promise.resolve(lists.length ? lists : api.lists()).then(function (l) {
        lists = l;
        if (!lists.length) { renderMain(); return setStatus('No task lists found in this Google account.', true); }
        if (!lists.some(function (x) { return x.id === listId; })) listId = lists[0].id;
        return api.tasks(listId).then(function (t) { tasks = t; renderMain(); setStatus(''); });
      });
    }).catch(function (e) {
      var m = clean(e);
      if (/NOT_CONFIGURED/.test(m)) return showAuth(null, false);
      if (/NOT_SIGNED_IN|invalid_grant/.test(m)) return showAuth('Please sign in again.');
      if (panel.dataset.view !== 'main') renderMain();
      setStatus(m, true);
    }).then(function () { busy = false; });
  }

  function toggle(open) {
    panel.classList.toggle('open', open);
    panel.inert = !open;
    clearInterval(timer);
    if (open) {
      setStatus('');
      refresh().then(function () { if (panel.dataset.view === 'main') input.focus(); });
      timer = setInterval(function () { if (!document.hidden) refresh(); }, 90000);
    } else {
      link.focus({ preventScroll: true });
    }
  }
})();
