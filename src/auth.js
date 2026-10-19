'use strict';
// Long-lived Google sessions (same idea as the Taskboards session server).
//
// Google's browser-only flow only yields 1-hour access tokens. This router uses the "authorization code"
// flow to keep a Google *refresh token*, so the app can quietly get a new access token whenever it needs one.
//
// It stores NOTHING: the refresh token lives in an encrypted, httpOnly cookie in the user's own browser,
// and every roadmap lives in the user's own Google Drive. The server only does the token exchange.
//
//   GET  /auth/login     → redirect to Google (access_type=offline)
//   GET  /auth/callback  → exchange the code, set the cookie, back to /app
//   POST /auth/refresh   → new access token (+ profile) from the cookie
//   POST /auth/logout    → revoke the refresh token and clear the cookie
//
// The app and this server share one origin, so there is no CORS here and the cookie is first-party.

const crypto = require('node:crypto');
const express = require('express');

const DRIVE_APPDATA = 'https://www.googleapis.com/auth/drive.appdata';   // private data (the user's roadmaps)
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';         // the public copy of a shared roadmap
const SCOPE = `openid email profile ${DRIVE_APPDATA} ${DRIVE_FILE}`;
const COOKIE_RT = 'rm_rt';        // encrypted refresh token
const COOKIE_STATE = 'rm_state';  // CSRF state for the login round-trip
const RT_MAX_AGE = 400 * 24 * 3600;   // browsers cap cookies at ~400 days

function createAuth(opts = {}) {
  const env = opts.env || process.env;
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const cookieSecret = env.COOKIE_SECRET || '';
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/$/, '');   // optional; otherwise taken from the request
  const authUrl = env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
  const tokenUrl = env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const revokeUrl = env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';

  const enabled = !!(clientId && clientSecret && cookieSecret);
  const key = enabled ? Buffer.from(crypto.hkdfSync('sha256', cookieSecret, 'roadmaps', 'cookie-encryption', 32)) : null;

  const seal = text => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  };
  const unseal = token => {
    try {
      const buf = Buffer.from(token, 'base64url');
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
  };

  const readCookies = req => {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  };
  const setCookie = (req, res, name, value, maxAge) =>
    res.append('Set-Cookie', `${name}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`);
  const clearCookie = (req, res, name) => setCookie(req, res, name, '', 0);

  const origin = req => publicUrl || `${req.protocol}://${req.get('host')}`;
  const isHttps = req => (publicUrl ? publicUrl.startsWith('https://') : req.secure);

  async function googleToken(params) {
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params })
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  }

  const profileOf = idToken => {
    try {
      const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      return { sub: p.sub, email: p.email, name: p.name, given_name: p.given_name, picture: p.picture };
    } catch { return null; }
  };

  // a few attempts per IP per window
  const hits = new Map();
  const limit = (max, windowMs) => (req, res, next) => {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || now - h.t > windowMs) hits.set(req.ip, { n: 1, t: now });
    else if (++h.n > max) return res.status(429).json({ error: 'rate_limited' });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
    next();
  };

  const router = express.Router();
  const needEnabled = (req, res, next) => (enabled ? next() : res.status(503).json({ error: 'not_configured' }));
  // state-changing calls must come from this very site
  const sameOrigin = (req, res, next) => {
    let ok = false;
    try { ok = !!req.headers.origin && new URL(req.headers.origin).host === req.get('host'); } catch {}
    return ok ? next() : res.status(403).json({ error: 'bad_origin' });
  };

  router.get('/status', (req, res) => res.json({ enabled }));

  router.get('/login', needEnabled, (req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    setCookie(req, res, COOKIE_STATE, seal(JSON.stringify({ nonce })), 600);
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${origin(req)}/auth/callback`,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',            // ask for a refresh token…
      include_granted_scopes: 'true',
      prompt: req.query.switch ? 'select_account consent' : 'consent',   // …and make sure Google issues one
      state: nonce
    });
    if (req.query.hint && !req.query.switch) q.set('login_hint', String(req.query.hint).slice(0, 254));
    res.redirect(`${authUrl}?${q}`);
  });

  router.get('/callback', needEnabled, async (req, res) => {
    const back = error => res.redirect(`/app${error ? `?auth_error=${encodeURIComponent(error)}` : ''}`);
    const st = unseal(readCookies(req)[COOKIE_STATE] || '');
    clearCookie(req, res, COOKIE_STATE);
    if (!st || JSON.parse(st).nonce !== req.query.state) return back('state');
    if (req.query.error) return back(String(req.query.error).slice(0, 40));
    if (!req.query.code) return back('exchange');

    let tok;
    try { tok = await googleToken({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: `${origin(req)}/auth/callback` }); }
    catch { return back('exchange'); }
    if (!tok.ok) return back('exchange');
    if (!String(tok.body.scope || '').includes(DRIVE_APPDATA)) return back('scope');
    if (!tok.body.refresh_token) return back('no_refresh');
    setCookie(req, res, COOKIE_RT, seal(tok.body.refresh_token), RT_MAX_AGE);
    back();
  });

  router.post('/refresh', needEnabled, sameOrigin, limit(120, 60000), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rt = unseal(readCookies(req)[COOKIE_RT] || '');
    if (!rt) return res.status(401).json({ error: 'no_session' });
    let tok;
    try { tok = await googleToken({ grant_type: 'refresh_token', refresh_token: rt }); }
    catch { return res.status(502).json({ error: 'upstream' }); }
    if (!tok.ok) {
      if (tok.body.error === 'invalid_grant') { clearCookie(req, res, COOKIE_RT); return res.status(401).json({ error: 'reauth' }); }
      return res.status(502).json({ error: 'upstream' });
    }
    setCookie(req, res, COOKIE_RT, seal(tok.body.refresh_token || rt), RT_MAX_AGE);   // slide the expiry
    res.json({ access_token: tok.body.access_token, expires_in: tok.body.expires_in, scope: tok.body.scope, user: tok.body.id_token ? profileOf(tok.body.id_token) : null });
  });

  router.post('/logout', needEnabled, sameOrigin, async (req, res) => {
    const rt = unseal(readCookies(req)[COOKIE_RT] || '');
    clearCookie(req, res, COOKIE_RT);
    if (rt) {
      try { await fetch(revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }) }); } catch { /* the cookie is gone either way */ }
    }
    res.sendStatus(204);
  });

  return { router, enabled, SCOPE };
}

module.exports = { createAuth, SCOPE };
