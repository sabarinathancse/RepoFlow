/* Code explorer: container → handler → steps → views, and a view inspector. */
section({
  id: 'code', title: 'Code explorer',
  visible: function () { return G.handlers.length > 0 || G.views.length > 0; },
  count: function () { return fmt(G.handlers.length); },
  render: function (el, params) {
    var areas = uniq(G.containers.map(function (c) { return c.area; }).concat(G.handlers.filter(function (h) { return !h.container; }).map(function (h) { return h.area || 'other'; }))).sort();
    el.innerHTML = '<h1>Code explorer</h1><p class="lead">Pick a controller or module, then a handler. You will see the routes that reach it, its step-by-step flow with line numbers, the data it touches and the <b>variables it passes to each view</b>. ' +
      'Open a view to see its layout, partials, forms, links and scripts, and which route each one reaches.</p>' +
      '<div class="toolbar"><button class="chip" id="cxBack" type="button" disabled>← Back</button>' +
      '<span id="cxAreas"></span><select class="sel" id="cxViewSel" aria-label="Jump to a view"><option value="">Jump to a view…</option>' +
      G.views.map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="cx-wrap"><div class="card cx-side"><input class="search" id="cxFilter" type="search" placeholder="Filter…" aria-label="Filter controllers and handlers" style="width:100%;margin-bottom:6px"><div id="cxList"></div></div><div class="card" id="cxPanel"></div></div>';
    var state = { area: '', q: '', open: null };
    if (areas.length > 1) chips($('#cxAreas'), [{ v: '', label: 'All', on: true }].concat(areas.map(function (a) { return { v: a, label: a }; })), function (v) { state.area = v[0] || ''; list(); });

    var loose = G.handlers.filter(function (h) { return !h.container; });
    function list() {
      var q = state.q;
      var html = '';
      var byArea = {};
      G.containers.forEach(function (c) { (byArea[c.area] = byArea[c.area] || []).push(c); });
      loose.forEach(function (h) { var a = h.area || 'other'; (byArea[a] = byArea[a] || []).push(h); });
      Object.keys(byArea).sort().forEach(function (area) {
        if (state.area && area !== state.area) return;
        var items = byArea[area].filter(function (x) {
          if (!q) return true;
          if (x.handlers) return x.name.toLowerCase().indexOf(q) >= 0 || x.handlers.some(function (id) { return IDX.handler.get(id) && IDX.handler.get(id).name.toLowerCase().indexOf(q) >= 0; });
          return handlerLabel(x).toLowerCase().indexOf(q) >= 0 || x.file.toLowerCase().indexOf(q) >= 0;
        });
        if (!items.length) return;
        html += '<div class="cx-area">' + esc(area) + '</div>';
        items.forEach(function (x) {
          if (x.handlers) {
            var isOpen = state.open === x.id || (q && x.name.toLowerCase().indexOf(q) < 0);
            html += '<button class="cx-item" type="button" data-c="' + esc(x.id) + '" aria-current="' + (current.params.c === x.id) + '">' + esc(x.name) + '<span class="c">' + x.handlers.length + '</span></button>';
            if (isOpen) {
              html += '<div class="cx-sub">' + x.handlers.map(function (id) { return IDX.handler.get(id); }).filter(function (h) { return h && (!q || h.name.toLowerCase().indexOf(q) >= 0 || x.name.toLowerCase().indexOf(q) >= 0); }).map(function (h) {
                return '<button class="cx-item" type="button" data-h="' + esc(h.id) + '" aria-current="' + (current.params.h === h.id) + '">' + esc(h.name) + (h.visibility && h.visibility !== 'public' ? ' <span class="muted small">' + esc(h.visibility) + '</span>' : '') + '<span class="c">' + (h.routes.length ? h.routes.length + ' route' + (h.routes.length > 1 ? 's' : '') : '') + '</span></button>';
              }).join('') + '</div>';
            }
          } else {
            html += '<button class="cx-item" type="button" data-h="' + esc(x.id) + '" aria-current="' + (current.params.h === x.id) + '">' + esc(x.name) + '<span class="c">' + (x.routes.length || '') + '</span></button>';
          }
        });
      });
      $('#cxList').innerHTML = html || '<p class="muted small">Nothing matches.</p>';
    }
    $('#cxList').addEventListener('click', function (e) {
      var b = e.target.closest('.cx-item'); if (!b) return;
      if (b.dataset.c) { state.open = state.open === b.dataset.c ? null : b.dataset.c; navigate('code', 'c=' + encodeURIComponent(b.dataset.c) + '&keep=1'); }
      else navigate('code', 'h=' + encodeURIComponent(b.dataset.h) + '&keep=1');
    });
    $('#cxFilter').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); list(); });
    $('#cxViewSel').addEventListener('change', function (e) { if (e.target.value) navigate('code', 'v=' + encodeURIComponent(e.target.value)); });
    $('#cxBack').disabled = history.length < 2;
    $('#cxBack').addEventListener('click', function () { history.back(); });

    var panel = $('#cxPanel');
    if (params.h && IDX.handler.get(params.h)) {
      var h = IDX.handler.get(params.h);
      state.open = h.container || null;
      panel.innerHTML = handlerPanel(h);
    } else if (params.v && IDX.view.get(params.v)) {
      panel.innerHTML = viewPanel(IDX.view.get(params.v));
      $('#cxViewSel').value = params.v;
    } else if (params.c && IDX.container.get(params.c)) {
      state.open = params.c;
      panel.innerHTML = containerPanel(IDX.container.get(params.c));
    } else {
      panel.innerHTML = '<p class="muted">Select a controller on the left' + (G.views.length ? ', or jump to a view.' : '.') + '</p>' + biggest();
    }
    list();
    var cur = $('.cx-item[aria-current="true"]', el);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
});

function biggest() {
  var hs = G.handlers.slice().sort(function (a, b) { return b.steps.length - a.steps.length; }).slice(0, 12);
  if (!hs.length) return '';
  return '<h3>Busiest handlers</h3><ul>' + hs.map(function (h) { return '<li>' + nodeLink(h.id) + ' <span class="muted small">' + h.steps.length + ' steps · ' + h.tables.length + ' tables</span></li>'; }).join('') + '</ul>';
}

function containerPanel(c) {
  var hs = c.handlers.map(function (id) { return IDX.handler.get(id); }).filter(Boolean);
  return '<div class="cx-head"><h2>' + esc(c.name) + '</h2>' + loc(c.file, c.line) + (c.extends ? ' <span class="muted small">extends <code>' + esc(c.extends) + '</code></span>' : '') + '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Handler</th><th>Routes</th><th>Tables</th><th>Views</th><th>Response</th></tr></thead><tbody>' +
    hs.map(function (h) {
      return '<tr><td>' + nodeLink(h.id, h.name) + (h.visibility && h.visibility !== 'public' ? ' <span class="muted small">' + esc(h.visibility) + '</span>' : '') + '</td><td>' +
        h.routes.map(function (r) { var rt = IDX.route.get(r); return rt ? method(rt.method) + ' <span class="path">' + esc(rt.path) + '</span>' : ''; }).join('<br>') + '</td><td class="small">' + h.tables.map(esc).join(', ') +
        '</td><td class="small">' + h.views.map(function (v) { return esc(labelOf(v.view)); }).join(', ') + '</td><td class="small">' + h.responses.join(', ') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function handlerPanel(h) {
  var c = h.container && IDX.container.get(h.container);
  var routes = h.routes.map(function (id) { return IDX.route.get(id); }).filter(Boolean);
  var dataRows = h.data.map(function (d) {
    return '<tr><td>' + pill(d.op.toUpperCase(), d.op === 'read' ? '' : 'warn') + '</td><td>' + (d.model ? nodeLink(d.model) : '') + '</td><td>' + (d.table ? nodeLink('table:' + d.table, d.table) : '') + '</td><td class="ln">L' + d.line + '</td></tr>';
  }).join('');
  return '<div class="crumbs">' + (c ? nodeLink(c.id) + ' <span class="muted">›</span> ' : '') + '<b>' + esc(h.name) + '</b></div>' +
    '<div class="cx-head"><h2>' + esc(handlerLabel(h)) + (h.params != null ? '<span class="muted" style="font-weight:400">(' + esc(h.params) + ')</span>' : '') + '</h2>' +
    loc(h.file, h.line) + ' <span class="muted small">lines ' + h.line + '–' + h.endLine + (h.visibility ? ' · ' + esc(h.visibility) : '') + '</span>' +
    (h.decorators && h.decorators.length ? '<div style="margin-top:6px">' + h.decorators.map(function (d) { return pill('@' + d); }).join('') + '</div>' : '') + '</div>' +
    '<h3>Reached by</h3>' + (routes.length ? routes.map(function (r) {
      return '<div>' + method(r.method) + ' <button class="link" data-go="' + esc(r.id) + '">' + esc(r.path) + '</button> ' + r.middleware.map(function (m) { return pill(m, 'ok'); }).join('') + '</div>';
    }).join('') : '<p class="muted small">No route points here' + (h.visibility && h.visibility !== 'public' ? ' (it is ' + esc(h.visibility) + ', called internally).' : '. It may be dead code, reached by auto-routing, or called internally.') + '</p>') +
    '<h3>Step by step</h3>' + stepsList(h.steps) +
    (dataRows ? '<h3>Data access</h3><div class="table-wrap"><table><thead><tr><th>Op</th><th>Model</th><th>Table</th><th>Line</th></tr></thead><tbody>' + dataRows + '</tbody></table></div>' : '') +
    (h.views.length ? '<h3>Views and the variables they receive</h3>' + h.views.map(function (v) {
      return '<div class="card" style="margin-bottom:8px"><div>' + (IDX.view.has(v.view) ? nodeLink(v.view) : '<code>' + esc(v.view) + '</code> <span class="muted small">(template file not found)</span>') + ' <span class="ln">L' + v.line + '</span></div>' +
        (v.vars.length ? '<div style="margin-top:6px">' + v.vars.map(function (x) { return pill(x); }).join('') + '</div>' : '<div class="muted small">No variables detected.</div>') + '</div>';
    }).join('') : '');
}

function viewPanel(v) {
  var users = v.renderedBy.map(function (id) { return nodeLink(id); });
  var parents = (IN.get(v.id) || []).filter(function (e) { return e.kind === 'includes' || e.kind === 'extends'; }).map(function (e) { return e.from; });
  var ref = function (x) { return IDX.view.has(x) ? nodeLink(x) : '<code>' + esc(x) + '</code>'; };
  var target = function (route, raw) {
    var r = route && IDX.route.get(route);
    if (!r) return '<span class="muted small">' + esc(raw) + '</span>';
    var h = r.handler && IDX.handler.get(r.handler);
    return method(r.method) + ' ' + nodeLink(r.id, r.path) + (h ? ' → ' + nodeLink(h.id) : '');
  };
  return '<div class="cx-head"><h2>' + esc(v.name) + '</h2>' + loc(v.file) + ' <span class="muted small">' + esc(v.engine) + ' · ' + fmt(v.lines) + ' lines' + (v.isLayout ? ' · layout' : '') + '</span></div>' +
    '<dl class="kv">' +
    '<dt>Rendered by</dt><dd>' + (users.length ? users.join(', ') : '<span class="muted">no handler found</span>') + '</dd>' +
    (v.extends.length ? '<dt>Extends</dt><dd>' + v.extends.map(ref).join(', ') + '</dd>' : '') +
    (v.includes.length ? '<dt>Includes</dt><dd>' + v.includes.map(ref).join(', ') + '</dd>' : '') +
    (parents.length ? '<dt>Used by templates</dt><dd>' + parents.map(ref).join(', ') + '</dd>' : '') +
    (v.sections.length ? '<dt>Sections / blocks</dt><dd>' + v.sections.map(function (s) { return pill(s); }).join('') + '</dd>' : '') +
    (v.scripts.length ? '<dt>Scripts</dt><dd>' + v.scripts.map(function (s) { return '<code>' + esc(s) + '</code>'; }).join(' ') + '</dd>' : '') +
    '</dl>' +
    '<h3>Variables it expects</h3>' + (v.vars.length ? v.vars.map(function (x) { return pill(x); }).join('') : '<p class="muted small">None detected.</p>') +
    (v.forms.length ? '<h3>Forms</h3><div class="table-wrap"><table><thead><tr><th>Method</th><th>Action</th><th>Reaches</th><th>Line</th></tr></thead><tbody>' + v.forms.map(function (f) {
      return '<tr><td>' + method(f.method) + '</td><td class="path">' + esc(f.action) + (f.multipart ? ' ' + pill('multipart') : '') + '</td><td>' + target(f.route, 'unresolved') + '</td><td class="ln">L' + f.line + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '') +
    (v.calls.length ? '<h3>JavaScript calls to the server</h3><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Method</th><th>URL</th><th>Reaches</th><th>Line</th></tr></thead><tbody>' + v.calls.map(function (c) {
      return '<tr><td>' + esc(c.kind) + '</td><td>' + method(c.method) + '</td><td class="path">' + esc(c.url) + '</td><td>' + target(c.route, '') + '</td><td class="ln">L' + c.line + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '') +
    (v.links.length ? '<h3>Links (' + v.links.length + ')</h3><div class="table-wrap" style="max-height:340px"><table><tbody>' + v.links.map(function (l) {
      return '<tr><td class="path">' + esc(l.url) + '</td><td>' + target(l.route, '') + '</td><td class="ln">L' + l.line + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '');
}
