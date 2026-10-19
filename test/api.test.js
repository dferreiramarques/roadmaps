'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function start(opts = {}) {
  const dataDir = opts.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'roadmaps-'));
  const { app, store } = await createApp({ dataDir, seedFile: null, adminToken: 'secret-token', sessionSecret: 'test-secret', ...opts });
  const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = base;
  const client = {
    base, store, dataDir, cookie: '',
    async req(method, url, body, { headers = {}, raw = false } = {}) {
      const h = { ...headers };
      if (client.cookie) h.cookie = client.cookie;
      if (method !== 'GET' && !('Origin' in h)) h.Origin = origin;
      if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
      const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
      let data = null;
      const text = await r.text();
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data, headers: r.headers };
    },
    async login(token = 'secret-token') {
      const r = await client.req('POST', '/api/login', { token });
      const set = r.headers.get('set-cookie');
      if (set) client.cookie = set.split(';')[0];
      return r;
    },
    close: () => new Promise(res => server.close(res))
  };
  return client;
}

test('health check and an empty public dataset', async () => {
  const c = await start();
  try {
    assert.equal((await c.req('GET', '/healthz')).data.ok, true);
    const r = await c.req('GET', '/roadmap.json');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.products, []);
  } finally { await c.close(); }
});

test('editing is disabled when ADMIN_TOKEN is not set', async () => {
  const c = await start({ adminToken: '' });
  try {
    assert.equal((await c.req('POST', '/api/login', { token: 'x' })).status, 503);
    assert.equal((await c.req('POST', '/api/products', { name: 'X' })).status, 503);
    assert.equal((await c.req('GET', '/api/me')).data.editingEnabled, false);
  } finally { await c.close(); }
});

test('sign-in: wrong token, cross-site login, good token, cookie flags', async () => {
  const c = await start();
  try {
    assert.equal((await c.req('POST', '/api/products', { name: 'X' })).status, 401);
    assert.equal((await c.login('nope')).status, 401);
    assert.equal((await c.req('POST', '/api/login', { token: 'secret-token' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const ok = await c.login();
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal((await c.req('GET', '/api/me')).data.admin, true);
    await c.req('POST', '/api/logout', {});
  } finally { await c.close(); }
});

test('login attempts are rate limited', async () => {
  const c = await start();
  try {
    let last;
    for (let i = 0; i < 10; i++) last = await c.login('wrong-' + i);
    assert.equal(last.status, 429);
  } finally { await c.close(); }
});

test('create, update with revision check, conflict, delete', async () => {
  const c = await start();
  try {
    await c.login();
    assert.equal((await c.req('POST', '/api/products', { name: '   ' })).status, 400);
    const created = await c.req('POST', '/api/products', { name: 'My App', tagline: 'Hi', now: [{ title: 'A' }] });
    assert.equal(created.status, 201);
    assert.equal(created.data.id, 'my-app');
    assert.equal(created.data.rev, 1);
    assert.equal(created.data.now.length, 1);
    assert.ok(created.data.now[0].id, 'items get ids');

    const upd = await c.req('PUT', '/api/products/my-app', { ...created.data, tagline: 'Hello', rev: 1 });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.rev, 2);

    const stale = await c.req('PUT', '/api/products/my-app', { ...created.data, tagline: 'Stale', rev: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.current.tagline, 'Hello');

    const dup = await c.req('POST', '/api/products', { name: 'My App' });
    assert.notEqual(dup.data.id, 'my-app', 'ids stay unique');

    assert.equal((await c.req('DELETE', '/api/products/my-app')).status, 204);
    assert.equal((await c.req('GET', '/api/products/my-app')).status, 404);
    const trash = await fs.readdir(path.join(c.dataDir, 'trash'));
    assert.equal(trash.length, 1, 'deleted products are kept in trash');
  } finally { await c.close(); }
});

test('private products stay private; public ones are open to everyone (CORS)', async () => {
  const c = await start();
  try {
    await c.login();
    await c.req('POST', '/api/products', { name: 'Open', visibility: 'public', now: [{ title: 'x' }] });
    await c.req('POST', '/api/products', { name: 'Secret', visibility: 'private' });
    const adminList = await c.req('GET', '/api/products');
    assert.equal(adminList.data.length, 2);

    const anon = await start({ dataDir: c.dataDir });   // same data, no cookie
    try {
      const list = await anon.req('GET', '/api/products');
      assert.deepEqual(list.data.map(p => p.id), ['open']);
      assert.equal((await anon.req('GET', '/api/products/secret')).status, 404);
      const ds = await anon.req('GET', '/api/roadmap.json');
      assert.deepEqual(ds.data.products.map(p => p.id), ['open']);
      assert.ok(!('visibility' in ds.data.products[0]) && !('rev' in ds.data.products[0]), 'no admin fields in the public dataset');
      assert.equal(ds.headers.get('access-control-allow-origin'), '*');
      assert.equal((await anon.req('GET', '/healthz')).headers.get('access-control-allow-origin'), null);
    } finally { await anon.close(); }
  } finally { await c.close(); }
});

test('everything that comes in is cleaned', async () => {
  const c = await start();
  try {
    await c.login();
    const r = await c.req('POST', '/api/products', {
      name: 'Evil\u0000   Name' + 'x'.repeat(100),
      url: 'javascript:alert(1)',
      visibility: 'sideways',
      now: [{ title: '<img src=x onerror=alert(1)>', description: 'a\n\n  b', tag: 't'.repeat(99), tone: 'rainbow' }, { title: '' }, null, 'str'],
      next: 'nope',
      later: Array.from({ length: 150 }, (_, i) => ({ title: 'item ' + i }))
    });
    assert.equal(r.status, 201);
    const p = r.data;
    assert.ok(p.name.length <= 40 && !p.name.includes('\u0000'));
    assert.equal(p.url, '');
    assert.equal(p.visibility, 'public');
    assert.equal(p.now.length, 1);
    assert.equal(p.now[0].title, '<img src=x onerror=alert(1)>', 'stored as plain text (the UI shows it as text)');
    assert.equal(p.now[0].tone, 'secondary');
    assert.equal(p.now[0].tag.length, 20);
    assert.equal(p.now[0].description, 'a b');
    assert.deepEqual(p.next, []);
    assert.equal(p.later.length, 100);
  } finally { await c.close(); }
});

test('only JSON, only from this origin', async () => {
  const c = await start();
  try {
    await c.login();
    const form = await c.req('POST', '/api/products', 'name=X', { raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const cross = await c.req('POST', '/api/products', { name: 'X' }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const noOrigin = await fetch(c.base + '/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: '{"name":"X"}' });
    assert.equal(noOrigin.status, 403);
    const bad = await c.req('POST', '/api/products', '{nope', { raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal((await c.req('GET', '/api/nothing-here')).status, 404);
  } finally { await c.close(); }
});

test('revisions: every change is kept and can be restored', async () => {
  const c = await start();
  try {
    await c.login();
    const p1 = (await c.req('POST', '/api/products', { name: 'Rev', now: [{ title: 'one' }] })).data;
    const p2 = (await c.req('PUT', '/api/products/rev', { ...p1, now: [{ title: 'two' }], rev: 1 })).data;
    const revs = (await c.req('GET', '/api/products/rev/revisions')).data;
    assert.deepEqual(revs.map(r => r.rev), [2, 1]);
    const restored = await c.req('POST', '/api/products/rev/restore', { revision: 1, rev: p2.rev });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.rev, 3, 'restoring creates a new revision');
    assert.equal(restored.data.now[0].title, 'one');
    assert.equal((await c.req('POST', '/api/products/rev/restore', { revision: 99, rev: 3 })).status, 404);
    assert.equal((await c.req('POST', '/api/products/rev/restore', { revision: 1, rev: 1 })).status, 409);
  } finally { await c.close(); }
});

test('ids from the URL can not escape the data folder', async () => {
  const c = await start();
  try {
    await c.login();
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'a.b', 'UPPER']) {
      assert.equal((await c.req('GET', '/api/products/' + id)).status, 404, id);
    }
  } finally { await c.close(); }
});

test('export / import round trip (merge by id)', async () => {
  const c = await start();
  try {
    await c.login();
    await c.req('POST', '/api/products', { name: 'Keep me' });
    const imp = await c.req('POST', '/api/import', { products: [{ id: 'imported', name: 'Imported', now: [{ id: 'k1', title: 'Hello' }] }, { name: 'Another' }] });
    assert.equal(imp.data.imported, 2);
    const exp = (await c.req('GET', '/api/export')).data;
    assert.deepEqual(exp.products.map(p => p.id).sort(), ['another', 'imported', 'keep-me']);
    assert.equal(exp.products.find(p => p.id === 'imported').now[0].id, 'k1', 'item ids are kept');
    const again = await c.req('POST', '/api/import', { products: [{ id: 'imported', name: 'Imported v2' }] });
    assert.equal(again.data.imported, 1);
    assert.equal((await c.req('GET', '/api/products/imported')).data.name, 'Imported v2');
    assert.equal((await c.req('POST', '/api/import', { nope: true })).status, 400);
  } finally { await c.close(); }
});

test('data survives a restart, and an empty folder is seeded', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roadmaps-seed-'));
  const a = await start({ dataDir, seedFile: path.join(__dirname, '..', 'seed', 'roadmap.json') });
  const seeded = (await a.req('GET', '/api/products')).data.map(p => p.id);
  assert.ok(seeded.includes('taskboards') && seeded.includes('diagramico'), 'example data loaded');
  await a.login();
  await a.req('POST', '/api/products', { name: 'Added later' });
  await a.close();

  const b = await start({ dataDir, seedFile: path.join(__dirname, '..', 'seed', 'roadmap.json') });
  try {
    const ids = (await b.req('GET', '/api/products')).data.map(p => p.id);
    assert.ok(ids.includes('added-later'), 'survived the restart');
    assert.equal(ids.filter(i => i === 'taskboards').length, 1, 'seed is not applied twice');
  } finally { await b.close(); }
});

test('pages and the embed script are served', async () => {
  const c = await start();
  try {
    for (const p of ['/', '/admin', '/p/anything', '/app.css', '/js/admin.js']) {
      assert.equal((await fetch(c.base + p)).status, 200, p);
    }
    const embed = await fetch(c.base + '/embed.js');
    assert.equal(embed.status, 200);
    assert.equal(embed.headers.get('access-control-allow-origin'), '*');
    assert.match(embed.headers.get('content-security-policy') || '', /default-src 'self'/);
  } finally { await c.close(); }
});
