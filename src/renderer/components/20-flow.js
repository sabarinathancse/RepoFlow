/* Request lifecycle (from the adapter) and the middleware inventory. */
section({
  id: 'flow', title: 'How a request works',
  visible: function () { return G.lifecycle.length > 0; },
  render: function (el) {
    var steps = G.lifecycle;
    var mwUse = {};
    G.routes.forEach(function (r) { r.middleware.forEach(function (m) { var k = m.split(':')[0]; mwUse[k] = (mwUse[k] || 0) + 1; }); });
    var resp = {};
    G.handlers.forEach(function (h) { h.responses.forEach(function (r) { resp[r] = (resp[r] || 0) + 1; }); });
    var respNames = { html: 'Render an HTML page', json: 'Return JSON (API / AJAX)', redirect: 'Redirect (usually after a form POST)', file: 'Send a file / download', text: 'Plain response', error: 'Error responses (404 / abort)' };
    el.innerHTML = '<h1>How a request travels</h1><p class="lead">The path every request follows in this project, derived from the detected framework' +
      (G.frameworks.length > 1 ? 's' : '') + '. Click each step.</p>' +
      '<div class="flow" id="reqFlow">' + steps.map(function (s, i) {
        return (i ? '<span class="arrow" aria-hidden="true">→</span>' : '') +
          '<button class="step" type="button" aria-pressed="' + (i === 0) + '" data-i="' + i + '"><div class="i">STEP ' + (i + 1) + '</div><div class="t">' + esc(s.title) + '</div><div class="s">' + esc(s.subtitle || '') + '</div></button>';
      }).join('') + '</div><div class="card detail" id="reqDetail"></div>' +
      (Object.keys(resp).length ? '<h2>Response patterns used</h2><div class="grid g3">' + Object.keys(resp).sort(function (a, b) { return resp[b] - resp[a]; }).map(function (r) {
        return '<div class="card"><b>' + esc(respNames[r] || r) + '</b><p class="muted" style="margin:6px 0 0">' + plural(resp[r], 'handler') + '</p></div>';
      }).join('') + '</div>' : '') +
      '<h2>Middleware and filters</h2>' + (G.middleware.length
        ? '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Routes using it</th><th>What it does</th><th>Defined in</th></tr></thead><tbody>' +
          G.middleware.map(function (m) {
            return '<tr><td><b>' + esc(m.name) + '</b></td><td>' + pill(m.kind, m.kind === 'global' ? 'ok' : '') + '</td><td>' + (m.kind === 'global' ? 'all' : (mwUse[m.name] || 0)) + '</td><td class="small">' + esc(m.description || '') + '</td><td class="small">' + loc(m.file, m.line) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No middleware, filters or decorators that guard routes were found.'));
    var show = function (i) {
      var s = steps[i];
      $$('#reqFlow .step').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i)); });
      $('#reqDetail').innerHTML = '<h3 style="margin-top:0">' + (i + 1) + ' · ' + esc(s.title) + '</h3><p style="margin:0">' + esc(s.detail) + '</p>' +
        (s.files && s.files.length ? '<p class="small muted" style="margin:8px 0 0">' + s.files.map(function (f) { return loc(f); }).join(' ') + '</p>' : '');
    };
    $('#reqFlow').addEventListener('click', function (e) { var b = e.target.closest('.step'); if (b) show(Number(b.dataset.i)); });
    $('#reqFlow').addEventListener('keydown', function (e) {
      var cur = Number((document.activeElement && document.activeElement.dataset.i) || 0);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var n = Math.max(0, Math.min(steps.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
        $$('#reqFlow .step')[n].focus(); show(n);
      }
    });
    show(0);
  }
});
