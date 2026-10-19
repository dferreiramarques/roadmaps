'use strict';
// Public page for one shared roadmap: /r/<id>. It is the embed widget in "header" mode, so the page and the
// embedded copies on other sites are always identical.
(function () {
  var id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  var box = document.getElementById('rm');
  box.setAttribute('data-roadmap', id);
  box.setAttribute('data-header', 'true');          // embed.js mounts it once the page has loaded
  var feed = document.createElement('link');        // lets feed readers and browsers discover the Atom feed
  feed.rel = 'alternate'; feed.type = 'application/atom+xml'; feed.title = 'Roadmap updates'; feed.href = '/r/' + encodeURIComponent(id) + '/feed.atom';
  document.head.appendChild(feed);

  fetch('/api/public/' + encodeURIComponent(id), { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (p) { document.title = p.name + ' · Roadmap'; })
    .catch(function () { /* the widget shows its own message */ });
})();
