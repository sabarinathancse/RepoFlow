/* How to change things: framework-specific recipes from the adapters. */
section({
  id: 'recipes', title: 'How to change things',
  visible: function () { return G.recipes.length > 0; },
  render: function (el) {
    el.innerHTML = '<h1>How to implement common changes</h1><p class="lead">Step-by-step recipes for the framework' + (G.frameworks.length > 1 ? 's' : '') + ' used here, pointing at this project\'s own files.</p>' +
      '<div class="grid">' + G.recipes.map(function (r, i) {
        return '<details class="card"' + (i === 0 ? ' open' : '') + '><summary><b>' + esc(r.title) + '</b><span class="muted small">' + esc(r.summary) + '</span></summary><div><ol class="recipe">' +
          r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
          (r.files.length ? '<p class="small muted">Files: ' + r.files.map(function (f) { return '<code>' + esc(f) + '</code>'; }).join(' ') + '</p>' : '') + '</div></details>';
      }).join('') + '</div>';
  }
});
