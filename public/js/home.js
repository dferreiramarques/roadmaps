'use strict';
// Directory of the public products.
(function () {
  var dir = document.getElementById('dir');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  fetch('/api/products', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (list) {
      if (!list.length) { dir.append(el('div', 'empty', 'No public roadmaps yet.')); return; }
      list.forEach(function (p) {
        var a = el('a', 'dcard');
        a.href = '/p/' + encodeURIComponent(p.id);
        a.append(el('h2', '', p.name));
        if (p.tagline) a.append(el('p', '', p.tagline));
        var counts = el('div', 'dcard__counts');
        [['now', 'Now', 'success'], ['next', 'Next', 'info'], ['later', 'Later', 'secondary']].forEach(function (c) {
          var t = el('span', 'tag', c[1] + ' ' + (p.counts ? p.counts[c[0]] : 0));
          t.setAttribute('data-tone', c[2]);
          counts.append(t);
        });
        a.append(counts);
        dir.append(a);
      });
    })
    .catch(function () { dir.append(el('div', 'empty', 'The list of products couldn’t be loaded right now.')); });
})();
