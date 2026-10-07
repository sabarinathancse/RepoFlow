/* Folder structure tree with descriptions. */
section({
  id: 'folders', title: 'Folder structure',
  count: function () { return fmt(G.stats.files); },
  render: function (el) {
    el.innerHTML = '<h1>Folder structure</h1><p class="lead">Click folders to expand. Descriptions come from the framework adapter and common conventions; ' +
      '<span class="tag secret">secret</span> marks files that may hold credentials, <span class="tag">not scanned</span> marks dependencies and generated output.</p>' +
      '<div class="toolbar"><input class="search" id="treeFilter" type="search" placeholder="Find a file or folder…" aria-label="Filter the tree">' +
      '<button class="chip" id="expandAll" type="button">Expand all</button><button class="chip" id="collapseAll" type="button">Collapse all</button></div>' +
      '<div class="card"><ul class="tree" id="tree"></ul></div>';
    function node(n, depth) {
      var tags = (n.tags || []).map(function (t) { return '<span class="tag ' + esc(t.replace(/\s/g, '-')) + '">' + esc(t) + '</span>'; }).join(' ');
      if (n.type === 'file') {
        return '<li data-p="' + esc(n.path.toLowerCase()) + '"><div class="row"><span class="tog"></span><span class="name">' + esc(n.name) + '</span>' + tags + (n.description ? '<span class="desc">' + esc(n.description) + '</span>' : '') + '</div></li>';
      }
      var kids = n.children || [];
      var open = depth < 1;
      return '<li class="' + (open ? '' : 'closed') + '" data-p="' + esc(n.path.toLowerCase()) + '"><div class="row dir" role="button" tabindex="0" aria-expanded="' + open + '"><span class="tog">' + (kids.length ? (open ? '▾' : '▸') : '') + '</span><span class="name">' + esc(n.name) + '/</span>' +
        (n.files ? '<span class="desc small">' + fmt(n.files) + ' files</span>' : '') + tags + (n.description ? '<span class="desc">' + esc(n.description) + '</span>' : '') + '</div>' +
        (kids.length ? '<ul>' + kids.map(function (k) { return node(k, depth + 1); }).join('') + (n.truncated ? '<li><div class="row"><span class="tog"></span><span class="desc">… ' + fmt(n.truncated) + ' more files</span></div></li>' : '') + '</ul>' : '') + '</li>';
    }
    var tree = $('#tree');
    tree.innerHTML = node(G.folders, 0);
    function setOpen(li, open) {
      li.classList.toggle('closed', !open);
      var row = li.querySelector(':scope > .row');
      var tog = row && row.querySelector('.tog');
      if (row) row.setAttribute('aria-expanded', String(open));
      if (tog && tog.textContent) tog.textContent = open ? '▾' : '▸';
    }
    function toggle(row) { var li = row.parentElement; setOpen(li, li.classList.contains('closed')); }
    tree.addEventListener('click', function (e) { var r = e.target.closest('.row.dir'); if (r) toggle(r); });
    tree.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('dir')) { e.preventDefault(); toggle(e.target); } });
    $('#expandAll').onclick = function () { $$('li', tree).forEach(function (li) { if (li.querySelector('ul')) setOpen(li, true); }); };
    $('#collapseAll').onclick = function () { $$('li', tree).forEach(function (li, i) { if (li.querySelector('ul')) setOpen(li, i === 0); }); };
    var timer;
    $('#treeFilter').addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = e.target.value.trim().toLowerCase();
        $$('.row.hit', tree).forEach(function (r) { r.classList.remove('hit'); });
        if (!q) return;
        var hits = $$('li', tree).filter(function (li) { var p = li.dataset.p || ''; return p.slice(p.lastIndexOf('/') + 1).indexOf(q) >= 0; }).slice(0, 200);
        hits.forEach(function (li) {
          li.querySelector(':scope > .row').classList.add('hit');
          for (var p = li.parentElement; p && p !== tree; p = p.parentElement) if (p.tagName === 'LI') setOpen(p, true);
        });
        if (hits[0]) hits[0].scrollIntoView({ block: 'center' });
      }, 150);
    });
  }
});
