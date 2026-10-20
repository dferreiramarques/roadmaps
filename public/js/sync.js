'use strict';
// Google sign-in and Drive sync for Roadmaps.
//
//  • Sign-in: the server keeps a refresh token in an encrypted cookie (src/auth.js) and hands out short-lived access
//    tokens through POST /auth/refresh. Nothing about the user is stored on the server.
//  • Data: all of a user's roadmaps are ONE file in their own Drive's private app folder (roadmaps-data.json).
//  • Sharing: a roadmap made public is copied to a separate Drive file that anyone with the link can read; visitors read it
//    through this server (/api/public/<fileId>), so the address people share is always a Roadmaps address.
//
// The working copy lives in localStorage, Drive is the durable copy, and:
//   – changeSeq/savedSeq + a persisted dirty flag track edits that haven't reached Drive;
//   – the Drive modifiedTime our copy is based on is remembered, so we ask before overwriting a newer version;
//   – a failed or ambiguous load never leads to a save; offline, a returning user keeps working and it reconciles later.
window.RMSync = (() => {
  const DRIVE_API = 'https://www.googleapis.com/drive/v3';
  const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FILE_NAME = 'roadmaps-data.json';
  const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const SKEW = 5 * 60 * 1000;
  const SAVE_DELAY = 1200;

  const LS = {
    data: 'roadmaps-data', dirty: 'roadmaps-dirty', base: 'roadmaps-base', fid: 'roadmaps-file-id',
    hint: 'roadmaps-hint', sub: 'roadmaps-sub', revokes: 'roadmaps-revokes'
  };
  const SS_TOKEN = 'roadmaps-token';

  const get = k => { try { const v = localStorage.getItem(k); return v === null || v === 'null' || v === 'undefined' ? null : v; } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const del = k => { try { localStorage.removeItem(k); } catch {} };
  const json = k => { try { return JSON.parse(get(k)); } catch { return null; } };

  class AuthError extends Error {}
  class ShareError extends Error {}

  let hooks = { getData: () => ({ roadmaps: [], current: '' }), applyData() {}, onStatus() {}, onGate() {}, onSignedIn() {}, confirmConflict: async () => true, toast() {} };

  // ── state ───────────────────────────────────────────────────────────────────────────
  let token = null, tokenExp = 0, scopes = '';
  let user = json(LS.hint);
  let needsReauth = false, authTransient = false, refreshInFlight = null, refreshTimer = null;
  let driveFileId = get(LS.fid), driveModified = get(LS.base);
  let changeSeq = 0, savedSeq = 0, driveReady = false, offline = false;
  let saving = false, saveQueued = false, saveTimer = null, retryTimer = null, retryDelay = 0, reconcileTimer = null, reconciling = false;
  let sharing = false, shareRetryTimer = null, shareRetryDelay = 0;
  const lastPublished = new Map();    // roadmap id → snapshot already on Drive

  const isDirty = () => changeSeq !== savedSeq;
  const hasUnsynced = () => isDirty() || get(LS.dirty) === '1';
  const tokenFresh = (margin = 30000) => !!token && Date.now() < tokenExp - margin;
  const hasShareScope = () => scopes.includes(FILE_SCOPE);

  // ── tokens ──────────────────────────────────────────────────────────────────────────
  function applyToken(r) {
    token = r.access_token;
    tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
    if (r.scope) scopes = r.scope;
    needsReauth = false;
    try { sessionStorage.setItem(SS_TOKEN, JSON.stringify({ token, exp: tokenExp, scope: scopes })); } catch {}
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ensureToken(), Math.max(5000, tokenExp - SKEW - Date.now()));
    if (r.user && r.user.sub) {
      // a refreshed profile may lack name/picture: keep the ones we already had for the same account
      const prev = user && user.sub === r.user.sub ? user : {};
      user = { ...r.user };
      for (const k of ['email', 'name', 'given_name', 'picture']) if (!user[k] && prev[k]) user[k] = prev[k];
      set(LS.hint, JSON.stringify(user));
    }
  }

  function restoreToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(SS_TOKEN));
      if (t && t.token && t.exp - Date.now() > SKEW) { token = t.token; tokenExp = t.exp; scopes = t.scope || ''; return true; }
    } catch {}
    return false;
  }

  // 'ok' | 'reauth' (no/dead session: sign in again) | 'transient' (server asleep or offline)
  function serverRefresh() {
    refreshInFlight = refreshInFlight || (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45000);
      try {
        const r = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin', signal: ctl.signal });
        if (r.ok) { applyToken(await r.json()); return 'ok'; }
        return r.status === 401 ? 'reauth' : 'transient';
      } catch { return 'transient'; }
      finally { clearTimeout(timer); refreshInFlight = null; }
    })();
    return refreshInFlight;
  }

  async function ensureToken() {
    if (tokenFresh(SKEW)) return token;
    const fallback = () => (tokenFresh() ? token : null);
    authTransient = false;
    if (!navigator.onLine) { authTransient = true; return fallback(); }
    if (needsReauth) return fallback();
    const res = await serverRefresh();
    if (res === 'ok') return token;
    authTransient = res === 'transient';
    return fallback();
  }

  // ── Drive ───────────────────────────────────────────────────────────────────────────
  async function driveFetch(url, opts = {}, canRetry = true) {
    const t = await ensureToken();
    if (!t) throw authTransient ? new Error('Sign-in service unreachable') : new AuthError('Session expired');
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
    if (r.status === 401) {
      if (!canRetry) throw new AuthError('Session expired');
      tokenExp = 0;
      return driveFetch(url, opts, false);
    }
    return r;
  }

  async function findFile() {
    const r = await driveFetch(`${DRIVE_API}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&q=name%3D'${FILE_NAME}'`);
    if (!r.ok) throw new Error(`find ${r.status}`);
    const { files } = await r.json();
    return files && files.length ? files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))[0] : null;
  }

  // {data, modifiedTime}, or null when the user has no file yet. Throws on any failure — never "empty by accident".
  async function loadRemote() {
    const f = await findFile();
    if (!f) { driveFileId = null; del(LS.fid); return null; }
    driveFileId = f.id; set(LS.fid, f.id);
    const r = await driveFetch(`${DRIVE_API}/files/${f.id}?alt=media`);
    if (!r.ok) throw new Error(`load ${r.status}`);
    const data = await r.json();
    if (!data || !Array.isArray(data.roadmaps)) throw new Error('unexpected file format');
    return { data, modifiedTime: f.modifiedTime };
  }

  const setBase = t => { driveModified = t || null; if (t) set(LS.base, t); else del(LS.base); };
  const payload = () => { const d = hooks.getData(); return { app: 'roadmaps', version: 1, savedAt: Date.now(), current: d.current, roadmaps: d.roadmaps }; };
  const saveLocal = () => set(LS.data, JSON.stringify(hooks.getData()));

  function adoptRemote(remote) {
    hooks.applyData({ roadmaps: remote.data.roadmaps, current: remote.data.current || '' });
    saveLocal();
    setBase(remote.modifiedTime);
    savedSeq = changeSeq;
    del(LS.dirty);
  }

  async function writeOnce() {
    const seq = changeSeq;
    const body = JSON.stringify(payload());
    let file = driveFileId ? { id: driveFileId } : await findFile();
    if (file) {
      const m = await driveFetch(`${DRIVE_API}/files/${file.id}?fields=modifiedTime`);
      if (m.status === 404) { file = null; driveFileId = null; del(LS.fid); setBase(null); }
      else if (!m.ok) throw new Error(`check ${m.status}`);
      else {
        const { modifiedTime } = await m.json();
        if (!driveModified || Date.parse(modifiedTime) > Date.parse(driveModified)) {
          if (!(await hooks.confirmConflict())) {
            const remote = await loadRemote();
            if (remote) { adoptRemote(remote); return; }
            file = null;
          }
        }
      }
    }
    let r;
    if (file) {
      r = await driveFetch(`${DRIVE_UPLOAD}/files/${file.id}?uploadType=media&fields=id,modifiedTime`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000
      });
      if (r.status === 404) { driveFileId = null; del(LS.fid); setBase(null); throw new Error('file moved, retrying'); }
    } else {
      r = await driveFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
        method: 'POST', ...multipart({ name: FILE_NAME, parents: ['appDataFolder'] }, body)
      });
    }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(`save ${r.status}: ${(e.error && e.error.message) || r.statusText}`); }
    const res = await r.json();
    if (!res.id) throw new Error('No file ID in response');
    driveFileId = res.id; set(LS.fid, res.id);
    setBase(res.modifiedTime);
    savedSeq = seq;                      // edits made mid-save stay dirty
    if (seq === changeSeq) del(LS.dirty);
  }

  function multipart(meta, content) {
    const boundary = 'rm_' + Date.now();
    const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(meta), `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`].join('\r\n');
    return { headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body };
  }

  async function saveNow() {
    if (!driveReady || needsReauth) return;
    if (saving) { saveQueued = true; return; }
    if (!isDirty()) return;
    saving = true;
    clearTimeout(retryTimer);
    hooks.onStatus('syncing', 'Saving…');
    try {
      await writeOnce();
      retryDelay = 0;
      hooks.onStatus('synced', 'Saved to Drive');
      publishShares();
    } catch (e) {
      console.error('Drive save error:', e.message);
      if (e instanceof AuthError) { hooks.onStatus('error', 'Session expired'); requestReconnect(); }
      else {
        retryDelay = Math.min((retryDelay || 2000) * 2, 60000);
        retryTimer = setTimeout(saveNow, retryDelay);
        hooks.onStatus('error', navigator.onLine ? 'Save failed — retrying…' : 'Offline — saved on this device');
      }
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; scheduleSave(); }
    }
  }

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, SAVE_DELAY); }
  function flush() { if (driveReady && isDirty()) { clearTimeout(saveTimer); saveNow(); } }

  // Call after ANY change to the roadmaps. Saved locally at once, to Drive shortly after.
  function changed() {
    changeSeq++;
    set(LS.dirty, '1');
    saveLocal();
    if (driveReady) scheduleSave();
  }

  // ── sign-in flow ────────────────────────────────────────────────────────────────────
  function requestReconnect() {
    needsReauth = true;
    hooks.onGate('Your Google session expired. Reconnect to keep syncing — your changes are safe on this device.');
  }

  function signIn(switchAccount) {
    const u = new URL('/auth/login', location.origin);
    if (switchAccount || !(user && user.email)) u.searchParams.set('switch', '1');
    else u.searchParams.set('hint', user.email);
    location.href = u.toString();
  }

  async function signOut() {
    clearTimeout(saveTimer);
    if (hasUnsynced() && driveReady) { await saveNow(); }
    if (hasUnsynced() && !confirm('Some changes haven’t reached Drive yet and will be lost if you sign out. Sign out anyway?')) return false;
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    clearTimeout(refreshTimer); clearTimeout(retryTimer); clearTimeout(reconcileTimer);
    try { sessionStorage.removeItem(SS_TOKEN); } catch {}
    [LS.data, LS.dirty, LS.base, LS.fid, LS.hint, LS.sub, LS.revokes].forEach(del);
    token = null; tokenExp = 0; user = null; driveReady = false; offline = false; needsReauth = false;
    changeSeq = savedSeq = 0; driveFileId = null; driveModified = null; lastPublished.clear();
    return true;
  }

  // Decide between this device's copy and Drive's, then open the app.
  async function bootData() {
    hooks.onStatus('syncing', 'Loading from Drive…');
    try {
      const remote = await loadRemote();
      const hasRemote = !!(remote && remote.data.roadmaps.length);
      const localDirty = get(LS.dirty) === '1';
      const base = get(LS.base);
      let upload = false;

      if (hasRemote && !localDirty) adoptRemote(remote);
      else if (hasRemote) {
        const moved = !base || Date.parse(remote.modifiedTime) > Date.parse(base);
        if (moved && !(await hooks.confirmConflict())) adoptRemote(remote);
        else { const local = json(LS.data); if (local) hooks.applyData(local); setBase(remote.modifiedTime); upload = true; }
      } else {
        const local = json(LS.data);
        if (local && local.roadmaps && local.roadmaps.length) hooks.applyData(local); else hooks.applyData({ roadmaps: [], current: '' });
        setBase(remote ? remote.modifiedTime : null);
        upload = true;
      }
      driveReady = true;
      const wasOffline = offline;
      offline = false; clearTimeout(reconcileTimer);
      hooks.onSignedIn(user);
      if (upload && hooks.getData().roadmaps.length) { changeSeq++; set(LS.dirty, '1'); await saveNow(); if (wasOffline && !isDirty()) hooks.toast('Back online — your changes are synced'); }
      else hooks.onStatus('synced', 'Loaded from Drive');
      publishShares();
    } catch (e) {
      console.error('bootData error:', e.message);
      if (e instanceof AuthError) { requestReconnect(); return; }
      if (user && get(LS.sub)) { enterOffline(); return; }       // couldn't reach Drive: keep working from the local copy
      hooks.onGate('Couldn’t load your roadmaps from Drive — check your connection and try again.', 'retry');
    }
  }

  function enterOffline() {
    const first = !offline;
    offline = true; driveReady = false;
    const local = json(LS.data);
    hooks.applyData(local && local.roadmaps ? local : { roadmaps: [], current: '' });
    hooks.onSignedIn(user);
    hooks.onStatus('error', navigator.onLine ? 'Drive unreachable — saved on this device' : 'Offline — saved on this device');
    if (first) hooks.toast('Offline — your changes are kept here and sync when you’re back');
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, 20000);
  }

  async function reconcile() {
    if (!offline || reconciling) return;
    if (!navigator.onLine) { reconcileTimer = setTimeout(reconcile, 20000); return; }
    reconciling = true;
    try {
      if (!tokenFresh() && !(await ensureToken())) {
        if (authTransient) { reconcileTimer = setTimeout(reconcile, 20000); return; }
        return requestReconnect();
      }
      await bootData();
    } finally { reconciling = false; }
  }

  async function loadUserCheck() {
    if (user && user.sub) {
      const prev = get(LS.sub);
      if (prev && prev !== user.sub) { [LS.data, LS.dirty, LS.base, LS.fid, LS.revokes].forEach(del); driveFileId = null; driveModified = null; changeSeq = savedSeq = 0; }   // never mix two accounts' roadmaps
      set(LS.sub, user.sub);
    }
  }

  // One entry point for the page: resolves to 'signedout' (show the sign-in gate) or 'running'.
  async function start() {
    let cfg = { signIn: true };
    try { cfg = await (await fetch('/api/config')).json(); } catch {}
    if (!cfg.signIn) { hooks.onGate('Sign-in isn’t switched on for this server yet.', 'disabled'); return 'signedout'; }

    const err = new URLSearchParams(location.search).get('auth_error');
    if (err) { history.replaceState(null, '', location.pathname); hooks.onGate(authErrorMessage(err)); }

    let ok = restoreToken();
    if (!ok) {
      const res = await serverRefresh();
      ok = res === 'ok';
      if (!ok && res === 'transient') {
        if (user && get(LS.sub)) { await loadUserCheck(); enterOffline(); return 'running'; }
        hooks.onGate('Can’t reach the sign-in service right now — check your connection and try again.', 'retry');
        return 'signedout';
      }
    }
    if (!ok) { if (!err) hooks.onGate(''); return 'signedout'; }
    await loadUserCheck();
    await bootData();
    return 'running';
  }

  const authErrorMessage = code =>
    code === 'access_denied' ? 'Sign-in was cancelled — try again.'
    : code === 'scope' ? 'Roadmaps needs permission to use its private Drive folder — tick the Drive box and try again.'
    : 'Sign-in didn’t complete — please try again.';

  // ── sharing ─────────────────────────────────────────────────────────────────────────
  // Public copy of a roadmap: what visitors may see, and nothing else.
  const publicDoc = r => ({
    app: 'roadmaps-public', v: 1,
    name: r.name, tagline: r.tagline || '', url: r.url || '',
    lang: r.lang || 'en', version: r.version || '',
    now: r.now.map(slim), next: r.next.map(slim), later: r.later.map(slim),
    shipped: (r.shipped || []).slice(0, 100).map(slimShipped),
    releases: (r.releases || []).slice(0, 20).map(v => ({ version: v.version, closedAt: v.closedAt || 0, items: (v.items || []).slice(0, 100).map(slimShipped) }))
  });
  const slim = it => ({ title: it.title, description: it.description || '', tag: it.tag || '', tone: it.tone || 'secondary', when: it.when || '' });
  const slimShipped = it => ({ ...slim(it), shippedAt: it.shippedAt || 0 });
  const stamped = doc => JSON.stringify({ ...doc, publishedAt: Date.now() });

  async function shareCreate(r) {
    if (!hasShareScope()) throw new ShareError('scope');
    if (!driveReady || !navigator.onLine) throw new Error('Sharing needs a connection to Google Drive.');
    const doc = publicDoc(r);
    const res = await driveFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', ...multipart({ name: `Roadmap — ${r.name}`, mimeType: 'application/json' }, stamped(doc)) });
    if (res.status === 403) throw new ShareError('scope');
    if (!res.ok) throw new Error(`create ${res.status}`);
    const fileId = (await res.json()).id;
    if (!fileId) throw new Error('no file id');
    // anyone with the link can read it — visitors reach it through the server, never by guessing in Drive
    const p = await driveFetch(`${DRIVE_API}/files/${fileId}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }) });
    if (!p.ok) { await driveFetch(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE' }).catch(() => {}); throw new Error(`permission ${p.status}`); }
    r.share = { fileId, createdAt: Date.now() };
    lastPublished.set(r.id, JSON.stringify(doc));
    changed();
    return r.share;
  }

  async function shareRevoke(r) {
    const res = await driveFetch(`${DRIVE_API}/files/${r.share.fileId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`revoke ${res.status}`);
    delete r.share;
    lastPublished.delete(r.id);
    changed();
  }

  async function publishOne(r) {
    const doc = publicDoc(r);
    const res = await driveFetch(`${DRIVE_UPLOAD}/files/${r.share.fileId}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: stamped(doc), keepalive: true });
    if (res.status === 404) { delete r.share; lastPublished.delete(r.id); changed(); hooks.toast(`“${r.name}” is private again — its shared copy was removed from Drive`); return; }
    if (!res.ok) throw new Error(`publish ${res.status}`);
    lastPublished.set(r.id, JSON.stringify(doc));
  }

  const pendingRevokes = () => json(LS.revokes) || [];
  const queueRevoke = id => { const l = pendingRevokes(); if (!l.includes(id)) { l.push(id); set(LS.revokes, JSON.stringify(l)); } };
  async function processRevokes() {
    const list = pendingRevokes();
    if (!list.length) return;
    const left = [];
    for (const id of list) {
      try { const r = await driveFetch(`${DRIVE_API}/files/${id}`, { method: 'DELETE' }); if (!r.ok && r.status !== 404) left.push(id); }
      catch (e) { if (e instanceof AuthError) throw e; left.push(id); }
    }
    if (left.length) set(LS.revokes, JSON.stringify(left)); else del(LS.revokes);
  }

  // Push every shared roadmap that changed since its last publish
  async function publishShares() {
    if (!driveReady || sharing || needsReauth) return;
    sharing = true;
    try {
      await processRevokes();
      for (const r of hooks.getData().roadmaps.filter(x => x.share && x.share.fileId && JSON.stringify(publicDoc(x)) !== lastPublished.get(x.id))) await publishOne(r);
      shareRetryDelay = 0;
    } catch (e) {
      console.warn('share publish failed:', e.message);
      if (!(e instanceof AuthError)) { shareRetryDelay = Math.min((shareRetryDelay || 4000) * 2, 60000); clearTimeout(shareRetryTimer); shareRetryTimer = setTimeout(publishShares, shareRetryDelay); }
    } finally { sharing = false; }
  }

  // ── lifecycle events ────────────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', async () => {
    if (!driveReady) return;
    if (document.visibilityState === 'hidden') { flush(); return; }
    if (!(await ensureToken()) && !authTransient) requestReconnect();
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('online', () => {
    if (offline) { hooks.toast('Back online — syncing…'); reconcile(); return; }
    if (driveReady) { flush(); publishShares(); }
  });
  window.addEventListener('offline', () => { if (driveReady) { hooks.onStatus('error', 'Offline — saved on this device'); hooks.toast('You’re offline — changes are kept here and sync later'); } });
  window.addEventListener('beforeunload', e => { if (hasUnsynced() && driveReady) { e.preventDefault(); e.returnValue = ''; } });

  return {
    init(h) { hooks = { ...hooks, ...h }; },
    start, changed, signIn, signOut,
    user: () => user,
    retryBoot: () => start(),
    share: { create: shareCreate, revoke: shareRevoke, hasScope: hasShareScope, queueRevoke, publish: publishShares, ShareError, AuthError },
    isReady: () => driveReady,
    isOffline: () => offline,
    hasUnsynced,
    localData: () => json(LS.data)
  };
})();
