'use strict';
// Admin sign-in. For now one secret (ADMIN_TOKEN) — enough for a tool only its owner edits. The session is a
// signed, httpOnly cookie; nothing is stored on the server. Replace this module with Google sign-in
// (allowed e-mail list) when more people need to edit — nothing else depends on how it works, only on
// `isAdmin(req)` and `requireAdmin`.

const crypto = require('node:crypto');

const COOKIE = 'rm_session';
const MAX_AGE_S = 30 * 24 * 3600;

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const b64 = buf => Buffer.from(buf).toString('base64url');

function createAuth({ adminToken, sessionSecret }) {
  const enabled = !!adminToken;
  const secret = sessionSecret || crypto.randomBytes(32).toString('hex');   // sessions end on restart if unset
  const sign = payload => b64(crypto.createHmac('sha256', secret).update(payload).digest());

  function readCookie(req) {
    const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
    return m ? m.slice(COOKIE.length + 1) : '';
  }

  function isAdmin(req) {
    if (!enabled) return false;
    const [payload, sig] = readCookie(req).split('.');
    if (!payload || !sig) return false;
    const good = sign(payload);
    const a = Buffer.from(sig), b = Buffer.from(good);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
  }

  // Cookie auth must not be usable from other sites: state-changing calls have to come from this origin.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function requireAdmin(req, res, next) {
    if (!enabled) return res.status(503).json({ error: 'admin_disabled', message: 'Set ADMIN_TOKEN to enable editing.' });
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized', message: 'Sign in first.' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return res.status(403).json({ error: 'bad_origin', message: 'Cross-site request refused.' });
    next();
  }

  // a few attempts per IP, then wait
  const tries = new Map();
  function limited(ip) {
    const now = Date.now();
    const t = tries.get(ip);
    if (!t || now - t.start > 10 * 60 * 1000) { tries.set(ip, { start: now, n: 1 }); return false; }
    return ++t.n > 8;
  }

  function login(req, res) {
    if (!enabled) return res.status(503).json({ error: 'admin_disabled', message: 'Set ADMIN_TOKEN to enable editing.' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'bad_origin', message: 'Cross-site request refused.' });
    if (limited(req.ip)) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' });
    const given = sha(req.body && req.body.token);
    if (!crypto.timingSafeEqual(given, sha(adminToken))) return res.status(401).json({ error: 'wrong_token', message: 'That token is not right.' });
    const payload = b64(JSON.stringify({ exp: Date.now() + MAX_AGE_S * 1000 }));
    res.append('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${req.secure ? '; Secure' : ''}`);
    res.json({ admin: true });
  }

  function logout(req, res) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.json({ admin: false });
  }

  return { enabled, isAdmin, requireAdmin, login, logout };
}

module.exports = { createAuth };
