/* Heuristic findings: security, secrets, maintainability. */
section({
  id: 'findings', title: 'Findings',
  count: function () { var n = G.stats.critical + G.stats.high; return n ? n + ' high' : G.findings.length; },
  render: function (el, params) {
    var sevs = ['critical', 'high', 'medium', 'low', 'info'];
    var cats = uniq(G.findings.map(function (f) { return f.category; })).sort();
    el.innerHTML = '<h1>Findings</h1><p class="lead">Heuristic static checks: each one is a lead to verify in the code, not a confirmed vulnerability. Secret values are masked.</p>' +
      (G.findings.length ? '<div class="toolbar" id="sevChips"></div><div class="toolbar" id="catChips"></div><div class="grid" id="findList"></div>' : empty('No findings: none of the heuristic checks matched.'));
    if (!G.findings.length) return;
    var state = { sev: [], cat: '' };
    chips($('#sevChips'), sevs.filter(function (s) { return G.stats[s]; }).map(function (s) { return { v: s, label: s, n: G.stats[s] }; }), function (v) { state.sev = v; draw(); }, true);
    if (cats.length > 1) chips($('#catChips'), [{ v: '', label: 'All categories', on: true }].concat(cats.map(function (c) { return { v: c, label: c }; })), function (v) { state.cat = v[0] || ''; draw(); });
    function draw() {
      var list = G.findings.filter(function (f) { return (!state.sev.length || state.sev.indexOf(f.severity) >= 0) && (!state.cat || f.category === state.cat); });
      $('#findList').innerHTML = list.map(function (f) {
        return '<details class="card" id="' + esc(f.id.replace(':', '-')) + '"' + (params.id === f.id ? ' open' : '') + '><summary>' + sev(f.severity) + '<b>' + esc(f.title) + '</b>' + (f.file ? '<span class="muted small">' + esc(f.file) + (f.line ? ':' + f.line : '') + '</span>' : '') + '</summary><div>' +
          '<p style="margin-top:0">' + esc(f.detail) + '</p><p class="small muted">Rule <code>' + esc(f.rule) + '</code> · ' + esc(f.category) + (f.file ? ' · ' + loc(f.file, f.line) : '') + '</p>' +
          (f.evidence && f.evidence.length ? '<ul class="small">' + f.evidence.map(function (e) { return '<li>' + loc(e.file, e.line) + '</li>'; }).join('') + '</ul>' : '') + '</div></details>';
      }).join('') || '<p class="muted">No findings match.</p>';
    }
    draw();
    if (params.id) { var d = document.getElementById(params.id.replace(':', '-')); if (d) d.scrollIntoView({ block: 'center' }); }
  }
});
