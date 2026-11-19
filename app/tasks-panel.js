/* Google Tasks side panel for JustStudy (talks to the main process through window.gtasks).
   Mirrors the Google Tasks web app: dated groups, inline editing (title / details / date / time / repeat),
   sub-tasks, stars, drag to reorder, move between lists, list menu (sort, rename, delete, clear completed).

   Google's public Tasks API only stores title, details, date, status, parent and order. So that you still
   get the rest, the TIME, REPEAT and STAR of a task are kept in this app (localStorage) and are not synced
   to your phone / Gmail. Repeating tasks create their next copy when you tick one off. */
(function () {
  'use strict';
  var api = window.gtasks;
  var link = document.getElementById('gtasks');
  if (!api || !link) return; // not running inside the Electron app: keep the normal link

  link.setAttribute('aria-label', 'Open Google Tasks panel');
  link.removeAttribute('target');
  link.removeAttribute('rel');

  var STARRED = '__starred';
  var lists = [], listId = null, tasks = [], showDone = false, busy = false, timer = null;
  var sortMode = 'date';          // 'date' | 'order'
  var ed = null;                  // the open inline editor
  var menuEl = null, menuAnchor = null, modalEl = null, dragId = null;
  var meta = {};                  // taskId -> { s:1 star, tm:'HH:MM', rp:'daily|weekly|monthly|yearly' }
  try { listId = localStorage.getItem('gtasks.list'); } catch (e) {}
  try { sortMode = localStorage.getItem('gtasks.sort') === 'order' ? 'order' : 'date'; } catch (e) {}
  try { meta = JSON.parse(localStorage.getItem('gtasks.meta') || '{}') || {}; } catch (e) { meta = {}; }

  /* ---------- tiny helpers ---------- */
  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') el.textContent = props[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null) el.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.append(c); });
    return el;
  }
  // Static, hard-coded SVG icons only (never user text)
  var ICON = {
    star: '<path d="M12 3.6l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z"/>',
    dots: '<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h11l-3-3M20 13v2a3 3 0 0 1-3 3H6l3 3"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    sub: '<path d="M6 4v8a3 3 0 0 0 3 3h10m-4-4l4 4-4 4"/>',
    trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chev: '<path d="M7 10l5 5 5-5"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    note: '<path d="M5 7h14M5 12h14M5 17h9"/>',
    list: '<path d="M4 6h10M4 12h10M4 18h6M17 14v6m-3-3h6"/>',
    star2: '<path d="M12 3.6l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z"/>'
  };
  function icon(name, size, fill) {
    var s = h('span', { class: 'gt-ic', 'aria-hidden': 'true' });
    s.innerHTML = '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>';
    return s;
  }
  function clean(e) {
    return String((e && e.message) || e || 'Something went wrong')
      .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }
  function saveMeta() { try { localStorage.setItem('gtasks.meta', JSON.stringify(meta)); } catch (e) {} }
  function getMeta(id) { return meta[id] || {}; }
  function setMeta(id, m) { if (m && (m.s || m.tm || m.rp)) meta[id] = m; else delete meta[id]; saveMeta(); }

  /* ---------- dates (all local-calendar, as "YYYY-MM-DD") ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function todayStr() { return ymd(new Date()); }
  function plusDays(s, n) { var d = parseDay(s); d.setDate(d.getDate() + n); return ymd(d); }
  function dueDay(t) { return t.due ? t.due.slice(0, 10) : null; }
  function dayLabel(s, long) {
    var td = todayStr();
    if (s === td) return 'Today';
    if (s === plusDays(td, 1)) return 'Tomorrow';
    if (s === plusDays(td, -1)) return 'Yesterday';
    var d = parseDay(s), opt = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opt.year = 'numeric';
    return d.toLocaleDateString(undefined, long ? opt : { day: 'numeric', month: 'short' });
  }
  function addMonths(s, n) {
    var d = parseDay(s), day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return ymd(d);
  }
  function nextDue(due, rp) {
    var d = due || todayStr(), t = todayStr(), guard = 0;
    do {
      d = rp === 'daily' ? plusDays(d, 1) : rp === 'weekly' ? plusDays(d, 7) : rp === 'monthly' ? addMonths(d, 1) : addMonths(d, 12);
    } while (d < t && ++guard < 4000);
    return d;
  }
  var REPEATS = [['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];

  /* ---------- skeleton ---------- */
  var titleBtn = h('button', { type: 'button', class: 'gt-title', 'aria-haspopup': 'menu', onclick: function () { openListSwitcher(); } });
  var moreBtn = h('button', { type: 'button', class: 'gt-icon', title: 'List options', 'aria-label': 'List options', onclick: function () { openListMenu(); } }, [icon('dots')]);
  var btnClose = h('button', { type: 'button', class: 'gt-icon', title: 'Close', 'aria-label': 'Close tasks', onclick: function () { toggle(false); } }, [icon('x')]);
  var addSlot = h('div', { class: 'gt-addslot' });
  var status = h('div', { class: 'gt-status', role: 'status', 'aria-live': 'polite' });
  var body = h('div', { class: 'gt-body' });
  var authBox = h('div', { class: 'gt-auth' });

  var panel = h('aside', { class: 'gt-panel', id: 'gtPanel', role: 'dialog', 'aria-label': 'Google Tasks', 'data-view': 'main' }, [
    h('div', { class: 'gt-head' }, [titleBtn, moreBtn, btnClose]),
    h('div', { class: 'gt-main' }, [addSlot, status, body]),
    authBox
  ]);
  panel.inert = true;
  document.body.append(panel);

  link.addEventListener('click', function (e) { e.preventDefault(); toggle(true); });

  // Esc peels one layer at a time: dialog -> menu -> editor -> panel
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !panel.classList.contains('open')) return;
    e.stopPropagation();
    if (modalEl) closeModal();
    else if (menuEl) closeMenu();
    else if (ed) closeEditor(true);
    else toggle(false);
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (!panel.classList.contains('open')) return;
    var t = e.target;
    if (menuEl && !menuEl.contains(t) && !(menuAnchor && menuAnchor.contains(t))) closeMenu();
  }, true);
  // Clicking away from the open editor saves it. Done on "click" (not mousedown) so the click that
  // landed on another row / button is not lost when the list is rebuilt.
  document.addEventListener('click', function (e) {
    if (!panel.classList.contains('open') || !ed || modalEl || menuEl) return;
    var t = e.target;
    if (ed.el && ed.el.contains(t) || !t.isConnected || !panel.contains(t)) return;
    closeEditor(true);
  }, true);

  function setStatus(msg, isErr) {
    status.textContent = msg || '';
    status.className = 'gt-status' + (isErr ? ' err' : '');
  }
  function fail(e) {
    var m = clean(e);
    refresh().then(function () { setStatus(m, true); });
  }

  /* ---------- popup menu ---------- */
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null; menuAnchor = null;
  }
  // items: { label, icon, checked, danger, sep, header, onClick }
  function openMenu(anchor, items) {
    var same = menuAnchor === anchor;
    closeMenu();
    if (same) return;
    var m = h('div', { class: 'gt-menu', role: 'menu' });
    items.forEach(function (it) {
      if (it.sep) return m.append(h('div', { class: 'gt-sep' }));
      if (it.header) return m.append(h('div', { class: 'gt-mh', text: it.header }));
      var b = h('button', { type: 'button', role: 'menuitem', class: 'gt-mi' + (it.danger ? ' danger' : ''), onclick: function () { closeMenu(); it.onClick && it.onClick(); } }, [
        it.checked ? icon('check', 16) : (it.icon ? icon(it.icon, 16) : h('span', { class: 'gt-ic', style: 'width:16px' })),
        h('span', { text: it.label })
      ]);
      m.append(b);
    });
    panel.append(m);
    var pr = panel.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    var left = Math.max(8, Math.min(ar.right - pr.left - m.offsetWidth, pr.width - m.offsetWidth - 8));
    var top = ar.bottom - pr.top + 2;
    if (top + m.offsetHeight > pr.height - 8) top = Math.max(8, ar.top - pr.top - m.offsetHeight - 2);
    m.style.left = left + 'px';
    m.style.top = top + 'px';
    menuEl = m; menuAnchor = anchor;
    var first = m.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }

  /* ---------- modal dialogs (confirm / ask for text) ---------- */
  function closeModal() { if (modalEl) modalEl.remove(); modalEl = null; }
  function openModal(card, onCancel) {
    closeMenu(); closeModal();
    var back = h('div', { class: 'gt-modal', onmousedown: function (e) { if (e.target === back) { closeModal(); onCancel && onCancel(); } } }, [card]);
    panel.append(back);
    modalEl = back;
    return back;
  }
  function dialog(o, cb) {
    var input = o.input != null ? h('input', { class: 'gt-input', type: 'text', maxlength: '200', value: o.input, 'aria-label': o.title }) : null;
    function ok() {
      var v = input ? input.value.trim() : true;
      if (input && !v) return;
      closeModal(); cb(v);
    }
    var okBtn = h('button', { type: 'button', class: 'gt-pill primary' + (o.danger ? ' danger' : ''), text: o.ok || 'OK', onclick: ok });
    var card = h('div', { class: 'gt-card', role: 'dialog', 'aria-label': o.title }, [
      h('h3', { text: o.title }),
      o.text ? h('p', { text: o.text }) : null,
      input,
      h('div', { class: 'gt-actions' }, [h('button', { type: 'button', class: 'gt-pill', text: 'Cancel', onclick: closeModal }), okBtn])
    ]);
    openModal(card);
    if (input) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); });
      input.focus(); input.select();
    } else okBtn.focus();
  }

  /* ---------- date / time / repeat picker ---------- */
  function openPicker(init, cb) {
    var st = { due: init.due || null, time: init.time || '', repeat: init.repeat || '' };
    var base = st.due ? parseDay(st.due) : new Date();
    var vy = base.getFullYear(), vm = base.getMonth();
    var grid = h('div', { class: 'gt-grid' });
    var month = h('div', { class: 'gt-month' });
    var timeIn = h('input', { class: 'gt-time', type: 'text', placeholder: 'Set time', value: st.time, maxlength: '5', autocomplete: 'off', 'aria-label': 'Time' });
    var slots = h('div', { class: 'gt-slots', hidden: '' });
    var err = h('div', { class: 'gt-note err' });
    var rep = h('select', { class: 'gt-select', 'aria-label': 'Repeat' }, REPEATS.map(function (r) { return h('option', { value: r[0], text: r[1] }); }));
    rep.value = st.repeat;
    var tstr = todayStr();

    function draw() {
      month.textContent = new Date(vy, vm, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      grid.textContent = '';
      'MTWTFSS'.split('').forEach(function (c, i) { grid.append(h('span', { class: 'gt-dow', text: c, 'aria-hidden': 'true' })); });
      var first = new Date(vy, vm, 1), off = (first.getDay() + 6) % 7;
      for (var i = 0; i < 42; i++) {
        (function (d) {
          var s = ymd(d);
          var cls = 'gt-day' + (d.getMonth() !== vm ? ' out' : '') + (s === tstr ? ' today' : '') + (s === st.due ? ' sel' : '');
          grid.append(h('button', { type: 'button', class: cls, text: String(d.getDate()), 'aria-label': d.toDateString(), 'aria-pressed': String(s === st.due), onclick: function () {
            st.due = st.due === s ? null : s;
            if (d.getMonth() !== vm) { vy = d.getFullYear(); vm = d.getMonth(); }
            draw();
          } }));
        })(new Date(vy, vm, 1 - off + i));
      }
    }
    function nav(n) { var d = new Date(vy, vm + n, 1); vy = d.getFullYear(); vm = d.getMonth(); draw(); }
    for (var m = 0; m < 48; m++) (function (v) {
      slots.append(h('button', { type: 'button', class: 'gt-slot', text: v, onmousedown: function (e) { e.preventDefault(); }, onclick: function () { timeIn.value = v; slots.hidden = true; } }));
    })(pad(Math.floor(m / 2)) + ':' + (m % 2 ? '30' : '00'));
    timeIn.addEventListener('focus', function () {
      slots.hidden = false;
      var cur = null; [].forEach.call(slots.children, function (b) { if (b.textContent === timeIn.value) cur = b; });
      (cur || slots.children[18]).scrollIntoView({ block: 'center' });
    });
    timeIn.addEventListener('blur', function () { setTimeout(function () { slots.hidden = true; }, 120); });
    timeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); slots.hidden = true; } });

    function done() {
      var tv = timeIn.value.trim(), mt = /^(\d{1,2}):?(\d{2})$/.exec(tv);
      if (tv && (!mt || +mt[1] > 23 || +mt[2] > 59)) { err.textContent = 'Enter a time like 09:30'; timeIn.focus(); return; }
      st.time = tv ? pad(+mt[1]) + ':' + mt[2] : '';
      st.repeat = rep.value;
      if ((st.time || st.repeat) && !st.due) st.due = tstr;
      closeModal(); cb(st);
    }
    var card = h('div', { class: 'gt-card gt-picker', role: 'dialog', 'aria-label': 'Date and time' }, [
      h('div', { class: 'gt-pickhead' }, [month,
        h('button', { type: 'button', class: 'gt-icon', 'aria-label': 'Previous month', onclick: function () { nav(-1); } }, [icon('left')]),
        h('button', { type: 'button', class: 'gt-icon', 'aria-label': 'Next month', onclick: function () { nav(1); } }, [icon('right')])]),
      grid,
      h('div', { class: 'gt-prow' }, [icon('clock'), h('div', { class: 'gt-timewrap' }, [timeIn, slots])]),
      h('div', { class: 'gt-prow' }, [icon('repeat'), rep]),
      err,
      h('div', { class: 'gt-actions' }, [
        st.due || st.time || st.repeat ? h('button', { type: 'button', class: 'gt-pill ghost', text: 'Clear', onclick: function () { closeModal(); cb({ due: null, time: '', repeat: '' }); } }) : null,
        h('button', { type: 'button', class: 'gt-pill', text: 'Cancel', onclick: closeModal }),
        h('button', { type: 'button', class: 'gt-pill primary', text: 'Done', onclick: done })
      ])
    ]);
    draw();
    openModal(card);
  }

  /* ---------- auth view ---------- */
  function showAuth(note, configured) {
    closeEditor(false); closeMenu(); closeModal();
    panel.dataset.view = 'auth';
    authBox.textContent = '';
    if (configured === false) {
      authBox.append(
        h('p', { text: 'Google Tasks isn’t set up yet.' }),
        h('p', { class: 'gt-note', text: 'Add your Google Client ID and secret in google-config.json (see the README), then restart the app.' })
      );
      return;
    }
    var go = h('button', { type: 'button', class: 'gt-pill primary gt-go', text: 'Sign in with Google' });
    var alt = h('button', { type: 'button', class: 'gt-alt', text: 'Sign in using my browser instead' });
    var msg = h('p', { class: 'gt-note' + (note ? ' err' : ''), text: note || '' });
    function run(mode) {
      go.disabled = true; alt.disabled = true;
      go.textContent = 'Waiting for Google…';
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

  /* ---------- data helpers ---------- */
  function find(id) { for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i]; return null; }
  function listTitle(id) { for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return lists[i].title; return ''; }
  function isStarredView() { return listId === STARRED; }

  function chipText(t, grouped) {
    var m = getMeta(t.id), d = dueDay(t), parts = [];
    if (d && (!grouped || d < todayStr())) parts.push(dayLabel(d));
    if (m.tm) parts.push(m.tm);
    return parts.join(', ');
  }

  /* ---------- row ---------- */
  function circle(t, done) {
    var b = h('button', { type: 'button', class: 'gt-chk' + (done ? ' on' : ''), role: 'checkbox', 'aria-checked': String(done),
      title: done ? 'Mark not completed' : 'Mark completed', 'aria-label': (done ? 'Mark not completed: ' : 'Mark completed: ') + (t.title || 'task'),
      onclick: function (e) { e.stopPropagation(); setDone(t, !done); } }, [done ? icon('check', 13) : null]);
    return b;
  }

  function row(t, o) {
    o = o || {};
    var done = t.status === 'completed', m = getMeta(t.id);
    var chip = chipText(t, o.grouped), over = !done && dueDay(t) && dueDay(t) < todayStr();
    var star = h('button', { type: 'button', class: 'gt-icon gt-star' + (m.s ? ' on' : ''), title: m.s ? 'Remove from starred' : 'Add to starred',
      'aria-label': m.s ? 'Remove from starred' : 'Add to starred', 'aria-pressed': String(!!m.s), onclick: function (e) { e.stopPropagation(); toggleStar(t); } }, [icon('star', 17, m.s)]);
    var more = h('button', { type: 'button', class: 'gt-icon gt-more', title: 'Task options', 'aria-label': 'Task options', 'aria-haspopup': 'menu',
      onclick: function (e) { e.stopPropagation(); openTaskMenu(t, more); } }, [icon('dots')]);
    var main = h('div', { class: 'gt-rmain' }, [
      h('div', { class: 't' + (t.title ? '' : ' empty'), text: t.title || 'Untitled' }),
      t.notes ? h('div', { class: 'gt-notes', text: t.notes.split('\n')[0] }) : null,
      chip || m.rp || isStarredView() ? h('div', { class: 'gt-chips' }, [
        chip ? h('span', { class: 'gt-chip' + (over ? ' over' : '') }, [icon('clock', 13), h('span', { text: chip })]) : null,
        m.rp ? h('span', { class: 'gt-chip' }, [icon('repeat', 13), h('span', { text: m.rp })]) : null,
        isStarredView() ? h('span', { class: 'gt-chip list', text: listTitle(t.listId) }) : null
      ]) : null
    ]);
    var el = h('div', { class: 'gt-row' + (done ? ' done' : '') + (t.parent ? ' sub' : ''), 'data-id': t.id,
      'data-scope': (t.parent || '') + '|' + (o.group || '') }, [circle(t, done), main, more, star]);
    el.addEventListener('click', function (e) { if (!e.target.closest('button')) openEditor(t.id); });

    if (!isStarredView() && !done && !ed) {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) {
        dragId = t.id; el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id);
      });
      el.addEventListener('dragend', function () { dragId = null; el.classList.remove('dragging'); clearDrop(); });
      el.addEventListener('dragover', function (e) {
        var d = dragId && find(dragId);
        if (!d || d.id === t.id || el.dataset.scope !== scopeOf(d, el)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        var r = el.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        clearDrop(); el.classList.add(after ? 'drop-after' : 'drop-before');
      });
      el.addEventListener('drop', function (e) {
        var d = dragId && find(dragId);
        if (!d || d.id === t.id || el.dataset.scope !== scopeOf(d, el)) return;
        e.preventDefault();
        var r = el.getBoundingClientRect();
        dropTask(d, t, e.clientY > r.top + r.height / 2);
      });
    }
    return el;
  }
  function scopeOf(d, el) { var src = body.querySelector('[data-id="' + CSS.escape(d.id) + '"]'); return src ? src.dataset.scope : null; }
  function clearDrop() { [].forEach.call(body.querySelectorAll('.drop-before,.drop-after'), function (n) { n.classList.remove('drop-before', 'drop-after'); }); }

  function dropTask(d, target, after) {
    var sibs = tasks.filter(function (x) { return (x.parent || null) === (d.parent || null) && x.id !== d.id; });
    var ti = sibs.indexOf(target), prevId = null, prevT = null;
    if (after) prevT = target; else if (ti > 0) prevT = sibs[ti - 1];
    prevId = prevT ? prevT.id : null;
    tasks.splice(tasks.indexOf(d), 1);
    var at = prevT ? tasks.indexOf(prevT) + 1 : tasks.indexOf(sibs[0]);
    tasks.splice(at < 0 ? 0 : at, 0, d);
    dragId = null; renderList();
    api.move(d.listId, d.id, { parent: d.parent || undefined, previous: prevId || undefined }).catch(fail);
  }

  /* ---------- list rendering ---------- */
  function renderList() {
    body.textContent = '';
    var ids = {};
    tasks.forEach(function (t) { ids[t.id] = true; });
    var kids = {};
    tasks.forEach(function (t) { if (t.parent && ids[t.parent]) (kids[t.parent] = kids[t.parent] || []).push(t); });
    var tops = tasks.filter(function (t) { return !t.parent || !ids[t.parent]; });
    var starView = isStarredView();
    if (starView) tops = tasks.filter(function (t) { return getMeta(t.id).s; });
    var active = tops.filter(function (t) { return t.status !== 'completed'; });
    var finished = tops.filter(function (t) { return t.status === 'completed'; });
    var grouped = sortMode === 'date' && !starView;

    function put(t, container, o) {
      if (ed && ed.mode === 'edit' && ed.id === t.id) { container.append(editorEl(t)); }
      else container.append(row(t, o));
      (kids[t.id] || []).forEach(function (c) {
        if (ed && ed.mode === 'edit' && ed.id === c.id) container.append(editorEl(c));
        else container.append(row(c, { grouped: grouped, group: o.group }));
      });
      if (ed && ed.mode === 'sub' && ed.parent === t.id) container.append(editorEl(null));
    }

    if (!active.length && !(ed && ed.mode === 'new')) {
      body.append(h('div', { class: 'gt-empty', text: finished.length ? 'All tasks completed 🎉' : starView ? 'No starred tasks.' : 'No tasks yet.' }));
    }
    if (grouped) {
      var td = todayStr(), tm = plusDays(td, 1), groups = {}, order = [];
      active.forEach(function (t) {
        var d = dueDay(t), k = !d ? 'zz-none' : d < td ? '0-over' : d;
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(t);
      });
      order.sort();
      order.forEach(function (k) {
        var label = k === 'zz-none' ? 'No date' : k === '0-over' ? 'Overdue' : dayLabel(k, true);
        body.append(h('div', { class: 'gt-group' + (k === td || k === '0-over' ? ' hot' : '') + (k === '0-over' ? ' over' : ''), text: label }));
        groups[k].forEach(function (t) { put(t, body, { grouped: true, group: k }); });
      });
    } else {
      active.forEach(function (t) { put(t, body, { grouped: false, group: '' }); });
    }

    if (finished.length) {
      body.append(h('button', { type: 'button', class: 'gt-donebtn', 'aria-expanded': String(showDone), onclick: function () { showDone = !showDone; renderList(); } }, [
        icon('chev', 16), h('span', { text: 'Completed (' + finished.length + ')' })
      ]));
      if (showDone) finished.forEach(function (t) { put(t, body, { grouped: false, group: 'done' }); });
    }
  }

  function renderAdd() {
    addSlot.textContent = '';
    if (isStarredView()) return;
    if (ed && ed.mode === 'new') { addSlot.append(editorEl(null)); return; }
    addSlot.append(h('button', { type: 'button', class: 'gt-addtask', onclick: function () { openEditor('new'); } }, [icon('plus', 18), h('span', { text: 'Add a task' })]));
  }

  function renderMain() {
    panel.dataset.view = 'main';
    titleBtn.textContent = '';
    titleBtn.append(h('span', { text: isStarredView() ? 'Starred' : (listTitle(listId) || 'Tasks') }), icon('chev', 16));
    renderAdd();
    renderList();
  }
  function fullRender() { renderMain(); }

  /* ---------- inline editor (new task / edit task / new sub-task) ---------- */
  function openEditor(which) {
    if (ed) closeEditor(true);
    closeMenu();
    if (which === 'new') ed = { mode: 'new', draft: { title: '', notes: '', due: null, time: '', repeat: '' } };
    else if (typeof which === 'string' && which.indexOf('sub:') === 0) ed = { mode: 'sub', parent: which.slice(4), draft: { title: '', notes: '', due: null, time: '', repeat: '' } };
    else {
      var t = find(which); if (!t) return;
      var m = getMeta(t.id);
      ed = { mode: 'edit', id: t.id, draft: { title: t.title, notes: t.notes, due: dueDay(t), time: m.tm || '', repeat: m.rp || '' } };
    }
    fullRender();
    if (ed && ed.titleIn) ed.titleIn.focus();
  }

  // Saves (or discards) what is typed, then removes the editor. rerender=false when the view is rebuilt anyway.
  function closeEditor(rerender) {
    if (!ed) return;
    var e = ed;
    ed = null;
    if (e.titleIn) {
      var title = e.titleIn.value.trim(), notes = e.notesIn.value.replace(/\s+$/, '');
      if (e.mode === 'edit') {
        var t = find(e.id);
        if (t && !isTmp(t)) {
          var patch = {};
          if (e.titleIn.value !== t.title) patch.title = e.titleIn.value;
          if (notes !== t.notes) patch.notes = notes;
          if (Object.keys(patch).length) { Object.assign(t, patch); api.update(t.listId, t.id, patch).catch(fail); }
        }
      } else if (title) {
        e.draft.title = title; e.draft.notes = notes;
        createTask(e.draft, e.mode === 'sub' ? e.parent : null);
      }
    }
    if (rerender) fullRender();
  }

  function stateOf(d) { return { due: d.due, time: d.time, repeat: d.repeat }; }

  function editorEl(t) {
    var e = ed, d = e.draft;
    var titleIn = h('input', { class: 'gt-etitle', type: 'text', placeholder: 'Title', maxlength: '1024', value: d.title, 'aria-label': 'Title' });
    var notesIn = h('textarea', { class: 'gt-enotes', placeholder: 'Details', rows: '1', 'aria-label': 'Details' });
    notesIn.value = d.notes;
    titleIn.addEventListener('input', function () { d.title = titleIn.value; });
    notesIn.addEventListener('input', function () { d.notes = notesIn.value; });
    function grow() { notesIn.style.height = 'auto'; notesIn.style.height = Math.min(notesIn.scrollHeight, 160) + 'px'; }
    notesIn.addEventListener('input', grow);
    titleIn.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); closeEditor(true); }
    });
    notesIn.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); closeEditor(true); }
    });
    var chipBox = h('div', { class: 'gt-echips' });

    function apply(s) {
      d.due = s.due; d.time = s.time; d.repeat = s.repeat;
      if (e.mode === 'edit') applyState(find(e.id), s);
      fillChips();
    }
    function openPick() { openPicker(stateOf(d), apply); }
    function chipBtn(label, ic, onclick, onx) {
      var c = h('span', { class: 'gt-chip pick' }, [
        h('button', { type: 'button', class: 'gt-chipbtn', onclick: onclick }, [ic ? icon(ic, 13) : null, h('span', { text: label })]),
        onx ? h('button', { type: 'button', class: 'gt-chipx', 'aria-label': 'Remove', onclick: onx }, [icon('x', 12)]) : null
      ]);
      return c;
    }
    function fillChips() {
      chipBox.textContent = '';
      if (d.due) chipBox.append(chipBtn(dayLabel(d.due, true), 'clock', openPick, function () { apply({ due: null, time: '', repeat: '' }); }));
      if (d.time) chipBox.append(chipBtn(d.time, null, openPick, function () { apply({ due: d.due, time: '', repeat: d.repeat }); }));
      if (!d.due) {
        chipBox.append(
          h('button', { type: 'button', class: 'gt-qchip', text: 'Today', onclick: function () { apply({ due: todayStr(), time: d.time, repeat: d.repeat }); } }),
          h('button', { type: 'button', class: 'gt-qchip', text: 'Tomorrow', onclick: function () { apply({ due: plusDays(todayStr(), 1), time: d.time, repeat: d.repeat }); } }),
          h('button', { type: 'button', class: 'gt-qchip icon', title: 'Pick date and time', 'aria-label': 'Pick date and time', onclick: openPick }, [icon('clock', 15)])
        );
      }
      rep.className = 'gt-icon gt-rep' + (d.repeat ? ' on' : '');
      rep.title = d.repeat ? 'Repeats ' + d.repeat : 'Repeat';
    }
    var rep = h('button', { type: 'button', class: 'gt-icon gt-rep', 'aria-label': 'Repeat', onclick: openPick }, [icon('repeat', 17)]);
    fillChips();

    var star = null;
    var more = null;
    if (e.mode === 'edit') more = h('button', { type: 'button', class: 'gt-icon', title: 'Task options', 'aria-label': 'Task options', onclick: function () { openTaskMenu(find(e.id), more); } }, [icon('dots')]);
    var lead = e.mode === 'edit' ? circle(t, t.status === 'completed') : h('span', { class: 'gt-chk ghost', 'aria-hidden': 'true' });
    var el = h('div', { class: 'gt-edit' + (e.mode === 'sub' || (t && t.parent) ? ' sub' : '') }, [
      h('div', { class: 'gt-erow' }, [lead, titleIn, more]),
      h('div', { class: 'gt-erow notes' }, [icon('note', 16), notesIn]),
      h('div', { class: 'gt-erow foot' }, [chipBox, rep]),
      e.mode === 'edit' ? null : h('div', { class: 'gt-actions tight' }, [
        h('button', { type: 'button', class: 'gt-pill', text: 'Cancel', onclick: function () { titleIn.value = ''; notesIn.value = ''; closeEditor(true); } }),
        h('button', { type: 'button', class: 'gt-pill primary', text: e.mode === 'sub' ? 'Add subtask' : 'Add', onclick: function () { closeEditor(true); } })
      ])
    ]);
    e.el = el; e.titleIn = titleIn; e.notesIn = notesIn;
    setTimeout(grow, 0);
    return el;
  }

  /* ---------- task actions ---------- */
  function applyState(t, s) {
    if (!t) return;
    var m = getMeta(t.id), n = { s: m.s, tm: s.time || undefined, rp: s.repeat || undefined };
    setMeta(t.id, n);
    var nd = s.due || null;
    if (nd !== dueDay(t)) {
      t.due = nd ? nd + 'T00:00:00.000Z' : null;
      api.update(t.listId, t.id, { due: nd }).catch(fail);
    }
  }

  function createTask(draft, parent) {
    if (isStarredView() || !listId) return;
    var lid = listId;
    var due = draft.due || ((draft.time || draft.repeat) ? todayStr() : null);
    var tmp = { id: 'tmp' + Date.now() + Math.random(), listId: lid, title: draft.title, notes: draft.notes, status: 'needsAction',
      due: due ? due + 'T00:00:00.000Z' : null, parent: parent || null, position: '' };
    var at = parent ? tasks.indexOf(find(parent)) + 1 : 0;
    tasks.splice(at, 0, tmp);
    renderList();
    api.add(lid, { title: draft.title, notes: draft.notes, due: due }, { parent: parent || undefined }).then(function (c) {
      tmp.id = c.id; tmp.position = c.position;
      if (draft.time || draft.repeat) setMeta(c.id, { tm: draft.time || undefined, rp: draft.repeat || undefined });
      if (!ed) renderList();
    }).catch(function (e) {
      tasks = tasks.filter(function (x) { return x !== tmp; });
      renderList(); setStatus(clean(e), true);
    });
  }

  function setDone(t, done) {
    if (isTmp(t)) return setStatus('Saving\u2026');
    var wasDone = t.status === 'completed';
    t.status = done ? 'completed' : 'needsAction';
    var m = getMeta(t.id);
    var repeatNow = done && !wasDone && m.rp && !isTmp(t);
    fullRender();
    api.done(t.listId, t.id, done).then(function () {
      if (!repeatNow) return;
      var due = nextDue(dueDay(t), m.rp);
      return api.add(t.listId, { title: t.title, notes: t.notes, due: due }).then(function (c) {
        setMeta(c.id, { s: m.s, tm: m.tm, rp: m.rp });
        if (listId === t.listId || isStarredView()) {
          tasks.unshift({ id: c.id, listId: t.listId, title: c.title, notes: c.notes, status: 'needsAction', due: c.due, parent: null, position: c.position });
          if (!ed) renderList();
        }
        setStatus('Repeats ' + dayLabel(due, true));
      });
    }).catch(fail);
  }
  function isTmp(t) { return String(t.id).indexOf('tmp') === 0; }

  function toggleStar(t) {
    var m = getMeta(t.id);
    setMeta(t.id, { s: m.s ? undefined : 1, tm: m.tm, rp: m.rp });
    renderList();
  }

  function removeTask(t) {
    tasks = tasks.filter(function (x) { return x.id !== t.id && x.parent !== t.id; });
    setMeta(t.id, null);
    if (ed && ed.id === t.id) ed = null;
    fullRender();
    api.remove(t.listId, t.id).catch(fail);
  }

  function moveTo(t, dstId) {
    if (dstId === t.listId) return;
    var src = t.listId, kids = tasks.filter(function (x) { return x.parent === t.id; });
    tasks = tasks.filter(function (x) { return x.id !== t.id && x.parent !== t.id; });
    if (ed && ed.id === t.id) ed = null;
    fullRender();
    setStatus('Moving to ' + listTitle(dstId) + '…');
    api.moveToList(src, t.id, dstId).then(function (map) {
      Object.keys(map).forEach(function (oldId) {
        var m = meta[oldId];
        if (m) { setMeta(map[oldId], m); setMeta(oldId, null); }
      });
      setStatus('Moved to ' + listTitle(dstId));
    }).catch(fail);
  }

  function openTaskMenu(t, anchor) {
    if (!t) return;
    if (!anchor.isConnected) anchor = body.querySelector('[data-id="' + CSS.escape(t.id) + '"] .gt-more') || moreBtn;
    if (isTmp(t)) return setStatus('Saving\u2026');
    var items = [
      { label: dueDay(t) ? 'Change deadline' : 'Add deadline', icon: 'target', onClick: function () {
        var m = getMeta(t.id);
        openPicker({ due: dueDay(t), time: m.tm, repeat: m.rp }, function (s) { applyState(t, s); if (ed && ed.id === t.id) { ed.draft.due = s.due; ed.draft.time = s.time; ed.draft.repeat = s.repeat; } fullRender(); });
      } }
    ];
    if (!t.parent && !isTmp(t)) items.push({ label: 'Add a subtask', icon: 'sub', onClick: function () { openEditor('sub:' + t.id); } });
    items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: function () { removeTask(t); } }, { sep: true });
    lists.forEach(function (l) { items.push({ label: l.title, checked: l.id === t.listId, onClick: function () { moveTo(t, l.id); } }); });
    items.push({ label: 'New list', icon: 'list', onClick: function () {
      dialog({ title: 'New list', input: '', ok: 'Create' }, function (name) {
        api.createList(name).then(function (l) { lists.push(l); moveTo(t, l.id); }).catch(fail);
      });
    } });
    openMenu(anchor, items);
  }

  /* ---------- list menus ---------- */
  function openListSwitcher() {
    var items = lists.map(function (l) { return { label: l.title, checked: l.id === listId, onClick: function () { switchList(l.id); } }; });
    items.push({ sep: true }, { label: 'Starred', icon: 'star2', checked: isStarredView(), onClick: function () { switchList(STARRED); } },
      { label: 'Create new list', icon: 'list', onClick: function () {
        dialog({ title: 'New list', input: '', ok: 'Create' }, function (name) {
          api.createList(name).then(function (l) { lists.push(l); switchList(l.id); }).catch(fail);
        });
      } });
    openMenu(titleBtn, items);
  }
  function switchList(id) {
    closeEditor(false);
    listId = id;
    try { localStorage.setItem('gtasks.list', listId); } catch (e) {}
    tasks = [];
    refresh();
  }
  function openListMenu() {
    var real = !isStarredView();
    var cur = listTitle(listId);
    var items = [
      { header: 'Sort by' },
      { label: 'My order', checked: sortMode === 'order', onClick: function () { setSort('order'); } },
      { label: 'Date', checked: sortMode === 'date', onClick: function () { setSort('date'); } },
      { sep: true }
    ];
    if (real) items.push(
      { label: 'Rename list', onClick: function () {
        dialog({ title: 'Rename list', input: cur, ok: 'Save' }, function (name) {
          api.renameList(listId, name).then(function () { lists.forEach(function (l) { if (l.id === listId) l.title = name; }); fullRender(); }).catch(fail);
        });
      } },
      { label: 'Delete list', danger: true, onClick: function () {
        if (lists.length < 2) return setStatus('You need to keep at least one list.', true);
        dialog({ title: 'Delete “' + cur + '”?', text: 'This list and all its tasks will be deleted for good.', ok: 'Delete', danger: true }, function () {
          var gone = listId;
          api.deleteList(gone).then(function () {
            lists = lists.filter(function (l) { return l.id !== gone; });
            switchList(lists[0].id);
          }).catch(fail);
        });
      } },
      { label: 'Delete all completed tasks', onClick: function () {
        dialog({ title: 'Delete completed tasks?', text: 'Every completed task in “' + cur + '” will be removed.', ok: 'Delete', danger: true }, function () {
          api.clearDone(listId).then(function () { return refresh(); }).catch(fail);
        });
      } },
      { sep: true }
    );
    items.push(
      { label: 'Refresh', onClick: function () { refresh(); } },
      { label: 'Sign out', onClick: function () {
        api.signOut().catch(function () {}).then(function () { lists = []; tasks = []; listId = null; showAuth(); });
      } }
    );
    openMenu(moreBtn, items);
  }
  function setSort(m) {
    sortMode = m;
    try { localStorage.setItem('gtasks.sort', m); } catch (e) {}
    renderList();
  }

  /* ---------- loading ---------- */
  function load() {
    if (isStarredView()) {
      return Promise.all(lists.map(function (l) {
        return api.tasks(l.id).then(function (ts) { ts.forEach(function (t) { t.listId = l.id; }); return ts; });
      })).then(function (all) { return [].concat.apply([], all); });
    }
    return api.tasks(listId).then(function (ts) { ts.forEach(function (t) { t.listId = listId; }); return ts; });
  }

  function refresh(auto) {
    if (busy) return Promise.resolve();
    if (auto && (ed || menuEl || modalEl || dragId)) return Promise.resolve(); // never rebuild under the user's hands
    busy = true;
    return api.status().then(function (s) {
      if (!s.configured) return showAuth(null, false);
      if (!s.signedIn) return showAuth();
      return Promise.resolve(lists.length ? lists : api.lists()).then(function (l) {
        lists = l;
        if (!lists.length) { tasks = []; renderMain(); return setStatus('No task lists found in this Google account.', true); }
        if (listId !== STARRED && !lists.some(function (x) { return x.id === listId; })) listId = lists[0].id;
        return load().then(function (t) { tasks = t; if (!auto) setStatus(''); renderMain(); });
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
    if (!open) { closeEditor(false); closeMenu(); closeModal(); }
    panel.classList.toggle('open', open);
    document.body.classList.toggle('gt-open', open);
    panel.inert = !open;
    clearInterval(timer);
    if (open) {
      setStatus('');
      refresh();
      timer = setInterval(function () { if (!document.hidden) refresh(true); }, 90000);
    } else {
      link.focus({ preventScroll: true });
    }
  }
})();
