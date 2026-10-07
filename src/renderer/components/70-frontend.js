/* Views & JavaScript: layouts, templates, client scripts and the server calls they make. */
section({
  id: 'frontend', title: 'Views & JavaScript',
  visible: function () { return G.views.length > 0 || G.scripts.length > 0; },
  count: function () { return fmt(G.views.length + G.scripts.length); },
  render: function (el) {
    var layouts = G.views.filter(function (v) { return v.isLayout || (IN.get(v.id) || []).some(function (e) { return e.kind === 'extends'; }); });
    var calls = [];
    G.views.forEach(function (v) { v.calls.forEach(function (c) { calls.push(c); }); });
    G.scripts.forEach(function (s) { s.calls.forEach(function (c) { calls.push(c); }); });
    var engines = {};
    G.views.forEach(function (v) { engines[v.engine] = (engines[v.engine] || 0) + 1; });
    el.innerHTML = '<h1>Views, layouts and JavaScript</h1><p class="lead">How pages are assembled (' + Object.keys(engines).map(function (k) { return engines[k] + ' ' + esc(k); }).join(', ') +
      ' templates) and which browser code talks back to the server.</p>' +
      (layouts.length ? '<h2>Layouts</h2><div class="grid g2">' + layouts.slice(0, 24).map(function (l) {
        var kids = (IN.get(l.id) || []).filter(function (e) { return e.kind === 'extends'; }).map(function (e) { return e.from; });
        return '<div class="card"><h3>' + nodeLink(l.id) + '</h3><p class="small muted" style="margin:0 0 6px">' + esc(l.file) + '</p>' +
          (l.sections.length ? '<div>' + l.sections.map(function (s) { return pill(s); }).join('') + '</div>' : '') +
          (l.scripts.length ? '<p class="small" style="margin:6px 0 0">Scripts: ' + l.scripts.slice(0, 8).map(function (s) { return '<code>' + esc(s) + '</code>'; }).join(' ') + '</p>' : '') +
          '<p class="small" style="margin:6px 0 0"><b>' + plural(kids.length, 'page') + '</b> extend it' + (kids.length ? ': ' + kids.slice(0, 8).map(function (k) { return nodeLink(k); }).join(', ') + (kids.length > 8 ? ' …' : '') : '') + '</p></div>';
      }).join('') + '</div>' : '') +
      '<h2>Server calls from JavaScript (' + calls.length + ')</h2>' + (calls.length
        ? '<div class="table-wrap" style="max-height:60vh"><table><thead><tr><th>Where</th><th>Kind</th><th>Method</th><th>URL</th><th>Reaches</th></tr></thead><tbody>' + calls.slice(0, 600).map(function (c) {
          var r = c.route && IDX.route.get(c.route), h = r && r.handler && IDX.handler.get(r.handler);
          return '<tr><td class="small">' + loc(c.file, c.line) + (c.context ? '<br><span class="muted">' + esc(c.context) + '</span>' : '') + '</td><td>' + esc(c.kind) + '</td><td>' + method(c.method) + '</td><td class="path">' + esc(c.url) + '</td><td class="small">' +
            (r ? nodeLink(r.id) + (h ? '<br>→ ' + nodeLink(h.id) : '') : '<span class="muted">not matched to a route</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="note">No <code>fetch</code>, XHR, <code>$.ajax</code> or axios calls were found: pages talk to the server through links and form submissions.</div>') +
      '<h2>Templates (' + G.views.length + ')</h2><div class="toolbar"><input class="search" id="viewSearch" type="search" placeholder="Filter templates…" aria-label="Filter templates"></div>' +
      '<div class="table-wrap" style="max-height:60vh"><table><thead><tr><th>Template</th><th>Extends</th><th>Forms</th><th>Links</th><th>JS calls</th><th>Rendered by</th></tr></thead><tbody id="viewRows"></tbody></table></div>' +
      (G.scripts.length ? '<h2>Client scripts (' + G.scripts.length + ')</h2><div class="table-wrap" style="max-height:60vh"><table><thead><tr><th>File</th><th>Lines</th><th>Functions</th><th>Events</th><th>Server calls</th><th>Loaded by</th></tr></thead><tbody>' +
        G.scripts.map(function (s) {
          return '<tr><td>' + loc(s.file) + '</td><td>' + fmt(s.lines) + '</td><td class="small">' + s.functions.slice(0, 8).map(esc).join(', ') + (s.functions.length > 8 ? ' …' : '') + '</td><td class="small">' + s.events.slice(0, 6).map(esc).join(', ') +
            '</td><td>' + s.calls.length + '</td><td class="small">' + s.usedBy.slice(0, 4).map(function (v) { return nodeLink(v); }).join(', ') + (s.usedBy.length > 4 ? ' …' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '');
    function rows(q) {
      $('#viewRows').innerHTML = G.views.filter(function (v) { return !q || (v.name + ' ' + v.file).toLowerCase().indexOf(q) >= 0; }).slice(0, 800).map(function (v) {
        return '<tr><td>' + nodeLink(v.id) + '<br><span class="muted small">' + esc(v.file) + '</span></td><td class="small">' + v.extends.map(function (x) { return esc(labelOf(x)); }).join(', ') + '</td><td>' + (v.forms.length || '') + '</td><td>' + (v.links.length || '') +
          '</td><td>' + (v.calls.length || '') + '</td><td class="small">' + v.renderedBy.slice(0, 3).map(function (h) { return nodeLink(h); }).join(', ') + (v.renderedBy.length > 3 ? ' …' : '') + '</td></tr>';
      }).join('');
    }
    rows('');
    $('#viewSearch').addEventListener('input', function (e) { rows(e.target.value.trim().toLowerCase()); });
  }
});
