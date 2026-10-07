/* Connections: walk the project graph from any node (impact analysis). */
var EDGE_LABEL = {
  'routes-to': ['routes to', 'reached by route'], renders: ['renders', 'rendered by'], 'uses-model': ['uses model', 'used by'],
  'maps-to-table': ['stored in table', 'model'], reads: ['reads', 'read by'], writes: ['writes', 'written by'], extends: ['extends', 'extended by'],
  includes: ['includes', 'included by'], 'submits-to': ['submits to', 'form submitted from'], 'links-to': ['links to', 'linked from'],
  calls: ['calls', 'called from'], 'relates-to': ['relates to', 'referenced by'], 'protected-by': ['protected by', 'protects'],
  'loads-script': ['loads script', 'loaded by'], contains: ['contains', 'belongs to']
};
section({
  id: 'connections', title: 'Connections',
  visible: function () { return G.edges.length > 0; },
  count: function () { return fmt(G.edges.length); },
  render: function (el, params) {
    el.innerHTML = '<h1>Connections</h1><p class="lead">Pick anything (a route, handler, view, model, table or script) to see what it depends on and what depends on it. ' +
      'Use it to judge the impact of a change: follow the links to walk the graph.</p>' +
      '<div class="toolbar"><input class="search" id="connSearch" type="search" placeholder="Find a node…" aria-label="Find a node" list="connList"><datalist id="connList"></datalist></div><div id="connBody"></div>';
    var ids = [];
    OUT.forEach(function (_, k) { ids.push(k); });
    IN.forEach(function (_, k) { if (!OUT.has(k)) ids.push(k); });
    var byLabel = {};
    ids.forEach(function (id) { byLabel[typeOf(id) + ' · ' + labelOf(id)] = id; });
    $('#connList').innerHTML = Object.keys(byLabel).sort().slice(0, 4000).map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
    $('#connSearch').addEventListener('change', function (e) { var id = byLabel[e.target.value]; if (id) navigate('connections', 'id=' + encodeURIComponent(id)); });
    var id = params.id;
    if (!id) {
      var hubs = ids.map(function (i) { return [i, (OUT.get(i) || []).length + (IN.get(i) || []).length]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 18);
      $('#connBody').innerHTML = '<h2>Most connected</h2><div class="grid g3">' + hubs.map(function (h) {
        return '<div class="card"><span class="muted small">' + esc(typeOf(h[0])) + '</span><br><button class="link" data-conn="' + esc(h[0]) + '">' + esc(labelOf(h[0])) + '</button><div class="small muted">' + h[1] + ' connections</div></div>';
      }).join('') + '</div>';
    } else {
      $('#connSearch').value = typeOf(id) + ' · ' + labelOf(id);
      var group = function (edges, dir) {
        var by = {};
        edges.forEach(function (e) { var k = EDGE_LABEL[e.kind] ? EDGE_LABEL[e.kind][dir] : e.kind; (by[k] = by[k] || []).push(dir === 0 ? e.to : e.from); });
        var keys = Object.keys(by);
        if (!keys.length) return '<p class="muted small">Nothing.</p>';
        return keys.map(function (k) {
          var list = uniq(by[k]);
          return '<h3>' + esc(k) + ' <span class="muted small">(' + list.length + ')</span></h3><ul class="small">' + list.slice(0, 80).map(function (x) {
            return '<li><span class="muted">' + esc(typeOf(x)) + '</span> <button class="link" data-conn="' + esc(x) + '">' + esc(labelOf(x)) + '</button></li>';
          }).join('') + (list.length > 80 ? '<li class="muted">… ' + (list.length - 80) + ' more</li>' : '') + '</ul>';
        }).join('');
      };
      $('#connBody').innerHTML = '<div class="card" style="margin-bottom:14px"><span class="muted small">' + esc(typeOf(id)) + '</span><h2 style="margin:2px 0">' + esc(labelOf(id)) + '</h2>' +
        '<button class="link" data-go="' + esc(id) + '">Open its details →</button></div>' +
        '<div class="split"><div class="card"><h2 style="margin-top:0">Depends on →</h2>' + group(OUT.get(id) || [], 0) + '</div><div class="card"><h2 style="margin-top:0">← Used by</h2>' + group(IN.get(id) || [], 1) + '</div></div>';
    }
    el.addEventListener('click', function (e) { var b = e.target.closest('[data-conn]'); if (b) navigate('connections', 'id=' + encodeURIComponent(b.dataset.conn)); });
  }
});
