'use strict';
const path = require('node:path');
const express = require('express');
const { createAuth } = require('./src/auth');
const { createPublic } = require('./src/public');

// The server stores nothing. Every user's roadmaps live in their own Google Drive; this process serves the pages,
// does the Google sign-in token exchange (src/auth.js) and reads shared roadmaps for visitors (src/public.js).
function createApp(opts = {}) {
  const auth = createAuth(opts);
  const pub = createPublic(opts);
  const dir = path.join(__dirname, 'public');

  const app = express();
  app.set('trust proxy', 1);                // behind Railway's proxy: real client IP, https
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://www.googleapis.com; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ signIn: auth.enabled, publicRoadmaps: pub.enabled }));
  app.use('/auth', auth.router);
  app.use(pub.router);

  app.get('/app', (req, res) => res.sendFile(path.join(dir, 'app.html')));
  app.get('/r/:id', (req, res) => res.sendFile(path.join(dir, 'r.html')));
  // the embed script is loaded by other sites
  app.get('/embed.js', (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=300' });
    res.sendFile(path.join(dir, 'embed.js'));
  });
  app.use(express.static(dir, { index: 'index.html', extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(path.join(dir, 'index.html')));

  if (!auth.enabled) console.warn('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / COOKIE_SECRET): /app cannot sign anyone in.');
  if (!pub.enabled) console.warn('DRIVE_API_KEY is not set: shared roadmaps cannot be read by visitors.');
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Roadmaps on port ${port}`));
}
