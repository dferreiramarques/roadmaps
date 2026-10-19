/* Roadmap widget — shows a product's NOW / NEXT / LATER columns on any page.
 *
 *   <div data-roadmap="THE-ID-FROM-THE-SHARE-DIALOG" data-header="true"></div>
 *   <script src="https://YOUR-ROADMAPS-HOST/embed.js" defer></script>
 *
 * Optional attributes on the div:
 *   data-header="true"          also show the product name, tagline and link above the columns
 *   data-src="…"                where to read the data from (default: /api/public/<id> on the host that served this script;
 *                               a file shaped like {products:[…]} is understood too)
 *   data-theme="light|dark"     force a theme (default: follows <html data-theme> or the OS setting)
 *
 * A roadmap that has shipped features also gets a "Shipped" button: the current version's list, with links to the
 * Markdown changelog of each previous version (/r/<id>/changelog/<version>.md).
 *
 * It renders inside a shadow root, so the host page's CSS can't break it and it can't break the page.
 * All text from roadmap.json is inserted as text, never as HTML.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var BASE = script && script.src ? script.src.replace(/[^\/?#]*([?#].*)?$/, '') : '';

  var COLS = [
    { id: 'now',   label: 'Now',   sub: 'Working on' },
    { id: 'next',  label: 'Next',  sub: 'Up next' },
    { id: 'later', label: 'Later', sub: 'On the horizon' }
  ];
  var TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];

  // Same look as roadmap.html. Dark/light only swap colours; sizes live outside the theme blocks.
  var CSS = [
    ':host{display:block}',
    '*{box-sizing:border-box;margin:0}',
    '.rm{--r-sm:6px;--r-lg:12px;--r-xl:16px;--ring:3px;',
    '  --sh-sm:0 1px 2px var(--shadow-c);--sh-md:0 4px 6px -1px var(--shadow-c),0 2px 4px -2px var(--shadow-c);',
    '  font-family:inherit;font-size:15px;line-height:1.55;color:var(--text)}',
    '.rm[data-theme=light]{--surface:#fff;--surface-2:#f4f4f5;--surface-3:#e4e4e7;--border:#e4e4e7;--border-strong:#d4d4d8;--text:#18181b;--muted:#52525b;--subtle:#71717a;--shadow-c:rgba(24,24,27,.10);',
    '  --success:#059669;--info:#0284c7;--warn:#d97706;--danger:#dc2626;--secondary:#475569;--contrast:#18181b;--now:#10b981;--next:#0ea5e9;--later:#8b5cf6}',
    '.rm[data-theme=dark]{--surface:#18181b;--surface-2:#1f1f23;--surface-3:#27272a;--border:#27272a;--border-strong:#3f3f46;--text:#fafafa;--muted:#a1a1aa;--subtle:#71717a;--shadow-c:rgba(0,0,0,.55);',
    '  --success:#34d399;--info:#38bdf8;--warn:#fbbf24;--danger:#f87171;--secondary:#94a3b8;--contrast:#fafafa;--now:#34d399;--next:#38bdf8;--later:#a78bfa}',
    '.cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:start}',
    '@media(max-width:860px){.cols{grid-template-columns:1fr}}',
    '.col{--col:var(--now);background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-xl);padding:14px}',
    '.col[data-col=next]{--col:var(--next)}.col[data-col=later]{--col:var(--later)}',
    '.head{display:flex;align-items:center;gap:10px;padding:4px 4px 14px}',
    '.dot{width:10px;height:10px;border-radius:50%;background:var(--col);box-shadow:0 0 0 4px color-mix(in srgb,var(--col) 22%,transparent);flex-shrink:0}',
    '.col[data-col=now] .dot{animation:pulse 2.4s ease-in-out infinite}',
    '@keyframes pulse{0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,var(--col) 22%,transparent)}50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--col) 8%,transparent)}}',
    '.title{font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}',
    '.sub{color:var(--subtle);font-size:13px}',
    '.count{min-width:22px;height:22px;padding:0 7px;margin-left:auto;display:inline-grid;place-items:center;background:var(--surface-3);color:var(--muted);border-radius:999px;font-size:12px;font-weight:600}',
    '.list{display:flex;flex-direction:column;gap:10px}',
    '.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px 16px;box-shadow:var(--sh-sm);transition:border-color .14s,box-shadow .14s}',
    '.card:hover{border-color:var(--border-strong);box-shadow:var(--sh-md)}',
    '.card h3{font-size:15px;font-weight:600;letter-spacing:-.005em;line-height:1.35}',
    '.card p{margin-top:4px;color:var(--muted);font-size:13px;line-height:1.5}',
    '.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}.meta .tag{margin-top:0}',
    '.when{color:var(--subtle);font-size:12px}',
    '.tag{--tone:var(--secondary);display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--r-sm);background:color-mix(in srgb,var(--tone) 16%,transparent);color:var(--tone);font-size:12px;font-weight:700;line-height:1.5;white-space:nowrap}',
    '.tag[data-tone=success]{--tone:var(--success)}.tag[data-tone=info]{--tone:var(--info)}.tag[data-tone=warn]{--tone:var(--warn)}',
    '.tag[data-tone=danger]{--tone:var(--danger)}.tag[data-tone=secondary]{--tone:var(--secondary)}.tag[data-tone=contrast]{--tone:var(--contrast)}',
    '.empty{padding:18px 14px;border:1px dashed var(--border-strong);border-radius:var(--r-lg);color:var(--subtle);font-size:13px;text-align:center}',
    '.hero{margin-bottom:22px}.hero h2{font-size:28px;font-weight:700;letter-spacing:-.02em;line-height:1.2}',
    '.hero p{margin-top:6px;color:var(--muted);font-size:16px;max-width:60ch}.hero a{display:inline-block;margin-top:8px;color:var(--now);font-size:13px;font-weight:500;text-decoration:none}.hero a:hover{text-decoration:underline}',
    '.foot{margin-top:14px;color:var(--subtle);font-size:13px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
    '.shipbtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font:inherit;font-size:13px;font-weight:500;cursor:pointer}',
    '.shipbtn:hover{background:var(--surface-2)}.shipbtn:focus-visible{outline:2px solid var(--now);outline-offset:2px}',
    '.shipbtn svg{width:15px;height:15px;color:var(--now)}',
    '.shipped{margin-top:14px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-xl);padding:16px 18px}',
    '.shipped h3{font-size:15px;font-weight:700}.shipped h3 small{color:var(--subtle);font-weight:400;font-size:13px;margin-left:6px}',
    '.shipped ul{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-direction:column;gap:10px}',
    '.shipped li{display:grid;grid-template-columns:1fr auto;gap:2px 12px}.shipped li strong{font-size:14px;font-weight:600}',
    '.shipped li time{color:var(--subtle);font-size:12px;white-space:nowrap}.shipped li p{grid-column:1/-1;color:var(--muted);font-size:13px;line-height:1.5}',
    '.shipped .none{margin-top:10px;color:var(--subtle);font-size:13px}',
    '.shipped .prev{margin-top:16px;padding-top:12px;border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px;color:var(--subtle)}',
    '.shipped .prev a{color:var(--now);text-decoration:none;font-weight:500}.shipped .prev a:hover{text-decoration:underline}',
    '.msg{padding:24px;border:1px dashed var(--border-strong);border-radius:var(--r-lg);color:var(--muted);text-align:center}',
    '@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}'
  ].join('\n');

  function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

  function items(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (it) {
      var title = it && str(it.title, 80);
      if (!title) return;
      var at = Math.floor(Number(it.shippedAt));
      out.push({ title: title, description: str(it.description, 280), tag: str(it.tag, 20), tone: TONES.indexOf(it.tone) >= 0 ? it.tone : 'secondary', when: str(it.when, 12), shippedAt: at > 0 ? at : 0 });
    });
    return out;
  }

  function find(raw, id) {
    var products = raw && Array.isArray(raw.products) ? raw.products : [];
    var p = null;
    for (var i = 0; i < products.length; i++) if (products[i] && products[i].id === id) p = products[i];
    return p || (id ? null : products[0] || null);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pickTheme(host) {
    var forced = host.getAttribute('data-theme');
    if (forced === 'light' || forced === 'dark') return forced;
    var page = document.documentElement.getAttribute('data-theme');
    if (page === 'light' || page === 'dark') return page;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var ROCKET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c3 2.5 4.5 6 4.5 9.5V16l2 3h-4L12 22l-2.5-3h-4l2-3v-4.5C7.5 8 9 4.5 12 2z"/><circle cx="12" cy="10" r="1.6"/></svg>';
  var VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/;

  function day(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

  // the "Shipped" panel: the current version's entries, and a link to the Markdown changelog of every closed version
  function shippedPanel(product, id) {
    var box = el('section', 'shipped');
    var head = el('h3', '', 'Shipped');
    if (VERSION.test(product.version || '')) head.append(el('small', '', 'Version ' + product.version));
    box.append(head);
    var list = items(product.shipped);
    if (!list.length) box.append(el('p', 'none', 'Nothing shipped in this version yet.'));
    else {
      var ul = el('ul', '');
      list.forEach(function (it) {
        var li = el('li', '');
        li.append(el('strong', '', it.title), el('time', '', day(it.shippedAt)));
        if (it.description) li.append(el('p', '', it.description));
        ul.append(li);
      });
      box.append(ul);
    }
    var prev = Array.isArray(product.releases) ? product.releases.filter(function (v) { return v && VERSION.test(v.version || ''); }) : [];
    if (prev.length && id) {
      var row = el('div', 'prev');
      row.append(el('span', '', 'Previous versions'));
      prev.forEach(function (v) {
        var a = el('a', '', v.version);
        a.href = BASE + 'r/' + encodeURIComponent(id) + '/changelog/' + encodeURIComponent(v.version) + '.md';
        a.target = '_blank'; a.rel = 'noopener';
        row.append(a);
      });
      box.append(row);
    }
    return box;
  }

  function render(root, product, updatedAt, withHeader, id) {
    var cols = el('div', 'cols');
    COLS.forEach(function (c) {
      var list = items(product[c.id]);
      var col = el('section', 'col'); col.setAttribute('data-col', c.id);
      var head = el('div', 'head');
      head.append(el('span', 'dot'), el('span', 'title', c.label), el('span', 'sub', c.sub), el('span', 'count', String(list.length)));
      var body = el('div', 'list'); body.setAttribute('role', 'list');
      if (!list.length) body.append(el('div', 'empty', 'Nothing planned here yet.'));
      list.forEach(function (it) {
        var card = el('article', 'card'); card.setAttribute('role', 'listitem');
        card.append(el('h3', '', it.title));
        if (it.description) card.append(el('p', '', it.description));
        if (it.tag || it.when) {
          var meta = el('div', 'meta');
          if (it.tag) { var t = el('span', 'tag', it.tag); t.setAttribute('data-tone', it.tone); meta.append(t); }
          if (it.when) meta.append(el('span', 'when', it.when));
          card.append(meta);
        }
        body.append(card);
      });
      col.append(head, body);
      cols.append(col);
    });
    root.replaceChildren();
    if (withHeader) {
      var hero = el('header', 'hero');
      hero.append(el('h2', '', str(product.name, 40)));
      if (product.tagline) hero.append(el('p', '', str(product.tagline, 140)));
      if (/^https?:\/\/\S+$/i.test(product.url || '')) {
        var a = el('a', '', product.url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
        a.href = product.url; a.target = '_blank'; a.rel = 'noopener';
        hero.append(a);
      }
      root.append(hero);
    }
    root.append(cols);
    var foot = el('div', 'foot');
    var ymd = String(updatedAt || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      var d = new Date(ymd + 'T00:00:00');
      foot.append(el('span', '', 'Last updated ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
    }
    var hasShipped = (Array.isArray(product.shipped) && product.shipped.length) || (Array.isArray(product.releases) && product.releases.length);
    var panel = null;
    if (hasShipped) {
      var btn = el('button', 'shipbtn');
      btn.type = 'button';
      btn.innerHTML = ROCKET;           // static icon markup
      btn.append(document.createTextNode('Shipped'));
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () {
        if (panel) { panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false'); return; }
        panel = shippedPanel(product, id);
        root.append(panel);
        btn.setAttribute('aria-expanded', 'true');
      });
      foot.prepend(btn);
    }
    if (foot.childNodes.length) root.append(foot);
  }

  function mount(host) {
    if (host.__roadmap) return;
    host.__roadmap = true;
    var shadow = host.attachShadow({ mode: 'open' });
    var wrap = el('div', 'rm');
    // a constructed stylesheet works even on pages whose CSP forbids inline <style>
    if (shadow.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function' && CSSStyleSheet.prototype.replaceSync) {
      var sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); shadow.adoptedStyleSheets = [sheet];
    } else {
      var style = document.createElement('style'); style.textContent = CSS; shadow.append(style);
    }
    shadow.append(wrap);
    var paint = function () { wrap.setAttribute('data-theme', pickTheme(host)); };
    paint();
    if (window.MutationObserver) new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (window.matchMedia) { try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint); } catch (e) {} }

    var inner = el('div', '');
    wrap.append(inner);
    inner.append(el('div', 'msg', 'Loading roadmap…'));

    var wanted = host.getAttribute('data-roadmap') || '';
    var src = host.getAttribute('data-src') || BASE + 'api/public/' + encodeURIComponent(wanted);
    var header = host.hasAttribute('data-header') && host.getAttribute('data-header') !== 'false';
    fetch(src, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (raw) {
        var p = raw && Array.isArray(raw.products) ? find(raw, wanted) : raw;
        if (!p) throw new Error('unknown product');
        render(inner, p, raw.updatedAt, header, raw && raw.products ? '' : wanted);
      })
      .catch(function () { inner.replaceChildren(el('div', 'msg', 'The roadmap couldn’t be loaded right now.')); });
  }

  function run() { Array.prototype.forEach.call(document.querySelectorAll('[data-roadmap]'), mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  window.RoadmapsEmbed = { mount: mount };
})();
