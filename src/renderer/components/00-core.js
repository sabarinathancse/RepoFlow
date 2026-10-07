/* RepoFlow explorer core: data indexes, helpers, router, navigation. Framework-agnostic: reads only the normalized graph. */
'use strict';
var G = JSON.parse(document.getElementById('repoflow-graph').textContent);
var MANIFEST = (function () { try { return JSON.parse(document.getElementById('repoflow-manifest').textContent); } catch (e) { return {}; } })();

function indexBy(list) { var m = new Map(); (list || []).forEach(function (x) { m.set(x.id, x); }); return m; }
var IDX = {
  route: indexBy(G.routes), handler: indexBy(G.handlers), container: indexBy(G.containers), model: indexBy(G.models),
  table: indexBy(G.tables), view: indexBy(G.views), script: indexBy(G.scripts), middleware: indexBy(G.middleware),
  integration: indexBy(G.integrations), finding: indexBy(G.findings)
};
var OUT = new Map(), IN = new Map();
G.edges.forEach(function (e) {
  if (!OUT.has(e.from)) OUT.set(e.from, []);
  if (!IN.has(e.to)) IN.set(e.to, []);
  OUT.get(e.from).push(e); IN.get(e.to).push(e);
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function uniq(a) { return Array.from(new Set(a)); }
function method(m) { return '<span class="m ' + esc(m) + '">' + esc(m) + '</span>'; }
function sev(s) { return '<span class="sev ' + esc(s) + '">' + esc(s) + '</span>'; }
function pill(t, cls) { return '<span class="pill' + (cls ? ' ' + cls : '') + '" title="' + esc(t) + '">' + esc(t) + '</span>'; }
function loc(file, line) {
  if (!file) return '';
  var t = file + (line ? ':' + line : '');
  return '<span class="path">' + esc(t) + '</span><button class="copy" type="button" data-copy="' + esc(t) + '" title="Copy path">copy</button>';
}
function kindBadge(k) { return '<span class="kind ' + esc(k) + '">' + esc(k) + '</span>'; }
function empty(msg) { return '<div class="empty">' + esc(msg) + '</div>'; }

/** Human label for any graph node id. */
function labelOf(id) {
  var t = id.slice(0, id.indexOf(':')), n;
  if (t === 'route' && (n = IDX.route.get(id))) return n.method + ' ' + n.path;
  if ((n = IDX.handler.get(id))) return handlerLabel(n);
  if (t === 'controller' && (n = IDX.container.get(id))) return n.name;
  if (t === 'model' && (n = IDX.model.get(id))) return n.name;
  if (t === 'table' && (n = IDX.table.get(id))) return n.name;
  if (t === 'view' && (n = IDX.view.get(id))) return n.name;
  if (t === 'script' && (n = IDX.script.get(id))) return n.file;
  if (t === 'middleware' && (n = IDX.middleware.get(id))) return n.name;
  return id.replace(/^[a-z]+:/, '');
}
function typeOf(id) {
  if (IDX.handler.has(id)) return 'handler';
  var t = id.slice(0, id.indexOf(':'));
  return t === 'controller' ? 'container' : t;
}
function handlerLabel(h) {
  var c = h.container && IDX.container.get(h.container);
  return c ? c.name + '::' + h.name : h.name;
}

/** A link that navigates to a node's natural home in the explorer. */
function nodeLink(id, text) {
  return '<button class="link" type="button" data-go="' + esc(id) + '">' + esc(text || labelOf(id)) + '</button>';
}
function go(id) {
  var t = typeOf(id);
  if (t === 'handler') return navigate('code', 'h=' + encodeURIComponent(id));
  if (t === 'view') return navigate('code', 'v=' + encodeURIComponent(id));
  if (t === 'container') return navigate('code', 'c=' + encodeURIComponent(id));
  if (t === 'route') return navigate('routes', 'r=' + encodeURIComponent(id));
  if (t === 'table' || t === 'model') return navigate('data', 'id=' + encodeURIComponent(id));
  if (t === 'finding') return navigate('findings', 'id=' + encodeURIComponent(id));
  if (t === 'integration') return navigate('integrations', '');
  return navigate('connections', 'id=' + encodeURIComponent(id));
}

/* ---------------------------------------------------------------- sections + router */
var SECTIONS = [];
function section(def) { SECTIONS.push(def); }
var current = { id: null, params: {} };

function parseHash() {
  var h = location.hash.replace(/^#\/?/, '');
  var q = h.indexOf('?');
  var id = q < 0 ? h : h.slice(0, q);
  var params = {};
  if (q >= 0) h.slice(q + 1).split('&').forEach(function (kv) { if (!kv) return; var i = kv.indexOf('='); params[decodeURIComponent(kv.slice(0, i < 0 ? kv.length : i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1)); });
  return { id: id, params: params };
}
function navigate(id, query) {
  var target = '#/' + id + (query ? '?' + query : '');
  if (location.hash === target) render(); else location.hash = target;
}
function visibleSections() { return SECTIONS.filter(function (s) { return !s.visible || s.visible(); }); }
function render() {
  var st = parseHash();
  var list = visibleSections();
  var sec = list.find(function (s) { return s.id === st.id; }) || list[0];
  current = { id: sec.id, params: st.params };
  $$('#navlist button.nav').forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.id === sec.id)); });
  var main = $('#main');
  main.innerHTML = '<section class="view" id="sec-' + sec.id + '"></section>';
  document.title = sec.title + ' · ' + G.project.name + ' · RepoFlow';
  sec.render($('#sec-' + sec.id), st.params);
  if (!st.params.keep) window.scrollTo(0, 0);
}

function buildNav() {
  $('#brand').textContent = G.project.name;
  var fw = G.frameworks.filter(function (f) { return f.id !== 'generic'; }).map(function (f) { return f.name + (f.version ? ' ' + String(f.version).replace(/^[\^~]/, '') : ''); });
  $('#brandSub').textContent = (fw.length ? fw.join(' · ') : 'Project explorer');
  $('#navlist').innerHTML = visibleSections().map(function (s, i) {
    var c = s.count ? s.count() : null;
    return '<button class="nav" type="button" data-id="' + s.id + '"><span class="num">' + (i + 1) + '</span><span>' + esc(s.title) + '</span>' +
      (c != null && c !== '' ? '<span class="cnt">' + esc(c) + '</span>' : '') + '</button>';
  }).join('');
  $('#navlist').addEventListener('click', function (e) { var b = e.target.closest('button.nav'); if (b) navigate(b.dataset.id); });
  var g = G.project.git || {};
  $('#sideFoot').innerHTML = 'Generated by RepoFlow ' + esc(G.generator.version) + '<br>' + esc(new Date(G.project.scannedAt).toLocaleString()) +
    (g.commit ? '<br>Commit <code>' + esc(g.commit.slice(0, 7)) + '</code>' + (g.branch ? ' on ' + esc(g.branch) : '') : '') +
    '<br>Static analysis: source code is authoritative.' +
    '<br><button class="theme-btn" id="themeBtn" type="button">Toggle theme</button>';
}

/* ---------------------------------------------------------------- theme */
function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem('repoflow-theme'); } catch (e) { /* storage blocked */ }
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('click', function (e) {
    if (e.target.id !== 'themeBtn') return;
    var cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('repoflow-theme', next); } catch (err) { /* ignore */ }
  });
}

/* ---------------------------------------------------------------- global search */
var SEARCH_INDEX = null;
function buildSearchIndex() {
  var items = [];
  G.routes.forEach(function (r) { items.push({ k: 'route', id: r.id, t: r.method + ' ' + r.path, s: r.target }); });
  G.handlers.forEach(function (h) { items.push({ k: 'code', id: h.id, t: handlerLabel(h), s: h.file }); });
  G.containers.forEach(function (c) { items.push({ k: 'class', id: c.id, t: c.name, s: c.file }); });
  G.views.forEach(function (v) { items.push({ k: 'view', id: v.id, t: v.name, s: v.file }); });
  G.models.forEach(function (m) { items.push({ k: 'model', id: m.id, t: m.name, s: m.table || m.file }); });
  G.tables.forEach(function (t) { items.push({ k: 'table', id: t.id, t: t.name, s: t.columns.length + ' columns' }); });
  G.scripts.forEach(function (s) { items.push({ k: 'script', id: s.id, t: s.file, s: s.calls.length + ' calls' }); });
  G.findings.forEach(function (f) { items.push({ k: f.severity, id: f.id, t: f.title, s: f.file || '' }); });
  items.forEach(function (i) { i.h = (i.t + ' ' + i.s).toLowerCase(); });
  return items;
}
function initSearch() {
  var input = $('#globalSearch'), box = $('#globalResults'), sel = 0, hits = [];
  function show() {
    var q = input.value.trim().toLowerCase();
    if (!q) { box.hidden = true; return; }
    SEARCH_INDEX = SEARCH_INDEX || buildSearchIndex();
    var words = q.split(/\s+/);
    hits = SEARCH_INDEX.filter(function (i) { return words.every(function (w) { return i.h.indexOf(w) >= 0; }); }).slice(0, 40);
    sel = 0;
    box.innerHTML = hits.length ? hits.map(function (h, i) {
      return '<button type="button" data-i="' + i + '"' + (i === 0 ? ' class="sel"' : '') + '><span class="gk">' + esc(h.k) + '</span>' + esc(h.t) + '<br><span class="muted small">' + esc(h.s) + '</span></button>';
    }).join('') : '<div class="muted small" style="padding:6px">No matches</div>';
    box.hidden = false;
  }
  function pick(i) { var h = hits[i]; if (!h) return; box.hidden = true; input.value = ''; go(h.id); }
  input.addEventListener('input', show);
  input.addEventListener('keydown', function (e) {
    if (box.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(hits.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      $$('button', box).forEach(function (b, i) { b.classList.toggle('sel', i === sel); if (i === sel) b.scrollIntoView({ block: 'nearest' }); });
    } else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') { box.hidden = true; }
  });
  box.addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (b) pick(Number(b.dataset.i)); });
  document.addEventListener('click', function (e) { if (!e.target.closest('.gsearch')) box.hidden = true; });
}

/* ---------------------------------------------------------------- shared widgets */
function stepsList(steps) {
  if (!steps || !steps.length) return '<p class="muted small">No notable steps were detected in this code.</p>';
  return '<ol class="steps">' + steps.map(function (s) {
    return '<li>' + kindBadge(s.kind) + '<div>' + esc(s.text) + (s.code ? '<code class="code">' + esc(s.code) + '</code>' : '') + '</div><span class="ln">L' + s.line + '</span></li>';
  }).join('') + '</ol>';
}
function chips(container, options, onChange, multi) {
  container.innerHTML = options.map(function (o) {
    return '<button class="chip" type="button" aria-pressed="' + (o.on ? 'true' : 'false') + '" data-v="' + esc(o.v) + '">' + esc(o.label) + (o.n != null ? ' · ' + o.n : '') + '</button>';
  }).join('');
  container.addEventListener('click', function (e) {
    var b = e.target.closest('button.chip'); if (!b) return;
    if (!multi) $$('button.chip', container).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
    b.setAttribute('aria-pressed', multi ? String(b.getAttribute('aria-pressed') !== 'true') : 'true');
    onChange($$('button.chip[aria-pressed="true"]', container).map(function (x) { return x.dataset.v; }));
  });
}

document.addEventListener('click', function (e) {
  var g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); go(g.dataset.go); return; }
  var c = e.target.closest('[data-copy]');
  if (c) {
    var text = c.dataset.copy;
    var done = function () { c.textContent = 'copied'; setTimeout(function () { c.textContent = 'copy'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { c.textContent = 'failed'; });
  }
});
