'use strict';
// public/js/sync.js runs in the browser. These tests load it into a vm sandbox with a fake browser (localStorage, timers,
// fetch) and a fake Google Drive, and check the safety rules from CLAUDE.md: never save after a failed load, ask before
// overwriting a newer Drive copy, keep offline edits and reconcile them, never mix two accounts, revoke public copies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sync.js'), 'utf8');
const APPDATA = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const settle = () => new Promise(r => setImmediate(r));

const rm = (id, name, extra = {}) => ({ id, name, tagline: '', url: '', now: [], next: [], later: [], ...extra });
const doc = (roadmaps, current = '') => ({ app: 'roadmaps', version: 1, current, roadmaps });
const res = (status, body) => ({ ok: status < 400, status, statusText: String(status), json: async () => body });

class FakeDrive {
  constructor() { this.files = new Map(); this.n = 0; this.clock = 0; this.writes = []; this.deletes = []; this.perms = []; this.failAll = false; this.failWrites = false; this.reject401 = 0; this.gate = null; }
  tick() { return new Date(1700000000000 + (++this.clock) * 1000).toISOString(); }
  add(name, content, appData = true) { const id = 'f' + (++this.n); this.files.set(id, { id, name, appData, content: JSON.stringify(content), modifiedTime: this.tick() }); return id; }
  touch(id, content) { const f = this.files.get(id); f.content = JSON.stringify(content); f.modifiedTime = this.tick(); }   // changed elsewhere
  content(id) { return JSON.parse(this.files.get(id).content); }
  find(name) { return [...this.files.values()].filter(f => f.name === name); }

  async handle(url, opts = {}) {
    const u = new URL(url, 'https://drive.test');
    const method = opts.method || 'GET';
    const p = u.pathname;
    const upload = p.startsWith('/upload/');
    if (this.failAll) return res(500, {});
    if (this.reject401 > 0) { this.reject401--; return res(401, {}); }
    if (upload && this.failWrites) return res(500, { error: { message: 'boom' } });
    const m = p.match(/\/files(?:\/([^/]+))?(\/permissions)?$/);
    const id = m && m[1];
    if (upload && (method === 'POST' || method === 'PATCH')) {
      this.writes.push({ method, id });
      if (this.gate) await this.gate();
    }
    if (!id && method === 'GET') {
      const name = decodeURIComponent(u.searchParams.get('q')).match(/name='([^']+)'/)[1];
      return res(200, { files: this.find(name).filter(f => f.appData).map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })) });
    }
    if (!id && method === 'POST' && upload) {
      const b = opts.headers['Content-Type'].split('boundary=')[1];
      const [, metaPart, bodyPart] = opts.body.split('--' + b);
      const meta = JSON.parse(metaPart.split('\r\n\r\n')[1].trim());
      const content = bodyPart.split('\r\n\r\n')[1].replace(/\r\n$/, '');
      const nid = 'f' + (++this.n);
      this.files.set(nid, { id: nid, name: meta.name, appData: (meta.parents || []).includes('appDataFolder'), content, modifiedTime: this.tick() });
      return res(200, { id: nid, modifiedTime: this.files.get(nid).modifiedTime });
    }
    const f = id && this.files.get(id);
    if (id && !f) return res(404, {});
    if (id && m[2] && method === 'POST') { this.perms.push({ id, ...JSON.parse(opts.body) }); return res(200, {}); }
    if (id && method === 'GET') return res(200, u.searchParams.get('alt') === 'media' ? JSON.parse(f.content) : { modifiedTime: f.modifiedTime });
    if (id && method === 'PATCH') { f.content = opts.body; f.modifiedTime = this.tick(); return res(200, { id, modifiedTime: f.modifiedTime }); }
    if (id && method === 'DELETE') { this.files.delete(id); this.deletes.push(id); return res(204, {}); }
    return res(404, {});
  }
}

// A fake browser around sync.js. `seed` pre-fills localStorage (what a returning user's device already holds).
function boot({ drive = new FakeDrive(), seed = {}, scope = `${APPDATA} ${FILE_SCOPE}`, sub = 'u1', answer = true, refreshStatus = 200 } = {}) {
  const store = new Map(Object.entries(seed));
  const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const timers = [];
  let tokens = 0;
  const env = { refreshStatus, refreshes: 0 };
  const fetch = async (url, opts = {}) => {
    if (url === '/api/config') return res(200, { signIn: true });
    if (url === '/auth/refresh') {
      env.refreshes++;
      if (env.refreshStatus !== 200) return res(env.refreshStatus, {});
      return res(200, { access_token: 'tok' + (++tokens), expires_in: 3600, scope, user: { sub, email: sub + '@example.com' } });
    }
    if (url === '/auth/logout') return res(200, {});
    return drive.handle(url, opts);
  };
  const ctx = {
    localStorage, sessionStorage: mem(), fetch, URL, URLSearchParams, AbortController, console: { error() {}, warn() {}, log() {} },
    navigator: { onLine: true }, location: { origin: 'https://app.test', search: '', pathname: '/app', href: '' }, history: { replaceState() {} },
    document: { addEventListener() {}, visibilityState: 'visible' }, confirm: () => false,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.live = false; },
    Date, JSON, Promise, Error, Map, Math, Number, String, Array, Object
  };
  ctx.window = ctx;
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const t = { drive, store, ctx, sync: ctx.RMSync, env, statuses: [], gates: [], toasts: [], conflicts: 0, state: doc([]), answer };
  t.sync.init({
    getData: () => t.state,
    applyData: d => { t.state = d; },
    onStatus: (k, msg) => t.statuses.push([k, msg]),
    onGate: (msg, kind) => t.gates.push([msg, kind]),
    confirmConflict: async () => { t.conflicts++; return t.answer; },
    toast: msg => t.toasts.push(msg)
  });
  // run the pending timers that were scheduled with this delay (1200 = debounced save, 20000 = offline reconcile)
  t.fire = async ms => { for (const x of timers.filter(x => x.live && x.ms === ms)) { x.live = false; x.fn(); } await settle(); await settle(); };
  t.edit = async fn => { fn(t.state); t.sync.changed(); };
  return t;
}

test('first sign-in with nothing on Drive creates the app-folder file only once there is something to save', async () => {
  const t = boot();
  assert.equal(await t.sync.start(), 'running');
  assert.equal(t.drive.writes.length, 0, 'an empty account does not create a file');
  await t.edit(s => s.roadmaps.push(rm('a', 'Taskboards')));
  await t.fire(1200);
  assert.equal(t.drive.writes.length, 1);
  const [f] = t.drive.find('roadmaps-data.json');
  assert.ok(f.appData, 'lives in the private app folder');
  assert.deepEqual(t.drive.content(f.id).roadmaps.map(r => r.name), ['Taskboards']);
  assert.equal(t.sync.hasUnsynced(), false);
  assert.equal(t.store.get('roadmaps-file-id'), f.id);
});

test('an existing Drive copy is adopted when this device has no pending edits', async () => {
  const drive = new FakeDrive();
  drive.add('roadmaps-data.json', doc([rm('x', 'From Drive')], 'x'));
  const t = boot({ drive, seed: { 'roadmaps-data': JSON.stringify(doc([rm('old', 'Stale local')])) } });
  await t.sync.start();
  assert.deepEqual(t.state.roadmaps.map(r => r.name), ['From Drive']);
  assert.equal(t.state.current, 'x');
  assert.equal(t.drive.writes.length, 0, 'nothing is written back after a plain load');
  assert.equal(t.conflicts, 0);
});

test('a failed Drive load never leads to a save; edits stay local and reconcile when Drive is back', async () => {
  const drive = new FakeDrive();
  const id = drive.add('roadmaps-data.json', doc([rm('d', 'Drive version')]));
  drive.failAll = true;
  const t = boot({ drive, answer: true });
  await t.sync.start();
  assert.equal(t.sync.isOffline(), true);
  assert.equal(t.sync.isReady(), false);

  await t.edit(s => s.roadmaps.push(rm('l', 'Written offline')));
  await t.fire(1200);
  assert.equal(drive.writes.length, 0, 'no save while the load is unresolved');
  assert.equal(t.sync.hasUnsynced(), true);
  assert.deepEqual(JSON.parse(t.store.get('roadmaps-data')).roadmaps.map(r => r.name), ['Written offline'], 'kept on this device');

  drive.failAll = false;
  await t.fire(20000);                       // reconcile
  assert.equal(t.conflicts, 1, 'Drive has a copy this device never saw: ask, do not overwrite silently');
  assert.equal(t.sync.isOffline(), false);
  assert.equal(drive.writes.length, 1);
  assert.deepEqual(drive.content(id).roadmaps.map(r => r.name), ['Written offline']);
  assert.equal(t.sync.hasUnsynced(), false);
});

test('conflict: declining keeps the newer Drive copy and writes nothing; accepting overwrites it', async () => {
  for (const keepLocal of [false, true]) {
    const drive = new FakeDrive();
    const id = drive.add('roadmaps-data.json', doc([rm('d', 'Newer on Drive')]));
    const seed = { 'roadmaps-data': JSON.stringify(doc([rm('l', 'Local edit')])), 'roadmaps-dirty': '1', 'roadmaps-base': '2000-01-01T00:00:00.000Z', 'roadmaps-file-id': id };
    const t = boot({ drive, seed, answer: keepLocal });
    await t.sync.start();
    assert.equal(t.conflicts, 1);
    if (keepLocal) {
      assert.deepEqual(drive.content(id).roadmaps.map(r => r.name), ['Local edit']);
      assert.equal(drive.writes.length, 1);
    } else {
      assert.deepEqual(t.state.roadmaps.map(r => r.name), ['Newer on Drive']);
      assert.deepEqual(drive.content(id).roadmaps.map(r => r.name), ['Newer on Drive']);
      assert.equal(drive.writes.length, 0);
      assert.equal(t.sync.hasUnsynced(), false);
    }
  }
});

test('Drive changed elsewhere during the session: the next save asks before overwriting', async () => {
  const drive = new FakeDrive();
  const id = drive.add('roadmaps-data.json', doc([rm('a', 'One')]));
  const t = boot({ drive, answer: false });
  await t.sync.start();
  drive.touch(id, doc([rm('b', 'Edited on another device')]));
  await t.edit(s => s.roadmaps[0].name = 'Mine');
  await t.fire(1200);
  assert.equal(t.conflicts, 1);
  assert.equal(drive.writes.length, 0);
  assert.deepEqual(t.state.roadmaps.map(r => r.name), ['Edited on another device'], 'the Drive copy was adopted');
});

test('a different Google account never inherits another account\'s local data', async () => {
  const seed = {
    'roadmaps-sub': 'someone-else', 'roadmaps-data': JSON.stringify(doc([rm('p', 'Private to them')])),
    'roadmaps-dirty': '1', 'roadmaps-base': '2000-01-01T00:00:00.000Z', 'roadmaps-file-id': 'theirs',
    'roadmaps-revokes': JSON.stringify(['their-public-copy'])
  };
  const t = boot({ seed, sub: 'u1' });
  await t.sync.start();
  assert.equal(t.state.roadmaps.length, 0);
  assert.equal(t.store.get('roadmaps-sub'), 'u1');
  assert.equal(t.store.get('roadmaps-dirty'), undefined);
  assert.equal(t.store.get('roadmaps-revokes'), undefined, 'the other account\'s revoke queue is not ours to run');
  assert.equal(t.drive.writes.length, 0);
  assert.equal(t.drive.deletes.length, 0);
});

test('edits made while a save is in flight stay dirty and are saved next', async () => {
  const drive = new FakeDrive();
  const id = drive.add('roadmaps-data.json', doc([rm('a', 'One')]));
  const t = boot({ drive });
  await t.sync.start();
  let release;
  drive.gate = () => new Promise(r => { release = r; });
  await t.edit(s => s.roadmaps[0].name = 'Two');
  await t.fire(1200);                         // save starts and waits on the gate
  assert.equal(drive.writes.length, 1);
  await t.edit(s => s.roadmaps[0].name = 'Three');
  drive.gate = null; release();
  await settle(); await settle();
  assert.equal(t.sync.hasUnsynced(), true, 'the second edit has not reached Drive');
  assert.equal(drive.content(id).roadmaps[0].name, 'Two');
  await t.fire(1200);
  assert.equal(drive.content(id).roadmaps[0].name, 'Three');
  assert.equal(t.sync.hasUnsynced(), false);
});

test('an expired access token is refreshed once and the request retried', async () => {
  const drive = new FakeDrive();
  drive.add('roadmaps-data.json', doc([rm('a', 'One')]));
  const t = boot({ drive });
  await t.sync.start();
  const before = t.env.refreshes;
  drive.reject401 = 1;
  await t.edit(s => s.roadmaps[0].name = 'Two');
  await t.fire(1200);
  assert.equal(t.env.refreshes, before + 1);
  assert.equal(drive.writes.length, 1);
  assert.equal(t.sync.hasUnsynced(), false);
});

test('a dead session asks to reconnect and keeps the work on the device', async () => {
  const t = boot({ refreshStatus: 401 });
  assert.equal(await t.sync.start(), 'signedout');
  assert.equal(t.gates.length, 1);
  assert.equal(t.drive.writes.length, 0);
});

test('sharing: creates a link-readable copy with only public fields; refuses without the drive.file scope', async () => {
  const t = boot();
  await t.sync.start();
  const r = rm('a', 'Taskboards', { tagline: 'tag', now: [{ id: 'secret-id', title: 'Ship', description: 'd', tag: 't', tone: 'info', extra: 'x' }] });
  t.state.roadmaps.push(r);
  const share = await t.sync.share.create(r);
  const f = t.drive.files.get(share.fileId);
  assert.equal(f.appData, false, 'the public copy is not in the private app folder');
  assert.deepEqual(t.drive.perms, [{ id: share.fileId, role: 'reader', type: 'anyone', allowFileDiscovery: false }]);
  const pub = t.drive.content(share.fileId);
  assert.equal(pub.app, 'roadmaps-public');
  assert.deepEqual(Object.keys(pub.now[0]).sort(), ['description', 'tag', 'title', 'tone']);
  assert.equal(JSON.stringify(pub).includes('secret-id'), false);
  assert.equal(r.share.fileId, share.fileId);

  const noScope = boot({ scope: APPDATA });
  await noScope.sync.start();
  await assert.rejects(() => noScope.sync.share.create(rm('b', 'X')), e => e instanceof noScope.sync.share.ShareError);
});

test('sharing: edits to a shared roadmap are published; revoke deletes the copy; a copy deleted in Drive makes it private', async () => {
  const t = boot();
  await t.sync.start();
  const r = rm('a', 'Taskboards', { now: [{ title: 'One' }] });
  t.state.roadmaps.push(r);
  const { fileId } = await t.sync.share.create(r);
  await t.fire(1200);                         // the save that follows create()

  await t.edit(s => s.roadmaps[0].now.push({ title: 'Two' }));
  await t.fire(1200);
  assert.deepEqual(t.drive.content(fileId).now.map(i => i.title), ['One', 'Two'], 'auto-published on edit');

  t.drive.files.delete(fileId);               // user deleted the public file in Drive
  await t.edit(s => s.roadmaps[0].now.push({ title: 'Three' }));
  await t.fire(1200);
  assert.equal(t.state.roadmaps[0].share, undefined);
  assert.ok(t.toasts.some(m => /private again/.test(m)));

  const again = await t.sync.share.create(t.state.roadmaps[0]);
  await t.sync.share.revoke(t.state.roadmaps[0]);
  assert.ok(t.drive.deletes.includes(again.fileId));
  assert.equal(t.state.roadmaps[0].share, undefined);
});

test('sharing: a queued revoke survives failures until Drive deletes the public copy', async () => {
  const drive = new FakeDrive();
  drive.add('roadmaps-data.json', doc([]));
  const pubId = drive.add('Roadmap — gone', { app: 'roadmaps-public' }, false);
  const t = boot({ drive, seed: { 'roadmaps-revokes': JSON.stringify([pubId]) } });
  drive.failAll = true;
  await t.sync.start();
  assert.ok(drive.files.has(pubId));
  assert.deepEqual(JSON.parse(t.store.get('roadmaps-revokes')), [pubId], 'still queued while Drive is unreachable');
  drive.failAll = false;
  await t.fire(20000);                       // reconcile, then the queue runs
  assert.equal(drive.files.has(pubId), false);
  assert.equal(t.store.get('roadmaps-revokes'), undefined);
});

test('sign-out saves first, wipes this device, and refuses to drop unsynced work unless confirmed', async () => {
  const drive = new FakeDrive();
  drive.add('roadmaps-data.json', doc([rm('a', 'One')]));
  const t = boot({ drive });
  await t.sync.start();
  await t.edit(s => s.roadmaps[0].name = 'Two');
  assert.equal(await t.sync.signOut(), true);
  assert.equal(drive.content([...drive.files.keys()][0]).roadmaps[0].name, 'Two', 'saved before leaving');
  for (const k of ['roadmaps-data', 'roadmaps-dirty', 'roadmaps-base', 'roadmaps-file-id', 'roadmaps-hint', 'roadmaps-sub']) assert.equal(t.store.get(k), undefined, k);

  const stuck = boot({ drive });
  await stuck.sync.start();
  drive.failWrites = true;
  await stuck.edit(s => s.roadmaps[0].name = 'Three');
  assert.equal(await stuck.sync.signOut(), false, 'confirm() said no');
  assert.ok(stuck.store.get('roadmaps-data'), 'local copy kept');
});
