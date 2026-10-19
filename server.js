'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const { Store } = require('./src/store');
const { createAuth } = require('./src/auth');
const { createApi } = require('./src/api');

async function createApp(opts = {}) {
  const env = process.env;
  const dataDir = opts.dataDir || env.DATA_DIR || path.join(__dirname, 'data');
  const store = new Store(dataDir);
  await store.init();

  // first start with an empty data folder: load the example roadmap so there is something to look at
  const seedFile = opts.seedFile !== undefined ? opts.seedFile : (env.SEED_FILE || path.join(__dirname, 'seed', 'roadmap.json'));
  if (seedFile && !(await store.list()).length) {
    try { await store.importAll(JSON.parse(await fs.readFile(seedFile, 'utf8'))); console.log(`Seeded ${dataDir} from ${seedFile}`); }
    catch (e) { if (e.code !== 'ENOENT') console.warn('Could not seed:', e.message); }
  }

  const auth = createAuth({ adminToken: opts.adminToken !== undefined ? opts.adminToken : env.ADMIN_TOKEN, sessionSecret: opts.sessionSecret || env.SESSION_SECRET });

  const app = express();
  app.set('trust proxy', 1);                // behind Railway's proxy: real client IP, https
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(createApi({ store, auth }));

  const pub = path.join(__dirname, 'public');
  app.get('/p/:id', (req, res) => res.sendFile(path.join(pub, 'p.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  // the embed script is loaded by other sites
  app.get('/embed.js', (req, res) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=300' }); res.sendFile(path.join(pub, 'embed.js')); });
  app.use(express.static(pub, { index: 'index.html', extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(path.join(pub, 'index.html')));

  if (!auth.enabled) console.warn('ADMIN_TOKEN is not set: the editor is disabled (the public pages still work).');
  return { app, store };
}

module.exports = { createApp };

if (require.main === module) {
  createApp().then(({ app }) => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Roadmaps on port ${port}`));
  });
}
