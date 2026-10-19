'use strict';
// HTTP API.
//   public (open CORS, anyone can read):
//     GET  /roadmap.json  and  /api/roadmap.json   all public products — what the embed widget reads
//     GET  /api/products                           list (private ones too if you are signed in)
//     GET  /api/products/:id                       one product (private ones only if signed in)
//   admin (signed-in, same-origin only):
//     GET  /api/me · POST /api/login · POST /api/logout
//     POST /api/products · PUT /api/products/:id · DELETE /api/products/:id
//     PUT  /api/order · GET /api/products/:id/revisions · POST /api/products/:id/restore
//     GET  /api/export · POST /api/import

const express = require('express');
const { ValidationError } = require('./schema');
const { ConflictError, NotFoundError } = require('./store');

function createApi({ store, auth }) {
  const router = express.Router();

  // JSON only: a plain HTML form (the usual CSRF vehicle) can't send application/json
  router.use(express.json({ limit: '512kb', type: 'application/json' }));
  const mustBeJson = (req, res, next) => {
    // req.is() is null when there is no body at all (a DELETE), false when the body is not JSON
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && req.is('application/json') === false) {
      return res.status(415).json({ error: 'unsupported_media_type', message: 'Send application/json.' });
    }
    next();
  };
  router.use(mustBeJson);

  const open = (req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }); next(); };
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- public ----
  const dataset = wrap(async (req, res) => res.json(await store.publicDataset()));
  router.get('/roadmap.json', open, dataset);
  router.get('/api/roadmap.json', open, dataset);

  router.get('/api/products', open, wrap(async (req, res) => {
    const admin = auth.isAdmin(req);
    if (admin) res.set('Cache-Control', 'no-store');
    const list = (await store.list()).filter(p => admin || p.visibility === 'public');
    if (admin && req.query.full === '1') return res.json(list);   // the editor loads everything in one call
    res.json(list.map(p => ({
      id: p.id, name: p.name, tagline: p.tagline, url: p.url,
      ...(admin ? { visibility: p.visibility, rev: p.rev, updatedAt: p.updatedAt } : {}),
      counts: { now: p.now.length, next: p.next.length, later: p.later.length }
    })));
  }));

  router.get('/api/products/:id', open, wrap(async (req, res) => {
    const admin = auth.isAdmin(req);
    const p = await store.get(req.params.id);
    if (p.visibility !== 'public' && !admin) throw new NotFoundError('No such product');
    if (admin) res.set('Cache-Control', 'no-store');
    res.json(admin ? p : { id: p.id, name: p.name, tagline: p.tagline, url: p.url, now: p.now, next: p.next, later: p.later, updatedAt: p.updatedAt });
  }));

  // ---- session ----
  router.get('/api/me', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ admin: auth.isAdmin(req), editingEnabled: auth.enabled }); });
  router.post('/api/login', auth.login);
  router.post('/api/logout', auth.logout);

  // ---- admin ----
  const admin = auth.requireAdmin;
  router.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.post('/api/products', admin, wrap(async (req, res) => res.status(201).json(await store.create(req.body))));
  router.put('/api/products/:id', admin, wrap(async (req, res) => res.json(await store.update(req.params.id, req.body, req.body && req.body.rev))));
  router.delete('/api/products/:id', admin, wrap(async (req, res) => { await store.remove(req.params.id); res.status(204).end(); }));
  router.put('/api/order', admin, wrap(async (req, res) => res.json({ order: await store.setOrder(req.body && req.body.order) })));

  router.get('/api/products/:id/revisions', admin, wrap(async (req, res) => res.json(await store.revisions(req.params.id))));
  router.post('/api/products/:id/restore', admin, wrap(async (req, res) => res.json(await store.restore(req.params.id, req.body && req.body.revision, req.body && req.body.rev))));

  router.get('/api/export', admin, wrap(async (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="roadmaps.json"');
    res.json(await store.exportAll());
  }));
  router.post('/api/import', admin, wrap(async (req, res) => res.json({ imported: (await store.importAll(req.body)).length })));

  router.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'No such endpoint.' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof ConflictError) return res.status(409).json({ error: 'conflict', message: err.message, current: err.current });
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'not_found', message: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: 'invalid', message: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'That is not valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'That is too big.' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
  });

  return router;
}

module.exports = { createApi };
