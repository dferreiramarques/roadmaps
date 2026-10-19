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
  const idTok = 'x.' + Buffer.from(JSON.stringify({ sub: 'u1', email: 'a@b.c', name: 'A B', given_name: 'A', picture: 'p' })).toString('base64url') + '.y';
  const state = { revoked: [], mode: 'ok', scope: 'openid email https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file', refresh: true };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/revoke') { state.revoked.push(p.token); return res.end('{}'); }
      if (p.grant_type === 'authorization_code') {
        if (p.client_secret !== 'SECRET' || p.code !== 'CODE1') { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
        return res.end(JSON.stringify({ access_token: 'AT1', expires_in: 3599, scope: state.scope, id_token: idTok, ...(state.refresh ? { refresh_token: 'RT1' } : {}) }));
      }
      if (state.mode === 'revoked' || p.refresh_token !== 'RT1') { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      if (state.mode === 'down') { res.writeHead(503); return res.end('{}'); }
      res.end(JSON.stringify({ access_token: 'AT2', expires_in: 3599, scope: state.scope, id_token: idTok }));
    });
  });
  return new Promise(res => server.listen(0, () => res({ state, port: server.address().port, close: () => new Promise(r => server.close(r)) })));
}

test('sign-in: login redirect, code exchange, refresh, logout', async () => {
  const g = await fakeGoogle();
  const env = { GOOGLE_CLIENT_ID: 'CID', GOOGLE_CLIENT_SECRET: 'SECRET', COOKIE_SECRET: 'cookie-secret',
    GOOGLE_AUTH_URL: `http://127.0.0.1:${g.port}/auth`, GOOGLE_TOKEN_URL: `http://127.0.0.1:${g.port}/token`, GOOGLE_REVOKE_URL: `http://127.0.0.1:${g.port}/revoke` };
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
