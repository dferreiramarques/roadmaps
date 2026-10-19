'use strict';
// Public page for one shared roadmap: /r/<id>.
//
// It draws the roadmap in the normal DOM, with the same classes as the app (app.css), instead of through the embed
// widget: a shadow root is invisible to page translators (Google's translation proxy leaves its text in the original
// language), and a plain page is also what search engines and screen readers read best. The widget stays the way to
// show a roadmap on other sites.
(function () {
  var COLS = [
    { id: 'now', label: 'Now', sub: 'Working on' },
    { id: 'next', label: 'Next', sub: 'Up next' },
    { id: 'later', label: 'Later', sub: 'On the horizon' }
  ];
  var TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
  var ROCKET = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c3 2.5 4.5 6 4.5 9.5V16l2 3h-4L12 22l-2.5-3h-4l2-3v-4.5C7.5 8 9 4.5 12 2z"/><circle cx="12" cy="10" r="1.6"/></svg>';
  var CAL = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';

  var id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  var box = document.getElementById('rm');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function day(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function list(v) { return Array.isArray(v) ? v : []; }

  // let feed readers and browsers discover the Atom feed
  var feed = document.createElement('link');
  feed.rel = 'alternate'; feed.type = 'application/atom+xml'; feed.title = 'Roadmap updates'; feed.href = '/r/' + encodeURIComponent(id) + '/feed.atom';
  document.head.appendChild(feed);

  function card(it) {
    var c = el('article', 'card'); c.setAttribute('role', 'listitem');
    c.append(el('h3', 'card__title', it.title));
    if (it.description) c.append(el('p', 'card__desc', it.description));
    if (it.tag || it.when) {
      var foot = el('div', 'card__foot');
      if (it.tag) { var t = el('span', 'tag', it.tag); t.setAttribute('data-tone', TONES.indexOf(it.tone) >= 0 ? it.tone : 'secondary'); foot.append(t); }
      if (it.when) { var w = el('span', 'card__when', it.when); w.title = 'When'; w.insertAdjacentHTML('afterbegin', CAL); foot.append(w); }
      c.append(foot);
    }
    return c;
  }

  function column(def, items) {
    var col = el('section', 'col'); col.setAttribute('data-col', def.id);
    var head = el('div', 'col__head');
    head.append(el('span', 'col__dot'), el('span', 'col__title', def.label), el('span', 'col__sub', def.sub), el('span', 'col__count', String(items.length)));
    var body = el('div', 'col__list'); body.setAttribute('role', 'list');
    if (!items.length) body.append(el('div', 'empty', 'Nothing planned here yet.'));
    items.forEach(function (it) { body.append(card(it)); });
    col.append(head, body);
    return col;
  }

  function shippedPanel(p) {
    var panel = el('section', 'shippedbox');
    var h = el('h2', 'shippedbox__title', 'Shipped');
    if (p.version) h.append(el('small', '', ' Version ' + p.version));
    panel.append(h);
    var cur = list(p.shipped);
    if (!cur.length) panel.append(el('p', 'dialog__msg dim', 'Nothing shipped in this version yet.'));
    else {
      var ships = el('div', 'ships');
      cur.forEach(function (x) {
        var row = el('div', 'ship');
        var main = el('div', 'ship__main'); main.append(el('strong', '', x.title));
        if (x.description) main.append(el('span', 'ship__desc ship__desc--wrap', x.description));
        row.append(main, el('span', 'ship__date', day(x.shippedAt)));
        ships.append(row);
      });
      panel.append(ships);
    }
    var prev = list(p.releases);
    if (prev.length) {
      var line = el('p', 'shippedbox__prev', 'Previous versions: ');
      prev.forEach(function (v, i) {
        if (i) line.append(document.createTextNode(' · '));
        var a = el('a', '', v.version);
        a.href = '/r/' + encodeURIComponent(id) + '/changelog/' + encodeURIComponent(v.version) + '.md';
        line.append(a);
      });
      panel.append(line);
    }
    return panel;
  }

  function render(p) {
    document.documentElement.lang = p.lang || 'en';        // lets browsers and translators know what it is written in
    document.title = p.name + ' · Roadmap';
    box.replaceChildren();

    var hero = el('section', 'hero');
    hero.append(el('h1', '', p.name));
    if (p.tagline) hero.append(el('p', 'hero__tag', p.tagline));
    if (/^https?:\/\/\S+$/i.test(p.url || '')) {
      var meta = el('div', 'hero__meta'); var a = el('a', '', p.url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
      a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; meta.append(a); hero.append(meta);
    }
    box.append(hero);

    var cols = el('section', 'cols'); cols.setAttribute('aria-label', 'Roadmap');
    COLS.forEach(function (d) { cols.append(column(d, list(p[d.id]))); });
    box.append(cols);

    var foot = el('div', 'pubfoot');
    var panel = null;
    if (list(p.shipped).length || list(p.releases).length) {
      var btn = el('button', 'btn btn--outline'); btn.type = 'button';
      btn.insertAdjacentHTML('afterbegin', ROCKET); btn.append(document.createTextNode(' Shipped'));
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () {
        if (panel) { panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false'); return; }
        panel = shippedPanel(p); box.append(panel); btn.setAttribute('aria-expanded', 'true');
      });
      foot.append(btn);
    }
    if (p.updatedAt) { var d = new Date(p.updatedAt); if (!isNaN(d)) foot.append(el('span', 'pubfoot__note', 'Last updated ' + day(d.getTime()))); }
    var mine = (navigator.language || 'en').slice(0, 2).toLowerCase();
    var theirs = String(p.lang || 'en').slice(0, 2).toLowerCase();
    if (mine !== theirs) {
      var tr = el('a', 'pubfoot__link', 'Translate this page');
      tr.href = 'https://translate.google.com/translate?sl=' + encodeURIComponent(theirs) + '&tl=' + encodeURIComponent(mine) + '&u=' + encodeURIComponent(location.href);
      tr.rel = 'noopener';
      foot.append(tr);
    }
    var fa = el('a', 'pubfoot__link', 'Updates feed'); fa.href = '/r/' + encodeURIComponent(id) + '/feed.atom'; foot.append(fa);
    box.append(foot);
  }

  fetch('/api/public/' + encodeURIComponent(id), { cache: 'no-cache' })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.message || r.status); return j; }); })
    .then(render)
    .catch(function (e) {
      box.replaceChildren(el('div', 'empty', e && e.message && e.message.length < 120 ? e.message : 'The roadmap couldn’t be loaded right now.'));
    });
})();
