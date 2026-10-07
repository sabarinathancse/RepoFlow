/* External integrations with source evidence. */
section({
  id: 'integrations', title: 'Integrations',
  visible: function () { return G.integrations.length > 0; },
  count: function () { return G.integrations.length; },
  render: function (el) {
    var cats = uniq(G.integrations.map(function (i) { return i.category; }));
    el.innerHTML = '<h1>External integrations</h1><p class="lead">Services and infrastructure this project talks to, detected from dependency manifests, configuration keys and code. Credentials are never copied into this report.</p>' +
      cats.map(function (c) {
        return '<h2>' + esc(c) + '</h2><div class="grid g3">' + G.integrations.filter(function (i) { return i.category === c; }).map(function (i) {
          return '<div class="card"><h3>' + esc(i.name) + '</h3><ul class="small" style="margin:0;padding-left:16px">' + i.evidence.map(function (e) {
            return '<li>' + loc(e.file, e.line) + '<br><code class="code">' + esc(e.text) + '</code></li>';
          }).join('') + '</ul></div>';
        }).join('') + '</div>';
      }).join('');
  }
});
