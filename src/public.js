'use strict';
// Public read access to a shared roadmap.
//
// When a user makes a roadmap public, the app writes a copy of it to a Drive file that "anyone with the link" can
// read. This endpoint is how visitors, the /r/<id> page and the embed widget read that file — always through
// this server, so the address people share is a Roadmaps address, and sites that embed it don't each need
// their own Google API key.
//
//   GET /api/public/:id      → { id, name, tagline, url, now, next, later, updatedAt }
//   GET /r/:id/feed.atom     → Atom feed of the same roadmap: one entry per publication (see feed() below)
//
// The server holds no roadmap data: it fetches the file with a read-only API key, checks it really is a
// Roadmaps file, cleans it, and caches the result for a short while.

const crypto = require('node:crypto');
const express = require('express');
const { cleanPublic } = require('./schema');

const ID = /^[A-Za-z0-9_-]{10,100}$/;
const xml = v => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const TTL_MS = 30 * 1000;
const MAX_CACHE = 500;

// The server keeps no history, so the feed cannot list past changes. Instead every publication is one entry:
// its id contains the publication time (the Drive modifiedTime of the public copy), so a reader sees a new entry each
// time the owner publishes, with the Now / Next / Later summary as it stood then. Readers keep the older entries.
function feed(doc, origin) {
  const page = `${origin}/r/${doc.id}`;
  const when = new Date(doc.updatedAt);
  const updated = isNaN(when) ? new Date(0).toISOString() : when.toISOString();
  const line = (label, items) => `${label}: ${items.length ? items.map(i => i.title).join('; ') : 'nothing planned yet'}`;
  const summary = [line('Now', doc.now), line('Next', doc.next), line('Later', doc.later)].join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xml(doc.name)} — roadmap</title>
  ${doc.tagline ? `<subtitle>${xml(doc.tagline)}</subtitle>\n  ` : ''}<id>${xml(page)}</id>
  <link rel="self" type="application/atom+xml" href="${xml(page)}/feed.atom"/>
  <link rel="alternate" type="text/html" href="${xml(page)}"/>
  <updated>${updated}</updated>
  <entry>
    <title>Roadmap updated ${updated.slice(0, 10)}</title>
    <id>${xml(page)}#${updated}</id>
    <link rel="alternate" type="text/html" href="${xml(page)}"/>
    <updated>${updated}</updated>
    <content type="text">${xml(summary)}</content>
  </entry>
</feed>
`;
}

function createPublic(opts = {}) {
  const env = opts.env || process.env;
  const apiKey = env.DRIVE_API_KEY || '';
  const driveBase = (env.GOOGLE_DRIVE_BASE || 'https://www.googleapis.com/drive/v3').replace(/\/$/, '');
  const doFetch = opts.fetchImpl || fetch;
  const enabled = !!apiKey;
  const origin = String(env.PUBLIC_URL || '').replace(/\/$/, '');

  const cache = new Map();   // id → { at, status, body, etag }

  async function load(id) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;

    const q = `key=${encodeURIComponent(apiKey)}`;
    let entry;
    try {
      const [meta, media] = await Promise.all([
        doFetch(`${driveBase}/files/${id}?fields=modifiedTime&${q}`, { signal: AbortSignal.timeout(10000) }),
        doFetch(`${driveBase}/files/${id}?alt=media&${q}`, { signal: AbortSignal.timeout(10000) })
      ]);
      if (media.status === 404 || media.status === 403 || meta.status === 404 || meta.status === 403) {
        entry = { status: 404, body: { error: 'not_shared', message: 'This roadmap isn’t shared (any more).' } };
      } else if (!media.ok || !meta.ok) {
        throw new Error(`drive ${media.status}/${meta.status}`);
      } else {
        const doc = cleanPublic(await media.json().catch(() => null));
        entry = doc
          ? { status: 200, body: { id, ...doc, updatedAt: String((await meta.json()).modifiedTime || '') } }
          : { status: 404, body: { error: 'not_a_roadmap', message: 'That link doesn’t point to a Roadmaps roadmap.' } };
      }
    } catch (e) {
      if (hit) return hit;                    // Drive is having a moment: serve the last good copy
      return { status: 502, body: { error: 'upstream', message: 'Couldn’t reach Google Drive right now.' }, at: Date.now() - TTL_MS + 5000 };
    }
    entry.at = Date.now();
    entry.etag = `"${crypto.createHash('sha1').update(JSON.stringify(entry.body)).digest('hex').slice(0, 16)}"`;
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(id, entry);
    return entry;
  }

  const hits = new Map();
  const limited = ip => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > 60000) { hits.set(ip, { n: 1, t: now }); return false; }
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60000) hits.delete(k);
    return ++h.n > 120;
  };

  const router = express.Router();
  router.get('/api/public/:id', async (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    if (!enabled) return res.status(503).json({ error: 'not_configured', message: 'Public roadmaps are not switched on.' });
    if (!ID.test(req.params.id)) return res.status(404).json({ error: 'not_found', message: 'No such roadmap.' });
    if (limited(req.ip)) return res.status(429).json({ error: 'rate_limited' });

    const e = await load(req.params.id);
    if (e.status !== 200) { res.set('Cache-Control', 'no-store'); return res.status(e.status).json(e.body); }
    res.set({ 'Cache-Control': 'public, max-age=30, stale-while-revalidate=300', ETag: e.etag });
    if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
    res.json(e.body);
  });

  router.get('/r/:id/feed.atom', async (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    if (!enabled) return res.status(503).type('text/plain').send('Public roadmaps are not switched on.');
    if (!ID.test(req.params.id)) return res.status(404).type('text/plain').send('No such roadmap.');
    if (limited(req.ip)) return res.status(429).type('text/plain').send('Too many requests.');
    const e = await load(req.params.id);
    if (e.status !== 200) { res.set('Cache-Control', 'no-store'); return res.status(e.status === 404 ? 404 : 502).type('text/plain').send(e.body.message || 'Not available.'); }
    const tag = e.etag.replace(/"$/, '-atom"');
    res.set({ 'Cache-Control': 'public, max-age=300', ETag: tag });
    if (req.headers['if-none-match'] === tag) return res.status(304).end();
    res.type('application/atom+xml; charset=utf-8').send(feed(e.body, origin || `${req.protocol}://${req.get('host')}`));
  });

  return { router, enabled };
}

module.exports = { createPublic };
