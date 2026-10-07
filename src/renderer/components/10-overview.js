/* Overview: what the project is, technology, and the big picture by layer. */
section({
  id: 'overview', title: 'Overview',
  render: function (el) {
    var s = G.stats;
    var fws = G.frameworks.filter(function (f) { return f.id !== 'generic'; });
    var lead = G.project.description ? esc(G.project.description) + ' ' : '';
    lead += fws.length
      ? 'RepoFlow detected <b>' + fws.map(function (f) { return esc(f.name) + (f.root !== '.' ? ' <span class="muted">(in ' + esc(f.root) + '/)</span>' : ''); }).join(', ') + '</b> and mapped how requests flow through the code.'
      : 'No supported web framework was detected, so this report focuses on structure, dependencies, data and findings.';
    var stats = [
      ['Files', s.files, 'folders'], ['Lines of code', s.lines, 'folders'], ['Routes', s.routes, 'routes'], ['Handlers', s.handlers, 'code'],
      ['Models', s.models, 'data'], ['Tables', s.tables, 'data'], ['Views', s.views, 'frontend'], ['Integrations', s.integrations, 'integrations'],
      ['Findings', s.findings, 'findings']
    ].filter(function (x) { return x[1] || ['Files', 'Lines of code', 'Findings'].indexOf(x[0]) >= 0; });
    var langTotal = G.languages.reduce(function (a, l) { return a + l.lines; }, 0) || 1;
    var palette = ['#2f6b4f', '#2f6b9a', '#a2572a', '#7a4fa0', '#0f766e', '#b45309', '#be185d', '#5d6763'];
    var langs = G.languages.slice(0, 8);
    var deps = G.dependencies.filter(function (d) { return !d.dev; });

    el.innerHTML =
      '<h1>' + esc(G.project.name) + '</h1><p class="lead">' + lead + '</p>' +
      '<div class="grid g4">' + stats.map(function (x) {
        return '<button class="card stat" type="button" data-nav="' + x[2] + '"><div class="v">' + fmt(x[1]) + '</div><div class="k">' + x[0] + '</div></button>';
      }).join('') + '</div>' +
      '<h2>Technology</h2><div class="grid g3">' +
      (fws.length ? fws : G.frameworks).map(function (f) {
        return '<div class="card"><h3>' + esc(f.name) + '</h3><dl class="kv">' +
          '<dt>Language</dt><dd>' + esc(f.language) + '</dd>' +
          (f.version ? '<dt>Version</dt><dd>' + esc(f.version) + '</dd>' : '') +
          '<dt>App root</dt><dd><code>' + esc(f.root === '.' ? './' : f.root + '/') + '</code></dd>' +
          '<dt>Detected from</dt><dd class="small">' + f.evidence.map(esc).join('<br>') + '</dd></dl></div>';
      }).join('') +
      '<div class="card"><h3>Languages</h3><div class="bar">' + langs.map(function (l, i) {
        return '<span style="width:' + (l.lines / langTotal * 100).toFixed(2) + '%;background:' + palette[i % palette.length] + '" title="' + esc(l.name) + '"></span>';
      }).join('') + '</div><div class="legend">' + langs.map(function (l, i) {
        return '<span><span class="dot" style="background:' + palette[i % palette.length] + '"></span>' + esc(l.name) + ' ' + Math.round(l.lines / langTotal * 100) + '% <span class="small">(' + fmt(l.files) + ' files)</span></span>';
      }).join('') + '</div></div>' +
      '<div class="card"><h3>Dependencies</h3>' + (deps.length
        ? '<p class="muted small" style="margin:0 0 6px">' + plural(deps.length, 'runtime package') + ' · ' + plural(G.dependencies.length - deps.length, 'dev package') + '</p>' +
          deps.slice(0, 14).map(function (d) { return pill(d.name + ' ' + d.version); }).join('') + (deps.length > 14 ? '<span class="muted small">+' + (deps.length - 14) + ' more</span>' : '')
        : '<p class="muted small" style="margin:0">No dependency manifest found.</p>') + '</div>' +
      '</div>' +
      '<h2>The project at a glance</h2><p class="muted small" style="margin-top:-4px">Each box is a layer of the running application. Click one for details.</p>' +
      '<div class="layers" id="layers"></div><div class="card detail" id="layerDetail"><span class="muted">Select a layer above.</span></div>' +
      (G.warnings.length ? '<div class="note warn"><b>Scan warnings</b><br>' + G.warnings.map(esc).join('<br>') + '</div>' : '');

    $$('[data-nav]', el).forEach(function (b) { b.addEventListener('click', function () { navigate(b.dataset.nav); }); });
    renderLayers();
  }
});

function renderLayers() {
  var calls = G.views.reduce(function (a, v) { return a + v.calls.length; }, 0) + G.scripts.reduce(function (a, s) { return a + s.calls.length; }, 0);
  var forms = G.views.reduce(function (a, v) { return a + v.forms.length; }, 0);
  var methods = {};
  G.routes.forEach(function (r) { methods[r.method] = (methods[r.method] || 0) + 1; });
  var resp = {};
  G.handlers.forEach(function (h) { h.responses.forEach(function (r) { resp[r] = (resp[r] || 0) + 1; }); });
  var layers = [
    { id: 'client', t: 'Browser / client', v: G.views.length + G.scripts.length, s: plural(G.views.length, 'template') + ', ' + plural(G.scripts.length, 'script'),
      d: '<p>Pages are produced by <b>' + plural(G.views.length, 'server template') + '</b>' + (G.scripts.length ? ' and enhanced by <b>' + plural(G.scripts.length, 'client script') + '</b>' : '') + '. ' +
        'They contain <b>' + plural(forms, 'form') + '</b> and <b>' + plural(calls, 'AJAX/fetch call') + '</b> back to the server.</p>' +
        '<button class="link" data-nav2="frontend">Open Views &amp; JavaScript →</button>' },
    { id: 'routing', t: 'Routing', v: G.routes.length, s: Object.keys(methods).map(function (m) { return methods[m] + ' ' + m; }).join(' · ') || 'no routes mapped',
      d: '<p>' + plural(G.routes.length, 'route') + ' map an HTTP method + URL to code. Largest groups: ' + topGroups().map(function (g) { return '<code>' + esc(g[0]) + '</code> (' + g[1] + ')'; }).join(', ') + '.</p>' +
        '<button class="link" data-nav2="routes">Open the routes explorer →</button>' },
    { id: 'middleware', t: 'Middleware / filters', v: G.middleware.length, s: plural(G.middleware.filter(function (m) { return m.kind === 'global'; }).length, 'global'),
      d: G.middleware.length ? '<ul>' + G.middleware.slice(0, 14).map(function (m) { return '<li><b>' + esc(m.name) + '</b> <span class="muted small">' + esc(m.kind) + '</span>' + (m.description ? ' — ' + esc(m.description) : '') + '</li>'; }).join('') + '</ul><button class="link" data-nav2="flow">See the request lifecycle →</button>' : '<p class="muted">No middleware or filters were found.</p>' },
    { id: 'handlers', t: 'Handlers', v: G.handlers.length, s: plural(G.containers.length, 'controller/module', 'controllers/modules'),
      d: '<p>Handlers are the controller methods / view functions that run for a route. Responses: ' + (Object.keys(resp).map(function (r) { return '<b>' + resp[r] + '</b> ' + esc(r); }).join(', ') || 'not detected') + '.</p><button class="link" data-nav2="code">Open the code explorer →</button>' },
    { id: 'data', t: 'Data', v: G.tables.length || G.models.length, s: plural(G.models.length, 'model') + ', ' + plural(G.tables.length, 'table'),
      d: '<p>' + plural(G.models.length, 'model') + ' over ' + plural(G.tables.length, 'table') + '. Most used tables: ' + G.tables.slice().sort(function (a, b) { return (b.readBy.length + b.writtenBy.length) - (a.readBy.length + a.writtenBy.length); }).slice(0, 6).map(function (t) { return '<code>' + esc(t.name) + '</code>'; }).join(', ') + '.</p><button class="link" data-nav2="data">Open data &amp; models →</button>' },
    { id: 'external', t: 'External services', v: G.integrations.length, s: uniq(G.integrations.map(function (i) { return i.category; })).slice(0, 3).join(', ') || 'none found',
      d: G.integrations.length ? '<ul>' + G.integrations.map(function (i) { return '<li><b>' + esc(i.name) + '</b> <span class="muted small">' + esc(i.category) + '</span></li>'; }).join('') + '</ul><button class="link" data-nav2="integrations">Open integrations →</button>' : '<p class="muted">No external services were detected.</p>' }
  ];
  var box = $('#layers');
  box.innerHTML = layers.map(function (l) {
    return '<button class="layer" type="button" aria-pressed="false" data-l="' + l.id + '"><div class="lt">' + esc(l.t) + '</div><div class="lv">' + fmt(l.v) + '</div><div class="ls">' + esc(l.s) + '</div></button>';
  }).join('');
  box.addEventListener('click', function (e) {
    var b = e.target.closest('.layer'); if (!b) return;
    $$('.layer', box).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    var l = layers.find(function (x) { return x.id === b.dataset.l; });
    $('#layerDetail').innerHTML = '<h3 style="margin-top:0">' + esc(l.t) + '</h3>' + l.d;
    $$('[data-nav2]', $('#layerDetail')).forEach(function (a) { a.addEventListener('click', function () { navigate(a.dataset.nav2); }); });
  });
}
function topGroups() {
  var c = {};
  G.routes.forEach(function (r) { c[r.group] = (c[r.group] || 0) + 1; });
  return Object.keys(c).map(function (k) { return [k, c[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
}
