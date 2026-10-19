'use strict';
// Public page for one product: /p/<id>. It is just the embed widget in "header" mode.
(function () {
  var id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  var box = document.getElementById('rm');
  box.setAttribute('data-roadmap', id);
  box.setAttribute('data-header', 'true');          // the embed script mounts it when the page has loaded

  fetch('/api/products/' + encodeURIComponent(id), { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (p) { document.title = p.name + ' · Roadmap'; })
    .catch(function () { /* the widget shows its own message */ });
})();
