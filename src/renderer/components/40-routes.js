/* Routes explorer: every method + path, filterable, with the execution path of each. */
section({
  id: 'routes', title: 'Routes explorer',
  visible: function () { return G.routes.length > 0; },
  count: function () { return fmt(G.routes.length); },
  render: function (el, params) {
    var files = uniq(G.routes.map(function (r) { return r.file; }));
    el.innerHTML = '<h1>Routes explorer</h1><p class="lead">All ' + plural(G.routes.length, 'method/route pair') + ' from ' + files.slice(0, 4).map(function (f) { return '<code>' + esc(f) + '</code>'; }).join(', ') + (files.length > 4 ? ' and ' + (files.length - 4) + ' more files' : '') +
      '. Search, filter, and click a row for its full execution path.</p>' +
      '<div class="toolbar"><input class="search" id="routeSearch" type="search" placeholder="Search path, handler, middleware, table, view…" aria-label="Search routes">' +
      '<select class="sel" id="routeMw" aria-label="Filter by middleware"><option value="">Any middleware</option><option value="-">No middleware</option>' +
      uniq([].concat.apply([], G.routes.map(function (r) { return r.middleware; }))).sort().map(function (m) { return '<option>' + esc(m) + '</option>'; }).join('') + '</select></div>' +
      '<div class="toolbar" id="methodChips"></div><div class="toolbar" id="groupChips"></div><div class="count" id="routeCount"></div>' +
      '<div class="table-wrap" style="max-height:72vh"><table id="routeTable"><thead><tr><th>Method</th><th>Path</th><th>Middleware</th><th>Handler</th><th>Tables</th><th>Response</th></tr></thead><tbody></tbody></table></div>' +
      '<button class="chip more" id="routeMore" type="button" hidden>Show more</button>';
    var state = { q: '', methods: [], group: '', mw: '', limit: 300, open: params.r || null };
    var methods = {};
    G.routes.forEach(function (r) { methods[r.method] = (methods[r.method] || 0) + 1; });
    chips($('#methodChips'), Object.keys(methods).sort().map(function (m) { return { v: m, label: m, n: methods[m] }; }), function (v) { state.methods = v; draw(); }, true);
    var groups = {};
    G.routes.forEach(function (r) { groups[r.group] = (groups[r.group] || 0) + 1; });
    var gl = Object.keys(groups).sort(function (a, b) { return groups[b] - groups[a]; });
    chips($('#groupChips'), [{ v: '', label: 'All groups', on: true }].concat(gl.slice(0, 24).map(function (g) { return { v: g, label: '/' + g, n: groups[g] }; })), function (v) { state.group = v[0] || ''; draw(); });
    $('#routeSearch').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); state.limit = 300; draw(); });
    $('#routeMw').addEventListener('change', function (e) { state.mw = e.target.value; draw(); });
    $('#routeMore').addEventListener('click', function () { state.limit += 500; draw(); });

    function hay(r) {
      if (r._h) return r._h;
      var h = r.handler && IDX.handler.get(r.handler);
      r._h = [r.method, r.path, r.target, r.name || '', r.middleware.join(' '), r.file, h ? h.tables.join(' ') + ' ' + h.views.map(function (v) { return labelOf(v.view); }).join(' ') : ''].join(' ').toLowerCase();
      return r._h;
    }
    function row(r) {
      var h = r.handler && IDX.handler.get(r.handler);
      return '<tr class="click' + (state.open === r.id ? ' open' : '') + '" data-id="' + esc(r.id) + '"><td>' + method(r.method) + '</td><td class="path">' + esc(r.path) + '</td>' +
        '<td>' + (r.middleware.length ? r.middleware.map(function (m) { return pill(m, 'ok'); }).join('') : '<span class="muted small">none</span>') + '</td>' +
        '<td class="small">' + (h ? nodeLink(h.id) : esc(r.target)) + '</td><td class="small">' + (h ? h.tables.slice(0, 4).map(esc).join(', ') + (h.tables.length > 4 ? ' …' : '') : '') + '</td>' +
        '<td class="small">' + (h ? h.responses.join(', ') : '') + '</td></tr>' + (state.open === r.id ? '<tr><td class="expand" colspan="6">' + detail(r, h) + '</td></tr>' : '');
    }
    function detail(r, h) {
      var out = '<dl class="kv"><dt>Defined at</dt><dd>' + loc(r.file, r.line) + '</dd><dt>Target</dt><dd><code>' + esc(r.target) + '</code></dd>' +
        (r.name ? '<dt>Route name</dt><dd><code>' + esc(r.name) + '</code></dd>' : '') +
        (r.middleware.length ? '<dt>Middleware</dt><dd>' + r.middleware.map(function (m) { var mw = IDX.middleware.get('middleware:' + m.split(':')[0]); return '<b>' + esc(m) + '</b>' + (mw && mw.description ? ' <span class="muted small">— ' + esc(mw.description) + '</span>' : ''); }).join('<br>') + '</dd>' : '') +
        (r.notes && r.notes.length ? '<dt>Notes</dt><dd>' + r.notes.map(esc).join('<br>') + '</dd>' : '') + '</dl>';
      if (!h) return out + '<p class="muted small">The target was not resolved to analyzed code (closure, framework handler, or a file outside the scan).</p>';
      var callers = (IN.get(r.id) || []).filter(function (e) { return e.kind === 'submits-to' || e.kind === 'links-to' || e.kind === 'calls'; });
      return out + '<h3>Execution path · ' + nodeLink(h.id) + ' <span class="muted small">' + esc(h.file) + ':' + h.line + '</span></h3>' + stepsList(h.steps) +
        (h.views.length ? '<h3>Views rendered</h3>' + h.views.map(function (v) { return IDX.view.has(v.view) ? nodeLink(v.view) : '<code>' + esc(v.view) + '</code>'; }).join(', ') : '') +
        (callers.length ? '<h3>Reached from</h3>' + uniq(callers.map(function (e) { return e.from; })).slice(0, 20).map(function (id) { return nodeLink(id); }).join(', ') : '');
    }
    function draw() {
      var list = G.routes.filter(function (r) {
        if (state.methods.length && state.methods.indexOf(r.method) < 0) return false;
        if (state.group && r.group !== state.group) return false;
        if (state.mw === '-' && r.middleware.length) return false;
        if (state.mw && state.mw !== '-' && r.middleware.indexOf(state.mw) < 0) return false;
        if (state.q && state.q.split(/\s+/).some(function (w) { return hay(r).indexOf(w) < 0; })) return false;
        return true;
      });
      $('#routeCount').textContent = list.length === G.routes.length ? plural(list.length, 'route') : list.length + ' of ' + plural(G.routes.length, 'route');
      $('#routeTable tbody').innerHTML = list.length ? list.slice(0, state.limit).map(row).join('') : '<tr><td colspan="6" class="muted">No routes match.</td></tr>';
      $('#routeMore').hidden = list.length <= state.limit;
    }
    $('#routeTable').addEventListener('click', function (e) {
      if (e.target.closest('[data-go],[data-copy]')) return;
      var tr = e.target.closest('tr.click'); if (!tr) return;
      state.open = state.open === tr.dataset.id ? null : tr.dataset.id;
      draw();
    });
    draw();
    if (state.open) { var tr = $('tr.open', el); if (tr) tr.scrollIntoView({ block: 'center' }); }
  }
});
