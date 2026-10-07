/* Data & models: tables, columns, relationships, and which code reads or writes them. */
section({
  id: 'data', title: 'Data & models',
  visible: function () { return G.tables.length > 0 || G.models.length > 0; },
  count: function () { return fmt(G.tables.length || G.models.length); },
  render: function (el, params) {
    var fks = G.tables.reduce(function (a, t) { return a + t.foreignKeys.length; }, 0);
    var inferred = G.tables.reduce(function (a, t) { return a + t.foreignKeys.filter(function (f) { return f.inferred; }).length; }, 0);
    el.innerHTML = '<h1>Data: models and tables</h1><p class="lead">' + plural(G.models.length, 'model') + ' over ' + plural(G.tables.length, 'table') + ', with ' + plural(fks, 'relationship') +
      (inferred ? ' (' + inferred + ' inferred from <code>*_id</code> column names, shown dashed)' : '') + '. Click a table to see its columns and the code that reads or writes it.</p>' +
      '<div class="toolbar"><input class="search" id="dbSearch" type="search" placeholder="Filter tables, columns, models…" aria-label="Filter tables"><span id="dbMode"></span></div>' +
      '<div id="dbDiagram"></div><div id="dbGrid" class="dbgrid" style="margin-top:12px"></div><div class="card detail" id="dbDetail"><span class="muted">Select a table or model.</span></div>';
    var mode = G.tables.length ? 'tables' : 'models';
    if (G.tables.length && G.models.length) chips($('#dbMode'), [{ v: 'tables', label: 'Tables', on: true }, { v: 'models', label: 'Models' }], function (v) { mode = v[0]; grid(); });
    var q = '';
    $('#dbSearch').addEventListener('input', function (e) { q = e.target.value.trim().toLowerCase(); grid(); });

    function grid() {
      var items = mode === 'tables' ? G.tables : G.models;
      var list = items.filter(function (x) {
        if (!q) return true;
        var cols = (x.columns || x.fields || []).map(function (c) { return c.name; }).join(' ');
        return (x.name + ' ' + cols + ' ' + (x.table || '') + ' ' + (x.models || []).map(labelOf).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
      $('#dbGrid').innerHTML = list.length ? list.map(function (x) {
        var sub = mode === 'tables'
          ? (x.columns.length ? x.columns.length + ' cols' : 'columns unknown') + ' · ' + x.readBy.length + 'R / ' + x.writtenBy.length + 'W'
          : (x.table ? '→ ' + x.table : x.kind) + ' · used by ' + x.usedBy.length;
        return '<button class="tbl" type="button" data-id="' + esc(x.id) + '" aria-pressed="' + (params.id === x.id) + '"><div class="tn">' + esc(x.name) + '</div><div class="ts">' + esc(sub) + '</div></button>';
      }).join('') : '<p class="muted">Nothing matches.</p>';
    }
    $('#dbGrid').addEventListener('click', function (e) { var b = e.target.closest('.tbl'); if (b) select(b.dataset.id); });

    function select(id) {
      $$('#dbGrid .tbl').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.id === id)); });
      highlight(id);
      var t = IDX.table.get(id), m = IDX.model.get(id);
      $('#dbDetail').innerHTML = t ? tableDetail(t) : m ? modelDetail(m) : '';
      history.replaceState(null, '', '#/data?id=' + encodeURIComponent(id));
    }
    grid();
    diagram();
    if (params.id) { select(params.id); var d = $('#dbDetail'); if (d) d.scrollIntoView({ block: 'start' }); }
  }
});

function tableDetail(t) {
  var fk = {};
  t.foreignKeys.forEach(function (f) { fk[f.column] = f; });
  var incoming = G.tables.filter(function (o) { return o.foreignKeys.some(function (f) { return f.references.split('.')[0] === t.name; }); });
  return '<h3 style="margin-top:0">' + esc(t.name) + '</h3>' +
    '<p class="small muted">' + t.sources.slice(0, 4).map(function (s) { return esc(s.kind) + ': ' + loc(s.file, s.line); }).join(' · ') + '</p>' +
    (t.models.length ? '<p>Model: ' + t.models.map(function (m) { return nodeLink(m); }).join(', ') + '</p>' : '') +
    (t.columns.length ? '<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th></tr></thead><tbody>' + t.columns.map(function (c) {
      var f = fk[c.name];
      return '<tr><td class="path">' + esc(c.name) + '</td><td class="small">' + esc(c.type || '') + '</td><td class="small">' + (c.nullable === true ? 'yes' : c.nullable === false ? 'no' : '') + '</td><td class="small">' +
        (c.primary ? pill('PK', 'ok') : '') + (f ? pill((f.inferred ? '~' : '') + 'FK → ' + f.references, f.inferred ? '' : 'ok') : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="muted small">Columns are unknown: no migration, model field list or SQL schema defines this table.</p>') +
    (incoming.length ? '<p class="small">Referenced by: ' + incoming.map(function (o) { return nodeLink(o.id); }).join(', ') + '</p>' : '') +
    '<div class="split"><div><h3>Read by (' + t.readBy.length + ')</h3>' + codeList(t.readBy) + '</div><div><h3>Written by (' + t.writtenBy.length + ')</h3>' + codeList(t.writtenBy) + '</div></div>';
}
function modelDetail(m) {
  return '<h3 style="margin-top:0">' + esc(m.name) + ' <span class="muted small">' + esc(m.kind) + '</span></h3><p class="small">' + loc(m.file, m.line) + '</p>' +
    (m.table ? '<p>Table: ' + nodeLink('table:' + m.table, m.table) + '</p>' : '') +
    (m.fields.length ? '<h3>Fields</h3>' + m.fields.map(function (f) { return pill(f.name + (f.type ? ': ' + f.type : ''), f.primary ? 'ok' : ''); }).join('') : '') +
    (m.relations.length ? '<h3>Relations</h3><ul>' + m.relations.map(function (r) { return '<li>' + esc(r.kind) + ' → ' + (IDX.model.has(r.target) ? nodeLink(r.target) : '<code>' + esc(r.target) + '</code>') + (r.via ? ' <span class="muted small">via ' + esc(r.via) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
    '<h3>Used by (' + m.usedBy.length + ')</h3>' + codeList(m.usedBy);
}
function codeList(ids) {
  if (!ids.length) return '<p class="muted small">None found.</p>';
  return '<ul class="small">' + ids.slice(0, 60).map(function (id) { return '<li>' + nodeLink(id) + '</li>'; }).join('') + (ids.length > 60 ? '<li class="muted">… ' + (ids.length - 60) + ' more</li>' : '') + '</ul>';
}

/* A simple relationship diagram: tables with relations laid out on a grid, ordered by degree. */
var ER = null;
function diagram() {
  var linked = G.tables.filter(function (t) {
    return t.foreignKeys.length || G.tables.some(function (o) { return o.foreignKeys.some(function (f) { return f.references.split('.')[0] === t.name; }); });
  });
  var box = $('#dbDiagram');
  if (linked.length < 2 || linked.length > 90) { box.innerHTML = ''; return; }
  var deg = {};
  linked.forEach(function (t) { deg[t.name] = (deg[t.name] || 0) + t.foreignKeys.length; t.foreignKeys.forEach(function (f) { var r = f.references.split('.')[0]; deg[r] = (deg[r] || 0) + 1; }); });
  var nodes = linked.slice().sort(function (a, b) { return (deg[b.name] || 0) - (deg[a.name] || 0); });
  // hubs in the middle row, leaves around
  var cols = Math.max(3, Math.min(7, Math.ceil(Math.sqrt(nodes.length * 1.6))));
  var rows = Math.ceil(nodes.length / cols);
  var order = [];
  var mid = Math.floor(rows / 2);
  var rowOrder = [mid];
  for (var d = 1; rowOrder.length < rows; d++) { if (mid - d >= 0) rowOrder.push(mid - d); if (mid + d < rows) rowOrder.push(mid + d); }
  var W = 180, H = 64, pad = 20;
  var pos = {};
  nodes.forEach(function (n, i) {
    var r = rowOrder[Math.floor(i / cols)], c = i % cols;
    var x = pad + c * W + (r % 2 ? W / 2 : 0), y = pad + r * H;
    pos[n.name] = { x: x, y: y };
    order.push(n);
  });
  var width = pad * 2 + cols * W + W / 2, height = pad * 2 + rows * H;
  var edges = [];
  nodes.forEach(function (t) { t.foreignKeys.forEach(function (f) { var to = f.references.split('.')[0]; if (pos[to] && to !== t.name) edges.push({ a: t.name, b: to, inf: f.inferred }); }); });
  box.innerHTML = '<svg class="er" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Table relationships">' +
    edges.map(function (e, i) {
      var p = pos[e.a], q = pos[e.b];
      var x1 = p.x + 75, y1 = p.y + 14, x2 = q.x + 75, y2 = q.y + 14, mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 18;
      return '<path class="edge' + (e.inf ? ' inf' : '') + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="M' + x1 + ' ' + y1 + ' Q' + mx + ' ' + my + ' ' + x2 + ' ' + y2 + '"/>';
    }).join('') +
    order.map(function (t) {
      var p = pos[t.name];
      var label = t.name.length > 20 ? t.name.slice(0, 19) + '…' : t.name;
      return '<g class="node" tabindex="0" data-id="' + esc(t.id) + '" data-n="' + esc(t.name) + '"><title>' + esc(t.name) + '</title><rect x="' + p.x + '" y="' + p.y + '" width="150" height="28" rx="7"/><text x="' + (p.x + 10) + '" y="' + (p.y + 18) + '">' + esc(label) + '</text></g>';
    }).join('') + '</svg><div class="legend"><span>Solid: declared foreign key</span><span>Dashed: inferred from column name</span><span>Click a table to highlight its relationships</span></div>';
  ER = box;
  box.addEventListener('click', function (e) { var g = e.target.closest('.node'); if (g) { var b = $('#dbGrid .tbl[data-id="' + CSS.escape(g.dataset.id) + '"]'); if (b) b.click(); else highlight(g.dataset.id); } });
  box.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var g = e.target.closest('.node'); if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
}
function highlight(id) {
  if (!ER) return;
  var t = IDX.table.get(id);
  var name = t ? t.name : null;
  var near = {};
  if (name) { near[name] = 1; $$('.edge', ER).forEach(function (p) { var on = p.dataset.a === name || p.dataset.b === name; p.classList.toggle('hl', on); if (on) { near[p.dataset.a] = 1; near[p.dataset.b] = 1; } }); }
  $$('.node', ER).forEach(function (g) { g.classList.toggle('sel', g.dataset.n === name); g.classList.toggle('dim', !!name && !near[g.dataset.n]); });
}
