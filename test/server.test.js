'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { cleanPublic } = require('../src/schema');

async function listen(app) {
  const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, host: `127.0.0.1:${server.address().port}`, close: () => new Promise(res => server.close(res)) };
}

// ── schema ──────────────────────────────────────────────────────────────────────────────
test('cleanPublic only accepts our own file shape and cleans everything', () => {
  assert.equal(cleanPublic(null), null);
  assert.equal(cleanPublic({ name: 'x' }), null, 'not marked as a roadmap');
  assert.equal(cleanPublic({ app: 'roadmaps-public', name: '   ' }), null, 'needs a name');
  const doc = cleanPublic({
    app: 'roadmaps-public', name: 'Evil\u0000   Name' + 'x'.repeat(100), tagline: 't', url: 'javascript:alert(1)',
    now: [{ title: '<img src=x onerror=alert(1)>', description: 'a\n\n b', tag: 't'.repeat(99), tone: 'rainbow' }, { title: '' }, null, 'str'],
    next: 'nope', later: Array.from({ length: 150 }, (_, i) => ({ title: 'item ' + i }))
  });
  assert.ok(doc.name.length <= 40 && !doc.name.includes('\u0000'));
  assert.equal(doc.url, '');
  assert.equal(doc.now.length, 1);
  assert.equal(doc.now[0].title, '<img src=x onerror=alert(1)>', 'kept as plain text — the UI only ever shows it as text');
  assert.equal(doc.now[0].tone, 'secondary');
  assert.equal(doc.now[0].tag.length, 20);
  assert.equal(doc.now[0].description, 'a b');
  assert.deepEqual(doc.next, []);
  assert.equal(doc.later.length, 100);
});

// ── public roadmaps ─────────────────────────────────────────────────────────────────────
function fakeDrive(files) {
  const calls = [];
  const impl = async url => {
    calls.push(String(url));
    const u = new URL(url);
    const id = u.pathname.split('/').pop();
    const f = files[id];
    if (!f) return new Response('{}', { status: 404 });
    if (f.fail) throw new Error('network down');
    if (u.searchParams.get('alt') === 'media') return new Response(JSON.stringify(f.doc), { status: 200 });
    return new Response(JSON.stringify({ modifiedTime: f.modifiedTime || '2026-10-19T10:00:00.000Z' }), { status: 200 });
  };
  impl.calls = calls;
  return impl;
}
const GOOD = { app: 'roadmaps-public', name: 'Acme', tagline: 'Hi', url: 'https://acme.example', now: [{ title: 'A', tag: 'Beta', tone: 'info' }], next: [], later: [] };

test('/api/public/:id reads a shared roadmap through the server', async () => {
  const drive = fakeDrive({ GOODFILE12345: { doc: GOOD }, NOTOURS123456: { doc: { hello: 'world' } } });
  const s = await listen(createApp({ env: { DRIVE_API_KEY: 'k' }, fetchImpl: drive }));
  try {
    const r = await fetch(s.base + '/api/public/GOODFILE12345');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const body = await r.json();
    assert.equal(body.name, 'Acme');
    assert.equal(body.id, 'GOODFILE12345');
    assert.equal(body.updatedAt, '2026-10-19T10:00:00.000Z');
    assert.equal(body.now[0].tone, 'info');

    const again = await fetch(s.base + '/api/public/GOODFILE12345', { headers: { 'If-None-Match': r.headers.get('etag') } });
    assert.equal(again.status, 304, 'ETag revalidation');
    assert.equal(drive.calls.length, 2, 'second request served from the short cache (one meta + one media call)');

    assert.equal((await fetch(s.base + '/api/public/NOTOURS123456')).status, 404, 'a Drive file that is not a roadmap is refused');
    assert.equal((await fetch(s.base + '/api/public/MISSINGFILE123')).status, 404, 'unshared / deleted');
    assert.equal((await fetch(s.base + '/api/public/short')).status, 404, 'bad id never reaches Drive');
    assert.equal((await fetch(s.base + '/api/public/..%2F..%2Fetc')).status, 404);
    assert.ok(drive.calls.every(c => c.startsWith('https://www.googleapis.com/drive/v3/files/')), 'only ever talks to the Drive files API');
  } finally { await s.close(); }
});

test('public roadmaps: not configured, Drive down, last good copy kept', async () => {
  const off = await listen(createApp({ env: {}, fetchImpl: fakeDrive({}) }));
  try { assert.equal((await fetch(off.base + '/api/public/GOODFILE12345')).status, 503); } finally { await off.close(); }

  const files = { DOWNFILE123456: { fail: true } };
  const down = await listen(createApp({ env: { DRIVE_API_KEY: 'k' }, fetchImpl: fakeDrive(files) }));
  try { assert.equal((await fetch(down.base + '/api/public/DOWNFILE123456')).status, 502); } finally { await down.close(); }
});

test('public endpoint is rate limited per IP', async () => {
  const s = await listen(createApp({ env: { DRIVE_API_KEY: 'k' }, fetchImpl: fakeDrive({ GOODFILE12345: { doc: GOOD } }) }));
  try {
    let last;
    for (let i = 0; i < 125; i++) last = await fetch(s.base + '/api/public/GOODFILE12345');
    assert.equal(last.status, 429);
  } finally { await s.close(); }
});

// ── Google sign-in (against a fake Google) ──────────────────────────────────────────────
function fakeGoogle() {
  const tokOf = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
  const idTok = tokOf({ sub: 'u1', email: 'a@b.c', name: 'A B', given_name: 'A', picture: 'p' });
  const bareTok = tokOf({ sub: 'u1', email: 'a@b.c' });   // what Google may return on a refresh
  const state = { revoked: [], mode: 'ok', bare: false, userinfo: [], scope: 'openid email https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file', refresh: true };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/revoke') { state.revoked.push(p.token); return res.end('{}'); }
      if (req.url === '/userinfo') { state.userinfo.push(req.headers.authorization); return res.end(JSON.stringify({ sub: 'u1', email: 'a@b.c', name: 'A B', given_name: 'A', picture: 'p' })); }
      if (p.grant_type === 'authorization_code') {
        if (p.client_secret !== 'SECRET' || p.code !== 'CODE1') { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
        return res.end(JSON.stringify({ access_token: 'AT1', expires_in: 3599, scope: state.scope, id_token: idTok, ...(state.refresh ? { refresh_token: 'RT1' } : {}) }));
      }
      if (state.mode === 'revoked' || p.refresh_token !== 'RT1') { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      if (state.mode === 'down') { res.writeHead(503); return res.end('{}'); }
      res.end(JSON.stringify({ access_token: 'AT2', expires_in: 3599, scope: state.scope, id_token: state.bare ? bareTok : idTok }));
    });
  });
  return new Promise(res => server.listen(0, () => res({ state, port: server.address().port, close: () => new Promise(r => server.close(r)) })));
}

test('sign-in: login redirect, code exchange, refresh, logout', async () => {
  const g = await fakeGoogle();
  const env = { GOOGLE_CLIENT_ID: 'CID', GOOGLE_CLIENT_SECRET: 'SECRET', COOKIE_SECRET: 'cookie-secret',
    GOOGLE_AUTH_URL: `http://127.0.0.1:${g.port}/auth`, GOOGLE_TOKEN_URL: `http://127.0.0.1:${g.port}/token`, GOOGLE_REVOKE_URL: `http://127.0.0.1:${g.port}/revoke`, GOOGLE_USERINFO_URL: `http://127.0.0.1:${g.port}/userinfo` };
  const s = await listen(createApp({ env }));
  const jar = {};
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const eat = r => (r.headers.getSetCookie?.() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); if (/Max-Age=0/i.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); });
  const call = async (path, o = {}) => { const r = await fetch(s.base + path, { redirect: 'manual', ...o, headers: { cookie: cookies(), ...(o.headers || {}) } }); eat(r); return r; };
  const ORIGIN = { Origin: s.base };
  try {
    assert.equal((await (await fetch(s.base + '/api/config')).json()).signIn, true);

    let r = await call('/auth/refresh', { method: 'POST', headers: ORIGIN });
    assert.equal(r.status, 401, 'no session yet');

    r = await call('/auth/login?hint=a@b.c');
    const loc = new URL(r.headers.get('location'));
    assert.equal(r.status, 302);
    assert.equal(loc.searchParams.get('access_type'), 'offline');
    assert.equal(loc.searchParams.get('prompt'), 'consent');
    assert.equal(loc.searchParams.get('login_hint'), 'a@b.c');
    assert.equal(loc.searchParams.get('redirect_uri'), `${s.base}/auth/callback`, 'the callback is on this very site');
    const scope = loc.searchParams.get('scope');
    assert.ok(scope.includes('drive.appdata') && scope.includes('drive.file'));
    assert.ok(jar.rm_state, 'CSRF state cookie set');

    r = await call('/auth/callback?code=CODE1&state=WRONG');
    assert.match(r.headers.get('location'), /auth_error=state/);
    assert.ok(!jar.rm_rt);

    r = await call('/auth/login'); const state = new URL(r.headers.get('location')).searchParams.get('state');
    r = await call(`/auth/callback?code=CODE1&state=${state}`);
    assert.equal(r.headers.get('location'), '/app');
    assert.ok(jar.rm_rt && !jar.rm_state);
    assert.ok(!Buffer.from(jar.rm_rt, 'base64url').toString().includes('RT1'), 'the refresh token is not readable in the cookie');

    r = await call('/auth/refresh', { method: 'POST', headers: ORIGIN });
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.equal(b.access_token, 'AT2');
    assert.equal(b.user.email, 'a@b.c');
    assert.ok(b.scope.includes('drive.file'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(g.state.userinfo.length, 0, 'a full id_token needs no userinfo call');

    g.state.bare = true;
    r = await call('/auth/refresh', { method: 'POST', headers: ORIGIN });
    const b2 = await r.json();
    assert.deepEqual([b2.user.name, b2.user.given_name, b2.user.picture], ['A B', 'A', 'p'], 'name and picture filled in from userinfo');
    assert.deepEqual(g.state.userinfo, ['Bearer AT2']);
    g.state.bare = false;

    assert.equal((await call('/auth/refresh', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/auth/refresh', { method: 'POST' })).status, 403);

    g.state.mode = 'down';
    r = await call('/auth/refresh', { method: 'POST', headers: ORIGIN });
    assert.equal(r.status, 502); assert.ok(jar.rm_rt, 'a Google outage keeps the session');
    g.state.mode = 'revoked';
    r = await call('/auth/refresh', { method: 'POST', headers: ORIGIN });
    assert.equal(r.status, 401); assert.ok(!jar.rm_rt, 'a revoked grant clears the cookie');
    g.state.mode = 'ok';

    g.state.scope = 'openid email'; r = await call('/auth/login'); const st2 = new URL(r.headers.get('location')).searchParams.get('state');
    r = await call(`/auth/callback?code=CODE1&state=${st2}`);
    assert.match(r.headers.get('location'), /auth_error=scope/, 'refusing to continue without Drive access');
    g.state.scope = 'openid email https://www.googleapis.com/auth/drive.appdata'; g.state.refresh = false;
    r = await call('/auth/login'); const st3 = new URL(r.headers.get('location')).searchParams.get('state');
    r = await call(`/auth/callback?code=CODE1&state=${st3}`);
    assert.match(r.headers.get('location'), /auth_error=no_refresh/);
    g.state.refresh = true;

    r = await call('/auth/login'); const st4 = new URL(r.headers.get('location')).searchParams.get('state');
    await call(`/auth/callback?code=CODE1&state=${st4}`);
    r = await call('/auth/logout', { method: 'POST', headers: ORIGIN });
    assert.equal(r.status, 204);
    assert.ok(!jar.rm_rt && g.state.revoked.includes('RT1'), 'logout clears the cookie and revokes the token at Google');
  } finally { await s.close(); await g.close(); }
});

test('sign-in endpoints say so when Google is not configured', async () => {
  const s = await listen(createApp({ env: {} }));
  try {
    assert.equal((await (await fetch(s.base + '/api/config')).json()).signIn, false);
    assert.equal((await fetch(s.base + '/auth/login', { redirect: 'manual' })).status, 503);
    assert.equal((await fetch(s.base + '/auth/refresh', { method: 'POST', headers: { Origin: s.base } })).status, 503);
  } finally { await s.close(); }
});

// ── pages ───────────────────────────────────────────────────────────────────────────────
test('pages, assets and security headers', async () => {
  const s = await listen(createApp({ env: {} }));
  try {
    assert.equal((await (await fetch(s.base + '/healthz')).json()).ok, true);
    for (const p of ['/', '/app', '/r/abcdefghij', '/privacy', '/terms', '/favicon.svg', '/app.css', '/product-page.css', '/js/app.js', '/js/sync.js']) assert.equal((await fetch(s.base + p)).status, 200, p);
    const landing = await (await fetch(s.base + '/')).text();
    assert.match(landing, /now, next and later/);
    assert.ok(!/style="/.test(landing) && !/<script>/.test(landing), 'no inline styles or scripts (the CSP forbids them)');
    const embed = await fetch(s.base + '/embed.js');
    assert.equal(embed.headers.get('access-control-allow-origin'), '*');
    assert.equal(embed.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const csp = embed.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self' https:\/\/www\.googleapis\.com/);
    assert.ok(!/unsafe-inline/.test(csp));
    assert.equal(embed.headers.get('x-content-type-options'), 'nosniff');
  } finally { await s.close(); }
});

test('product-page.css (copied into the Taskboards and Diagramico repos) still matches the landing rules in app.css', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
  const marker = '/* ── product page (landing)';
  const landing = read('app.css').slice(read('app.css').indexOf(marker));
  assert.ok(landing.length > 500);
  assert.ok(read('product-page.css').includes(landing), 'regenerate product-page.css from app.css and copy it to the other repos');
});

test('/r/:id/feed.atom serves an Atom feed of a shared roadmap, one entry per publication', async () => {
  const doc = { ...GOOD, name: 'Acme & <Co>', tagline: 'Say "hi"', now: [{ title: 'Ship <b>it</b>' }], next: [{ title: 'Next one' }] };
  const drive = fakeDrive({ GOODFILE12345: { doc, modifiedTime: '2026-10-19T10:00:00.000Z' }, NOTOURS123456: { doc: { hello: 'world' } } });
  const s = await listen(createApp({ env: { DRIVE_API_KEY: 'k', PUBLIC_URL: 'https://rm.example/' }, fetchImpl: drive }));
  try {
    const r = await fetch(s.base + '/r/GOODFILE12345/feed.atom');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/atom\+xml/);
    const body = await r.text();
    assert.match(body, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    assert.match(body, /<title>Acme &amp; &lt;Co&gt; — roadmap<\/title>/, 'text is escaped');
    assert.ok(!body.includes('<b>'), 'user text never becomes markup');
    assert.match(body, /<id>https:\/\/rm\.example\/r\/GOODFILE12345<\/id>/, 'addresses come from PUBLIC_URL');
    assert.match(body, /<id>https:\/\/rm\.example\/r\/GOODFILE12345#2026-10-19T10:00:00\.000Z<\/id>/, 'the entry id changes with every publication');
    assert.match(body, /Now: Ship &lt;b&gt;it&lt;\/b&gt;\nNext: Next one\nLater: nothing planned yet/);
    const again = await fetch(s.base + '/r/GOODFILE12345/feed.atom', { headers: { 'If-None-Match': r.headers.get('etag') } });
    assert.equal(again.status, 304);
    assert.equal((await fetch(s.base + '/r/NOTOURS123456/feed.atom')).status, 404, 'a Drive file that is not a roadmap');
    assert.equal((await fetch(s.base + '/r/MISSINGFILE123/feed.atom')).status, 404, 'unshared / deleted');
    assert.equal((await fetch(s.base + '/r/short/feed.atom')).status, 404, 'bad id never reaches Drive');
    assert.equal(drive.calls.filter(u => u.includes('short')).length, 0);
  } finally { await s.close(); }
  const off = await listen(createApp({ env: {}, fetchImpl: fakeDrive({}) }));
  try { assert.equal((await fetch(off.base + '/r/GOODFILE12345/feed.atom')).status, 503); } finally { await off.close(); }
});

// ── Phase 3: dates, shipped changelog, versions ─────────────────────────────────────────
test('cleanPublic keeps the optional date, the language, the current version and the closed versions — cleaned and capped', () => {
  const ship = (title, at) => ({ title, description: 'd', tag: 't', tone: 'success', when: 'Q1', shippedAt: at });
  const doc = cleanPublic({
    app: 'roadmaps-public', name: 'Acme', lang: 'pt-BR', version: '1.4.0',
    now: [{ title: 'A', when: 'Q1 2027 and then some more text' }],
    shipped: [ship('S1', 1760000000000), ship('', 5), { title: 'S3', shippedAt: 'nope' }],
    releases: [
      { version: '1.3.0', closedAt: 1750000000000, items: [ship('Old', 1740000000000)] },
      { version: '../etc', items: [ship('Bad', 1)] },
      { version: '1.2.0', closedAt: -5, items: 'not a list' }
    ]
  });
  assert.equal(doc.lang, 'pt-BR');
  assert.equal(doc.version, '1.4.0');
  assert.equal(doc.now[0].when.length, 12, 'the date is a short text');
  assert.deepEqual(doc.shipped.map(x => x.title), ['S1', 'S3']);
  assert.equal(doc.shipped[0].shippedAt, 1760000000000);
  assert.equal(doc.shipped[1].shippedAt, 0, 'a bad date becomes none');
  assert.deepEqual(doc.releases.map(v => v.version), ['1.3.0', '1.2.0'], 'an unsafe version label is dropped');
  assert.deepEqual(doc.releases[1].items, [], 'a non-list of entries is empty');
  assert.equal(doc.releases[1].closedAt, 0);

  const plain = cleanPublic({ app: 'roadmaps-public', name: 'Old file', lang: '<script>', version: 'a b' });
  assert.equal(plain.lang, 'en', 'an unknown language falls back to English');
  assert.equal(plain.version, '');
  assert.deepEqual([plain.shipped, plain.releases], [[], []], 'files from before Phase 3 still load');

  const big = cleanPublic({ app: 'roadmaps-public', name: 'Big', shipped: Array.from({ length: 150 }, (_, i) => ship('S' + i, 1)), releases: Array.from({ length: 30 }, (_, i) => ({ version: '1.' + i + '.0', items: [] })) });
  assert.equal(big.shipped.length, 100);
  assert.equal(big.releases.length, 20);
});

test('the shipped changelog is rendered as Markdown on the fly, per version, and feeds one entry per closed version', async () => {
  const doc = {
    ...GOOD, name: 'Acme', lang: 'en', version: '1.4.0',
    shipped: [{ title: 'New *thing*', description: 'Does <b>stuff</b>', shippedAt: Date.UTC(2026, 9, 12, 12) }],
    releases: [{ version: '1.3.0', closedAt: Date.UTC(2026, 8, 30, 12), items: [{ title: 'Old', description: '', shippedAt: Date.UTC(2026, 8, 1, 12) }] }]
  };
  const drive = fakeDrive({ GOODFILE12345: { doc } });
  const s = await listen(createApp({ env: { DRIVE_API_KEY: 'k', PUBLIC_URL: 'https://rm.example' }, fetchImpl: drive }));
  try {
    const all = await fetch(s.base + '/r/GOODFILE12345/changelog.md');
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-type'), /^text\/markdown/);
    const md = await all.text();
    assert.match(md, /^# Acme — changelog/);
    assert.match(md, /## 1\.4\.0 \(in progress\)/);
    assert.ok(md.includes('- **New \\*thing\\*** — Does \\<b\\>stuff\\</b\\> _(2026-10-12)_'), 'user text is escaped, never Markdown or HTML');
    assert.match(md, /## 1\.3\.0 — closed 2026-09-30/);

    const one = await (await fetch(s.base + '/r/GOODFILE12345/changelog/1.3.0.md')).text();
    assert.match(one, /^# Acme — version 1\.3\.0/);
    assert.match(one, /Closed 2026-09-30\./);
    assert.ok(!one.includes('thing'), 'only that version');
    const current = await fetch(s.base + '/r/GOODFILE12345/changelog/1.4.0.md');
    assert.match(await current.text(), /In progress\./);
    assert.match(current.headers.get('content-disposition'), /version1\.4\.0\.md/);

    assert.equal((await fetch(s.base + '/r/GOODFILE12345/changelog/9.9.9.md')).status, 404, 'no such version');
    assert.equal((await fetch(s.base + '/r/GOODFILE12345/changelog/..%2Fx.md')).status, 404, 'unsafe label');
    assert.equal((await fetch(s.base + '/r/GOODFILE12345/changelog/1.3.0.txt')).status, 404, 'only .md');
    assert.equal((await fetch(s.base + '/r/short/changelog.md')).status, 404, 'bad id never reaches Drive');
    assert.equal(drive.calls.filter(u => u.includes('/short')).length, 0);

    const atom = await (await fetch(s.base + '/r/GOODFILE12345/feed.atom')).text();
    assert.match(atom, /<id>https:\/\/rm\.example\/r\/GOODFILE12345#v1\.3\.0<\/id>/, 'one entry per closed version');
    assert.match(atom, /Acme 1\.3\.0 shipped/);
    assert.match(atom, /<updated>2026-09-30T12:00:00\.000Z<\/updated>/);
  } finally { await s.close(); }
});
