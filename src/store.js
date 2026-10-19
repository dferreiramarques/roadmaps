'use strict';
// File storage: one JSON file per product, plus a numbered revision of every change.
//
//   <dataDir>/products/<id>.json          current version
//   <dataDir>/revisions/<id>/<rev>.json   every version (the latest MAX_REVISIONS are kept)
//   <dataDir>/trash/<id>-<timestamp>.json deleted products (kept, in case of a mistake)
//   <dataDir>/index.json                  { order: [ids] } — the order products are listed in
//
// Writes are serialised through one queue and made atomic (write a temp file, then rename), so a crash
// can't leave half a file. On Railway, mount a Volume and point DATA_DIR at it — otherwise the data is
// lost on every deploy. If this ever outgrows files, keep this class's methods and swap the internals
// for Postgres (see docs/NOTES.md).

const fs = require('node:fs/promises');
const path = require('node:path');
const { cleanProduct, slug, newId, publicProduct } = require('./schema');

const MAX_REVISIONS = 100;

class ConflictError extends Error {
  constructor(current) { super('The product was changed somewhere else'); this.name = 'ConflictError'; this.current = current; }
}
class NotFoundError extends Error {
  constructor(what = 'Not found') { super(what); this.name = 'NotFoundError'; }
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.queue = Promise.resolve();
  }

  // run one write at a time
  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  _p(...parts) { return path.join(this.dir, ...parts); }
  _safeId(id) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(id))) throw new NotFoundError('No such product');
    return String(id);
  }

  async _writeJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  }
  async _readJson(file, fallback = null) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }

  async init() {
    await fs.mkdir(this._p('products'), { recursive: true });
    await fs.mkdir(this._p('revisions'), { recursive: true });
  }

  async _order() { return (await this._readJson(this._p('index.json'), { order: [] })).order || []; }

  async list() {
    const ids = await fs.readdir(this._p('products')).then(f => f.filter(x => x.endsWith('.json')).map(x => x.slice(0, -5)), () => []);
    const order = await this._order();
    ids.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
    });
    const out = [];
    for (const id of ids) { const p = await this.get(id).catch(() => null); if (p) out.push(p); }
    return out;
  }

  async get(id) {
    const p = await this._readJson(this._p('products', `${this._safeId(id)}.json`));
    if (!p) throw new NotFoundError('No such product');
    return p;
  }

  async _saveVersion(p) {
    await this._writeJson(this._p('products', `${p.id}.json`), p);
    await this._writeJson(this._p('revisions', p.id, `${p.rev}.json`), p);
    const files = (await fs.readdir(this._p('revisions', p.id))).map(f => parseInt(f, 10)).filter(Number.isFinite).sort((a, b) => a - b);
    for (const old of files.slice(0, Math.max(0, files.length - MAX_REVISIONS))) await fs.rm(this._p('revisions', p.id, `${old}.json`), { force: true });
  }

  create(input, { id: wantedId } = {}) {
    return this._serial(async () => {
      const fields = cleanProduct(input);
      let id = slug(wantedId || input.id || fields.name);
      const taken = new Set((await this.list()).map(p => p.id));
      while (taken.has(id)) id = `${id.slice(0, 28)}-${newId().slice(0, 3)}`;
      const now = new Date().toISOString();
      const product = { id, ...fields, rev: 1, createdAt: now, updatedAt: now };
      await this._saveVersion(product);
      await this._writeJson(this._p('index.json'), { order: [...(await this._order()).filter(x => x !== id), id] });
      return product;
    });
  }

  // expectedRev guards against overwriting someone else's (or another tab's) newer edit
  update(id, input, expectedRev) {
    return this._serial(async () => {
      const current = await this.get(id);
      if (expectedRev != null && Number(expectedRev) !== current.rev) throw new ConflictError(current);
      const fields = cleanProduct(input);
      const next = { ...current, ...fields, id: current.id, rev: current.rev + 1, updatedAt: new Date().toISOString() };
      await this._saveVersion(next);
      return next;
    });
  }

  remove(id) {
    return this._serial(async () => {
      const current = await this.get(id);
      await this._writeJson(this._p('trash', `${current.id}-${Date.now()}.json`), current);
      await fs.rm(this._p('products', `${current.id}.json`), { force: true });
      await this._writeJson(this._p('index.json'), { order: (await this._order()).filter(x => x !== current.id) });
      return current;
    });
  }

  async revisions(id) {
    const safe = this._safeId(id);
    await this.get(safe);
    const files = await fs.readdir(this._p('revisions', safe)).catch(() => []);
    const out = [];
    for (const f of files) {
      const rev = parseInt(f, 10);
      if (!Number.isFinite(rev)) continue;
      const p = await this._readJson(this._p('revisions', safe, f));
      if (p) out.push({ rev, updatedAt: p.updatedAt, name: p.name, now: p.now.length, next: p.next.length, later: p.later.length });
    }
    return out.sort((a, b) => b.rev - a.rev);
  }

  // Restoring creates a NEW revision with the old content, so nothing is ever lost.
  restore(id, rev, expectedRev) {
    return this._serial(async () => {
      const current = await this.get(id);
      if (expectedRev != null && Number(expectedRev) !== current.rev) throw new ConflictError(current);
      const old = await this._readJson(this._p('revisions', current.id, `${parseInt(rev, 10)}.json`));
      if (!old) throw new NotFoundError('No such revision');
      const next = { ...current, ...cleanProduct(old), rev: current.rev + 1, updatedAt: new Date().toISOString() };
      await this._saveVersion(next);
      return next;
    });
  }

  setOrder(ids) {
    return this._serial(async () => {
      const existing = new Set((await this.list()).map(p => p.id));
      const order = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(x => existing.has(x));
      for (const id of existing) if (!order.includes(id)) order.push(id);
      await this._writeJson(this._p('index.json'), { order });
      return order;
    });
  }

  // ---- bulk ----
  async exportAll() {
    const products = await this.list();
    return { version: 1, updatedAt: products.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), '').slice(0, 10) || new Date().toISOString().slice(0, 10), products };
  }

  // Merge by id: products in the file overwrite products with the same id, others are left alone.
  async importAll(data) {
    if (!data || !Array.isArray(data.products)) throw new (require('./schema').ValidationError)('Expected { products: [...] }');
    const done = [];
    for (const raw of data.products.slice(0, 100)) {
      const wanted = slug(raw && (raw.id || raw.name) || '');
      const exists = await this.get(wanted).catch(() => null);
      done.push(exists ? await this.update(wanted, raw, null) : await this.create(raw, { id: wanted }));
    }
    return done;
  }

  // The dataset the public site and the embed widget read.
  async publicDataset() {
    const products = (await this.list()).filter(p => p.visibility === 'public');
    const newest = products.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), '');
    return { version: 1, updatedAt: (newest || new Date().toISOString()).slice(0, 10), products: products.map(publicProduct) };
  }
}

module.exports = { Store, ConflictError, NotFoundError, MAX_REVISIONS };
