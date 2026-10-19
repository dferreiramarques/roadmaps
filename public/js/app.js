'use strict';
// The Roadmaps app. Your roadmaps are stored in YOUR Google Drive (see sync.js); each one starts private and can be
// made public, which gives you a public page and an embed snippet that always point back to this site.
(() => {
  const COLS = [
    { id: 'now',   label: 'Now',   sub: 'Working on' },
    { id: 'next',  label: 'Next',  sub: 'Up next' },
    { id: 'later', label: 'Later', sub: 'On the horizon' }
  ];
  const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
  const TONE_LABEL = { success: 'Success', info: 'Info', warn: 'Warning', danger: 'Danger', secondary: 'Neutral', contrast: 'Contrast' };

  const $ = s => document.querySelector(s);
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const cleanUrl = v => { v = String(v || '').trim(); return /^https?:\/\/\S+$/i.test(v) ? v.slice(0, 200) : ''; };

  // everything user-written goes in as text, never as HTML
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;            // only ever static icon markup
      else if (k === 'value') e.value = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const ICON_PATHS = {
    plus:   '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash:  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    left:   '<path d="m15 18-6-6 6-6"/>',
    right:  '<path d="m9 18 6-6-6-6"/>',
    check:  '<path d="M20 6 9 17l-5-5"/>',
    x:      '<path d="M18 6 6 18M6 6l12 12"/>',
    lock:   '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    rocket: '<path d="M12 2c3 2.5 4.5 6 4.5 9.5V16l2 3h-4L12 22l-2.5-3h-4l2-3v-4.5C7.5 8 9 4.5 12 2z"/><circle cx="12" cy="10" r="1.6"/>',
    copy:   '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    share:  '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'
  };
  const icon = name => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

  // The same colour system as the Taskboards tabs: an automatic colour per roadmap, or one you pick (right-click the tab).
  const TAB_COLORS = ['#ff004d', '#ffa300', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa', '#ab5236', '#00b543', '#7e2553', '#008751', '#c2c3c7'];
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  function autoColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return TAB_COLORS[hash % TAB_COLORS.length];
  }
  const colorOf = r => (HEX_COLOR.test(r.color) ? r.color : autoColor(r.id));

  // ── state ───────────────────────────────────────────────────────────────────────────
  let roadmaps = [];
  let current = '';
  const roadmap = () => roadmaps.find(r => r.id === current) || roadmaps[0];

  function normalizeRoadmap(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = str(raw.name, 40);
    if (!name) return null;
    const seen = new Set();
    const r = { id: str(raw.id, 24).replace(/[^\w-]/g, '') || uid(), name, tagline: str(raw.tagline, 140), url: cleanUrl(raw.url) };
    for (const c of COLS) {
      r[c.id] = (Array.isArray(raw[c.id]) ? raw[c.id] : []).slice(0, 100).map(it => {
        const title = str(it && it.title, 80);
        if (!title) return null;
        let id = str(it.id, 24).replace(/[^\w-]/g, '') || uid();
        while (seen.has(id)) id = uid();
        seen.add(id);
        return { id, title, description: str(it.description, 280), tag: str(it.tag, 20), tone: TONES.includes(it.tone) ? it.tone : 'secondary' };
      }).filter(Boolean);
    }
    if (HEX_COLOR.test(raw.color)) r.color = raw.color;
    if (Number(raw.updatedAt) > 0) r.updatedAt = Math.floor(Number(raw.updatedAt));
    if (raw.share && /^[A-Za-z0-9_-]{10,100}$/.test(raw.share.fileId || '')) r.share = { fileId: raw.share.fileId, createdAt: Number(raw.share.createdAt) || Date.now() };
    return r;
  }

  // "Updated <date>": a roadmap's updatedAt moves only when what visitors would see changes (name, tagline, website, features),
  // not when tabs are reordered, recoloured or shared. Content is compared against what was last loaded or saved.
  const contentKey = r => JSON.stringify([r.name, r.tagline, r.url, r.now, r.next, r.later]);
  const seenContent = new Map();
  function rememberContent() { seenContent.clear(); roadmaps.forEach(r => seenContent.set(r.id, contentKey(r))); }
  function stampChanges() {
    const now = Date.now();
    for (const r of roadmaps) {
      const key = contentKey(r);
      if (seenContent.get(r.id) !== key) {
        if (seenContent.has(r.id) || !r.updatedAt) r.updatedAt = now;
        seenContent.set(r.id, key);
      }
    }
    for (const id of [...seenContent.keys()]) if (!roadmaps.some(r => r.id === id)) seenContent.delete(id);
  }

  function applyData(d) {
    roadmaps = (d && Array.isArray(d.roadmaps) ? d.roadmaps : []).map(normalizeRoadmap).filter(Boolean);
    rememberContent();
    current = roadmaps.some(r => r.id === (d && d.current)) ? d.current : (roadmaps[0] ? roadmaps[0].id : '');
    renderAll();
  }

  function touch() { stampChanges(); RMSync.changed(); renderAll(); }
  function select(id) { current = id; RMSync.changed(); renderAll(); }

  // ── toast ───────────────────────────────────────────────────────────────────────────
  function toast(msg, tone) {
    const t = el('div', { class: 'toast' + (tone === 'warn' ? ' toast--warn' : ''), html: icon(tone === 'warn' ? 'x' : 'check') }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 3400);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = el('textarea', {}, text);
      ta.className = 'offscreen';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  // ── dialogs ─────────────────────────────────────────────────────────────────────────
  function openDialog({ title, body, foot, onClose, wide }) {
    const prev = document.activeElement;
    const overlay = el('div', { class: 'overlay', role: 'presentation' });
    const dlg = el('div', { class: 'dialog' + (wide ? ' dialog--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'dialog__head' },
        el('h2', { class: 'dialog__title' }, title),
        el('button', { class: 'btn btn--text btn--icon btn--sm', 'aria-label': 'Close', html: icon('x'), onclick: () => close() })),
      el('div', { class: 'dialog__body' }, body),
      el('div', { class: 'dialog__foot' }, foot));
    overlay.append(dlg);
    document.body.append(overlay);

    const focusables = () => [...dlg.querySelectorAll('input, textarea, select, button:not([disabled])')];
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    function close() {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
      onClose?.();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    (dlg.querySelector('input, textarea, select') || dlg.querySelector('.dialog__foot button:last-child'))?.focus();
    return { close, dlg, body: dlg.querySelector('.dialog__body'), foot: dlg.querySelector('.dialog__foot') };
  }

  function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; d.close(); resolve(v); };
      const d = openDialog({
        title,
        body: el('p', { class: 'dialog__msg' }, message),
        foot: [
          el('button', { class: 'btn btn--text', onclick: () => finish(false) }, 'Cancel'),
          el('button', { class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'), onclick: () => finish(true) }, confirm)
        ],
        onClose: () => finish(false)
      });
    });
  }

  // two versions of the same data (this device vs Drive): the user picks
  function conflictDialog() {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; d.close(); resolve(v); };
      const d = openDialog({
        title: 'Changed somewhere else',
        body: el('p', { class: 'dialog__msg' }, 'Your roadmaps were changed on another device — or have edits here that haven’t been saved yet. Which version do you want to keep?'),
        foot: [
          el('button', { class: 'btn btn--outline', onclick: () => finish(false) }, 'Use the Drive version'),
          el('button', { class: 'btn btn--primary', onclick: () => finish(true) }, 'Keep this device’s version')
        ],
        onClose: () => finish(false)
      });
    });
  }

  function field(label, control, hint) {
    const id = 'f' + uid();
    control.id = id;
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint && el('span', { class: 'field__hint' }, hint));
  }

  function segmented(options, value, onPick) {
    const wrap = el('div', { class: 'seg', role: 'group' });
    const paint = () => [...wrap.children].forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].id === value)));
    options.forEach(o => wrap.append(el('button', { type: 'button', class: 'seg__btn', onclick: () => { value = o.id; paint(); onPick(o.id); } }, o.label)));
    paint();
    return wrap;
  }

  // ── roadmap dialog ──────────────────────────────────────────────────────────────────
  function roadmapDialog(r) {
    const isNew = !r;
    const name = el('input', { class: 'input', maxlength: 40, placeholder: 'Product name', value: r?.name || '' });
    const tagline = el('input', { class: 'input', maxlength: 140, placeholder: 'One line about the product', value: r?.tagline || '' });
    const url = el('input', { class: 'input', maxlength: 200, placeholder: 'https://', value: r?.url || '', inputmode: 'url' });

    const save = () => {
      if (!str(name.value, 40)) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
      if (isNew) {
        const nr = { id: uid(), name: str(name.value, 40), tagline: str(tagline.value, 140), url: cleanUrl(url.value), now: [], next: [], later: [] };   // private until shared
        roadmaps.push(nr);
        current = nr.id;
      } else {
        Object.assign(r, { name: str(name.value, 40), tagline: str(tagline.value, 140), url: cleanUrl(url.value) });
      }
      d.close();
      touch();
    };
    const duplicate = () => {
      const names = new Set(roadmaps.map(x => x.name));
      const base = r.name.replace(/\s*\(copy(?: \d+)?\)$/, '').slice(0, 31).trim();   // a copy of a copy is “(copy 2)”, not “(copy) (copy)”
      let name = `${base} (copy)`;
      for (let n = 2; names.has(name); n++) name = `${base} (copy ${n})`;
      const { share, updatedAt, id, ...rest } = JSON.parse(JSON.stringify(r));     // a copy starts private, with new ids
      const copy = normalizeRoadmap({ ...rest, id: '', name, now: rest.now.map(i => ({ ...i, id: '' })), next: rest.next.map(i => ({ ...i, id: '' })), later: rest.later.map(i => ({ ...i, id: '' })) });
      roadmaps.splice(roadmaps.findIndex(x => x.id === r.id) + 1, 0, copy);
      current = copy.id;
      d.close();
      touch();
      toast(`Duplicated as “${copy.name}” — private until you share it`);
    };
    const foot = [
      !isNew && el('button', { class: 'btn btn--text btn--danger-text btn--del-left', onclick: async () => {
        const shared = r.share ? ' Its public page and embed stop working.' : '';
        if (!await confirmDialog({ title: `Delete “${r.name}”?`, message: `The roadmap and all its features are removed from your Drive.${shared}`, confirm: 'Delete', danger: true })) return;
        if (r.share && r.share.fileId) RMSync.share.queueRevoke(r.share.fileId);   // its public copy goes with it
        roadmaps = roadmaps.filter(x => x.id !== r.id);
        current = roadmaps[0] ? roadmaps[0].id : '';
        d.close();
        touch();
        RMSync.share.publish();
      } }, 'Delete roadmap'),
      !isNew && el('button', { class: 'btn btn--text', onclick: duplicate }, 'Duplicate'),
      el('button', { class: 'btn btn--text', onclick: () => d.close() }, 'Cancel'),
      el('button', { class: 'btn btn--primary', onclick: save }, isNew ? 'Create roadmap' : 'Save')
    ];
    const d = openDialog({
      title: isNew ? 'New roadmap' : 'Edit roadmap',
      body: [field('Name', name), field('Tagline', tagline), field('Website', url, 'Shown as a link under the title.')],
      foot
    });
    [name, tagline, url].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
  }

  // ── share dialog ────────────────────────────────────────────────────────────────────
  const publicUrl = r => `${location.origin}/r/${r.share.fileId}`;
  const embedCode = r => `<div data-roadmap="${r.share.fileId}" data-header="true"></div>\n<script src="${location.origin}/embed.js" defer></script>`;

  function shareDialog() {
    const r = roadmap();
    const d = openDialog({ title: 'Share', body: [], foot: [], wide: true });
    const title = d.dlg.querySelector('.dialog__title');
    const put = (box, ...kids) => box.append(...kids.filter(Boolean));   // skip the empty slots (no error, no note)

    function render(state = {}) {
      const isPublic = !!r.share;
      title.innerHTML = icon(isPublic ? 'rocket' : 'lock') + (isPublic ? ' Public roadmap' : ' Private roadmap');
      d.body.replaceChildren();
      d.foot.replaceChildren();
      const err = state.error && el('p', { class: 'share__error' }, state.error);

      if (state.busy) { put(d.body, el('p', { class: 'dialog__msg' }, state.busy)); return; }

      if (!isPublic) {
        put(d.body, 
          el('p', { class: 'dialog__msg' }, `“${r.name}” is private: only you can see it.`),
          el('p', { class: 'dialog__msg dim' }, 'Make it public to get a page anyone can open and a snippet to show it on your website. Anyone with the link can read this roadmap — nothing else in your account is shared, and you can switch it back to private at any time.'),
          state.needScope && el('p', { class: 'share__note' }, 'Sharing needs one more Google permission — to create the public copy of this roadmap in your Drive.'),
          err);
        put(d.foot, 
          el('button', { class: 'btn btn--text', onclick: () => d.close() }, 'Close'),
          el('button', { class: 'btn btn--primary', onclick: () => (state.needScope ? RMSync.signIn(false) : makePublic()) }, state.needScope ? 'Grant permission' : 'Make public'));
        return;
      }

      const pageInput = el('input', { class: 'input mono', readonly: true, value: publicUrl(r) });
      const code = el('textarea', { class: 'textarea mono code', readonly: true, rows: '3' }, embedCode(r));
      const copyRow = (input) => el('div', { class: 'copyrow' }, input,
        el('button', { class: 'btn btn--outline', html: icon('copy') + ' Copy', onclick: async () => toast(await copyText(input.value) ? 'Copied' : 'Couldn’t copy — select the text and copy it', 'ok') }));
      put(d.body, 
        field('Public page', pageInput, 'Anyone with this link can read the roadmap.'),
        copyRow(pageInput),
        field('Embed on your website', code, 'Paste it where the roadmap should appear. It follows your site’s light/dark theme.'),
        copyRow(code),
        el('p', { class: 'dialog__msg dim' }, 'The page and the snippet stay up to date — every change you make here is published within seconds.'),
        err);
      put(d.foot, 
        el('button', { class: 'btn btn--text btn--danger-text btn--del-left', onclick: makePrivate }, 'Make private'),
        el('button', { class: 'btn btn--primary', onclick: () => d.close() }, 'Done'));
    }

    async function makePublic() {
      if (!RMSync.isReady() || !navigator.onLine) return render({ error: 'Sharing needs a connection to Google Drive — try again when you’re online.' });
      if (!RMSync.share.hasScope()) return render({ needScope: true });
      render({ busy: 'Creating the public copy…' });
      try { await RMSync.share.create(r); renderAll(); render(); toast('Roadmap is now public'); }
      catch (e) { render(e instanceof RMSync.share.ShareError ? { needScope: true } : { error: e instanceof RMSync.share.AuthError ? 'Your Google session expired — reconnect and try again.' : 'Couldn’t reach Google Drive — check your connection and try again. Nothing was changed.' }); }
    }
    async function makePrivate() {
      if (!await confirmDialog({ title: `Make “${r.name}” private?`, message: 'The public page and the embedded copies stop working straight away. The roadmap stays in your account.', confirm: 'Make private', danger: true })) return;
      render({ busy: 'Switching it back to private…' });
      try { await RMSync.share.revoke(r); renderAll(); render(); toast('Roadmap is private again'); }
      catch { render({ error: 'Couldn’t reach Google Drive — check your connection and try again. Nothing was changed.' }); }
    }
    render();
  }

  // the labels (tags) already used in a roadmap, with the colour they were given
  function tagsInUse(r) {
    const seen = new Map();
    for (const c of COLS) for (const it of r[c.id]) {
      if (!it.tag) continue;
      const k = it.tag.toLowerCase();
      const e = seen.get(k) || { tag: it.tag, tone: it.tone, n: 0 };
      e.n++;
      seen.set(k, e);
    }
    return [...seen.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, 24);
  }

  // ── feature dialog ──────────────────────────────────────────────────────────────────
  function colOf(id) { const r = roadmap(); return COLS.find(c => r[c.id].some(x => x.id === id))?.id; }

  function itemDialog(item, colId) {
    const isNew = !item;
    const draft = { col: colId, tone: item?.tone || 'secondary' };
    const title = el('input', { class: 'input', maxlength: 80, placeholder: 'Feature name', value: item?.title || '' });
    const desc = el('textarea', { class: 'textarea', maxlength: 280, placeholder: 'What it is and why it matters (optional)' }, item?.description || '');
    const tag = el('input', { class: 'input', maxlength: 20, placeholder: 'e.g. Free, Teams, Beta', value: item?.tag || '' });

    const tones = el('div', { class: 'tones', role: 'group', 'aria-label': 'Tag colour' });
    const paintTones = () => [...tones.children].forEach((b, i) => b.setAttribute('aria-pressed', String(TONES[i] === draft.tone)));
    TONES.forEach(t => tones.append(el('button', { type: 'button', class: 'tone-opt', 'aria-label': TONE_LABEL[t], onclick: () => { draft.tone = t; paintTones(); } },
      el('span', { class: 'tag', 'data-tone': t }, TONE_LABEL[t]))));
    paintTones();
    const colSeg = segmented(COLS, draft.col, v => { draft.col = v; });

    // reuse a label that already exists in this roadmap (it brings its colour along)
    const used = tagsInUse(roadmap());
    const pick = used.length ? el('div', { class: 'tagpick', role: 'group', 'aria-label': 'Labels already used in this roadmap' },
      used.map(u => el('button', { type: 'button', class: 'tag tag--btn', 'data-tone': u.tone, title: 'Use this label', onclick: () => { tag.value = u.tag; draft.tone = u.tone; paintTones(); markPicked(); } }, u.tag))) : null;
    const markPicked = () => pick && [...pick.children].forEach((b, i) => b.setAttribute('aria-pressed', String(used[i].tag.toLowerCase() === tag.value.trim().toLowerCase())));
    tag.addEventListener('input', markPicked);
    markPicked();

    const save = () => {
      const t = str(title.value, 80);
      if (!t) { title.setAttribute('aria-invalid', 'true'); title.focus(); return; }
      const fields = { title: t, description: str(desc.value, 280), tag: str(tag.value, 20), tone: draft.tone };
      const r = roadmap();
      if (isNew) r[draft.col].push({ id: uid(), ...fields });
      else if (draft.col === colId) Object.assign(item, fields);
      else { r[colId] = r[colId].filter(x => x.id !== item.id); Object.assign(item, fields); r[draft.col].push(item); }
      d.close();
      touch();
    };
    const foot = [
      !isNew && el('button', { class: 'btn btn--text btn--danger-text btn--del-left', onclick: () => { d.close(); deleteItem(item.id); } }, 'Delete'),
      el('button', { class: 'btn btn--text', onclick: () => d.close() }, 'Cancel'),
      el('button', { class: 'btn btn--primary', onclick: save }, isNew ? 'Add feature' : 'Save')
    ];
    const d = openDialog({
      title: isNew ? 'Add feature' : 'Edit feature',
      body: [
        field('Title', title), field('Description', desc),
        el('div', { class: 'row2' }, field('Tag', tag, 'A short label on the card.'), el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Column'), colSeg)),
        pick && el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Labels already in this roadmap'), pick),
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tag colour'), tones)
      ],
      foot
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  }

  async function deleteItem(id) {
    const r = roadmap();
    const col = colOf(id);
    const it = col && r[col].find(x => x.id === id);
    if (!it) return;
    if (!await confirmDialog({ title: 'Delete this feature?', message: `“${it.title}” will be removed from the ${COLS.find(c => c.id === col).label.toLowerCase()} list.`, confirm: 'Delete', danger: true })) return;
    r[col] = r[col].filter(x => x.id !== id);
    touch();
  }

  // ── moving ──────────────────────────────────────────────────────────────────────────
  function moveItem(id, toCol, toIdx) {
    const r = roadmap();
    let item = null;
    for (const c of COLS) {
      const i = r[c.id].findIndex(x => x.id === id);
      if (i >= 0) { item = r[c.id].splice(i, 1)[0]; break; }
    }
    if (!item) return;
    const arr = r[toCol];
    arr.splice(toIdx == null ? arr.length : Math.max(0, Math.min(toIdx, arr.length)), 0, item);
    touch();
  }
  const focusCard = id => requestAnimationFrame(() => document.querySelector(`.card[data-id="${id}"]`)?.focus());

  function moveByKey(id, dCol, dIdx) {
    const col = colOf(id);
    const ci = COLS.findIndex(c => c.id === col);
    if (dCol) {
      const to = COLS[ci + dCol];
      if (!to) return;
      moveItem(id, to.id, null);
    } else {
      const arr = roadmap()[col];
      const j = arr.findIndex(x => x.id === id) + dIdx;
      if (j < 0 || j >= arr.length) return;
      moveItem(id, col, j);
    }
    focusCard(id);
  }

  let drag = null;
  let slot = null;
  function dropIndex(list, y) {
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i < 0 ? cards.length : i;
  }
  function placeSlot(list, idx) {
    slot = slot || el('div', { class: 'drop-slot' });
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    if (idx < cards.length) list.insertBefore(slot, cards[idx]); else list.append(slot);
  }
  function endDrag() {
    drag = null;
    slot?.remove();
    slot = null;
    document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
    document.querySelectorAll('.card.dragging').forEach(c => c.classList.remove('dragging'));
  }
  function wireDrop(col, list, colId) {
    col.addEventListener('dragover', e => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.col.over').forEach(c => { if (c !== col) c.classList.remove('over'); });
      col.classList.add('over');
      placeSlot(list, dropIndex(list, e.clientY));
    });
    col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) { col.classList.remove('over'); slot?.remove(); } });
    col.addEventListener('drop', e => {
      if (!drag) return;
      e.preventDefault();
      const idx = dropIndex(list, e.clientY);
      const id = drag.id;
      endDrag();
      moveItem(id, colId, idx);
    });
  }

  // ── rendering ───────────────────────────────────────────────────────────────────────
  const tagEl = it => (it.tag ? el('span', { class: 'tag', 'data-tone': it.tone }, it.tag) : null);

  function cardEl(it, colId) {
    const ci = COLS.findIndex(c => c.id === colId);
    const card = el('article', { class: 'card', 'data-id': it.id, role: 'listitem', tabindex: '0' },
      el('h3', { class: 'card__title' }, it.title),
      it.description && el('p', { class: 'card__desc' }, it.description),
      el('div', { class: 'card__foot' },
        tagEl(it),
        el('div', { class: 'card__actions' },
          ci > 0 && el('button', { class: 'btn btn--text btn--icon btn--sm', title: `Move to ${COLS[ci - 1].label}`, 'aria-label': `Move to ${COLS[ci - 1].label}`, html: icon('left'), onclick: () => moveByKey(it.id, -1, 0) }),
          ci < COLS.length - 1 && el('button', { class: 'btn btn--text btn--icon btn--sm', title: `Move to ${COLS[ci + 1].label}`, 'aria-label': `Move to ${COLS[ci + 1].label}`, html: icon('right'), onclick: () => moveByKey(it.id, 1, 0) }),
          el('button', { class: 'btn btn--text btn--icon btn--sm', title: 'Edit', 'aria-label': 'Edit', html: icon('pencil'), onclick: () => itemDialog(it, colId) }),
          el('button', { class: 'btn btn--text btn--icon btn--sm btn--del', title: 'Delete', 'aria-label': 'Delete', html: icon('trash'), onclick: () => deleteItem(it.id) }))));
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      drag = { id: it.id };
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', it.id); } catch {}
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', endDrag);
    card.addEventListener('keydown', e => {
      if (e.target !== card) return;
      if (e.altKey && e.key === 'ArrowUp')         { e.preventDefault(); moveByKey(it.id, 0, -1); }
      else if (e.altKey && e.key === 'ArrowDown')  { e.preventDefault(); moveByKey(it.id, 0, 1); }
      else if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); moveByKey(it.id, -1, 0); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); moveByKey(it.id, 1, 0); }
      else if (e.key === 'Enter')  { e.preventDefault(); itemDialog(it, colOf(it.id)); }
      else if (e.key === 'Delete') { e.preventDefault(); deleteItem(it.id); }
    });
    return card;
  }

  function renderSwitcher() {
    const box = $('#roadmaps');
    box.replaceChildren(...[
      ...roadmaps.map(r => {
        const tab = el('button', { class: 'rtab', 'data-id': r.id, 'aria-pressed': String(r.id === current), title: (r.share ? 'Public' : 'Private') + ' — drag to reorder, right-click for the colour',
          onclick: () => { if (Date.now() < suppressTabClickUntil) return; select(r.id); } },
          el('span', { class: 'rtab__vis', html: icon(r.share ? 'rocket' : 'lock') }), el('span', { class: 'rtab__name' }, r.name));
        tab.style.setProperty('--tab-color', colorOf(r));
        if (tabDrag && tabDrag.active && tabDrag.id === r.id) tab.classList.add('dragging-source');
        tab.addEventListener('contextmenu', e => { e.preventDefault(); openColorMenu(r, e.clientX, e.clientY); });
        tab.addEventListener('pointerdown', e => onTabPointerDown(e, r, tab));
        return tab;
      }),
      el('button', { class: 'rtab rtab--add', title: 'New roadmap', 'aria-label': 'New roadmap', html: icon('plus'), onclick: () => roadmapDialog(null) })
    ]);
    box.hidden = false;
    // keep the open roadmap's tab visible when the row scrolls sideways (phones)
    const active = box.querySelector('.rtab[aria-pressed="true"]');
    if (active && !(tabDrag && tabDrag.active)) {
      const b = box.getBoundingClientRect(), t = active.getBoundingClientRect();
      if (t.left < b.left) box.scrollLeft -= b.left - t.left + 8;
      else if (t.right > b.right) box.scrollLeft += t.right - b.right + 8;
    }
  }

  // ── tab colour menu ─────────────────────────────────────────────────────────────────
  let colorMenu = null;
  function closeColorMenu() {
    colorMenu?.remove();
    colorMenu = null;
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', closeColorMenu);
  }
  const onMenuOutside = e => { if (colorMenu && !colorMenu.contains(e.target)) closeColorMenu(); };
  const onMenuKey = e => { if (e.key === 'Escape') { e.stopPropagation(); closeColorMenu(); } };

  function setRoadmapColor(id, color) {
    const r = roadmaps.find(x => x.id === id);
    if (!r) return;
    if (color && HEX_COLOR.test(color)) r.color = color; else delete r.color;   // no colour = back to automatic
    touch();
  }

  function openColorMenu(r, x, y) {
    closeColorMenu();
    const current = colorOf(r).toLowerCase();
    const grid = el('div', { class: 'color-menu__grid' }, TAB_COLORS.map(c => {
      const sw = el('button', { type: 'button', class: 'color-menu__sw' + (c === current ? ' active' : ''), 'aria-label': 'Colour ' + c, onclick: () => { setRoadmapColor(r.id, c); closeColorMenu(); } });
      sw.style.background = c;
      return sw;
    }));
    const custom = el('input', { type: 'color', 'aria-label': 'Custom colour', value: current });
    custom.addEventListener('change', () => { setRoadmapColor(r.id, custom.value); closeColorMenu(); });
    const menu = el('div', { class: 'color-menu', role: 'dialog', 'aria-label': 'Roadmap colour' },
      el('div', { class: 'color-menu__title' }, 'Roadmap colour'), grid,
      el('div', { class: 'color-menu__row' },
        el('label', { class: 'color-menu__custom' }, 'Custom ', custom),
        el('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: () => { setRoadmapColor(r.id, null); closeColorMenu(); } }, 'Auto')));
    document.body.append(menu);
    colorMenu = menu;
    const b = menu.getBoundingClientRect();                       // keep it on screen
    menu.style.left = Math.max(8, Math.min(x, innerWidth - b.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - b.height - 8)) + 'px';
    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', closeColorMenu);
  }

  // ── tab drag to reorder (pointer based: mouse and touch; a long-press on touch opens the colour menu) ──
  let tabDrag = null;
  let suppressTabClickUntil = 0;

  function onTabPointerDown(e, r, tabEl) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tabDrag = { id: r.id, tabEl, startX: e.clientX, startY: e.clientY, active: false, insertIdx: null };
    if (e.pointerType === 'touch') {
      tabDrag.pressTimer = setTimeout(() => {
        if (!tabDrag || tabDrag.active) return;
        const { startX, startY } = tabDrag;
        endTabDrag();
        suppressTabClickUntil = Date.now() + 500;
        openColorMenu(r, startX, startY);
      }, 550);
    }
    document.addEventListener('pointermove', onTabPointerMove);
    document.addEventListener('pointerup', onTabPointerUp);
    document.addEventListener('pointercancel', onTabPointerUp);
  }

  function onTabPointerMove(e) {
    const d = tabDrag;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      clearTimeout(d.pressTimer);
      if (roadmaps.length < 2) { endTabDrag(); return; }
      d.active = true;
      const rect = d.tabEl.getBoundingClientRect();
      d.grabDX = d.startX - rect.left;
      d.ghost = d.tabEl.cloneNode(true);
      d.ghost.classList.add('rtab-ghost');
      d.ghost.style.width = rect.width + 'px';
      d.ghost.style.height = rect.height + 'px';
      document.body.append(d.ghost);
      d.marker = el('div', { class: 'rtab-marker' });
      document.body.append(d.marker);
      d.tabEl.classList.add('dragging-source');
      document.body.classList.add('tab-dragging');
    }
    e.preventDefault();
    const bar = $('#roadmaps').getBoundingClientRect();
    d.ghost.style.left = (e.clientX - d.grabDX) + 'px';
    d.ghost.style.top = bar.top + 'px';

    // where would it land? (index in the list without the dragged roadmap)
    const others = [...document.querySelectorAll('#roadmaps .rtab:not(.rtab--add)')].filter(t => t.dataset.id !== d.id);
    const inBar = e.clientY > bar.top - 50 && e.clientY < bar.bottom + 50;     // let go far away = cancel
    if (!inBar || !others.length) { d.insertIdx = inBar ? roadmaps.findIndex(x => x.id === d.id) : null; d.marker.style.display = 'none'; return; }
    let k = 0;
    while (k < others.length) { const rr = others[k].getBoundingClientRect(); if (e.clientX < rr.left + rr.width / 2) break; k++; }
    const rest = roadmaps.filter(x => x.id !== d.id);
    const ref = k < others.length ? others[k] : others[others.length - 1];
    const refIdx = rest.findIndex(x => x.id === ref.dataset.id);
    d.insertIdx = k < others.length ? refIdx : refIdx + 1;
    const rr = ref.getBoundingClientRect();
    d.marker.style.left = ((k < others.length ? rr.left : rr.right) - 4) + 'px';
    d.marker.style.top = rr.top + 'px';
    d.marker.style.height = rr.height + 'px';
    d.marker.style.display = 'block';
  }

  function endTabDrag() {
    const d = tabDrag;
    if (!d) return;
    clearTimeout(d.pressTimer);
    d.ghost?.remove();
    d.marker?.remove();
    document.body.classList.remove('tab-dragging');
    document.querySelectorAll('.rtab.dragging-source').forEach(t => t.classList.remove('dragging-source'));
    document.removeEventListener('pointermove', onTabPointerMove);
    document.removeEventListener('pointerup', onTabPointerUp);
    document.removeEventListener('pointercancel', onTabPointerUp);
    tabDrag = null;
  }

  function onTabPointerUp(e) {
    const d = tabDrag;
    if (!d) return;
    const commit = d.active && e.type === 'pointerup' && d.insertIdx != null;
    const { id, insertIdx, active } = d;
    endTabDrag();
    if (active) suppressTabClickUntil = Date.now() + 400;      // the drop must not also select the tab
    if (commit) reorderRoadmap(id, insertIdx);
  }

  function reorderRoadmap(id, toIndex) {
    const from = roadmaps.findIndex(r => r.id === id);
    if (from < 0) return;
    const [moved] = roadmaps.splice(from, 1);
    roadmaps.splice(Math.max(0, Math.min(toIndex, roadmaps.length)), 0, moved);
    if (roadmaps.findIndex(r => r.id === id) !== from) touch(); else renderAll();
  }

  function renderHero() {
    const r = roadmap();
    let host = '';
    try { host = r.url ? new URL(r.url).host : ''; } catch {}
    $('#hero').replaceChildren(
      el('div', { class: 'hero__row' },
        el('div', {}, el('h1', {}, r.name), r.tagline && el('p', { class: 'hero__tag' }, r.tagline)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn--outline', html: icon('pencil') + ' Edit', onclick: () => roadmapDialog(r) }),
          el('button', { class: 'btn btn--primary', html: icon('share') + ' Share', onclick: shareDialog }))),
      el('div', { class: 'hero__meta' },
        el('button', { class: 'chip chip--btn ' + (r.share ? 'chip--ok' : 'chip--muted'), title: r.share ? 'Public — click for the link and embed code' : 'Private — click to share', html: icon(r.share ? 'rocket' : 'lock') + (r.share ? ' Public' : ' Private'), onclick: shareDialog }),
        r.share && el('a', { href: publicUrl(r), target: '_blank', rel: 'noopener' }, 'Open public page'),
        r.url && el('a', { href: r.url, target: '_blank', rel: 'noopener' }, host),
        r.updatedAt && el('span', { title: new Date(r.updatedAt).toLocaleString() }, 'Updated ' + new Date(r.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))));
    document.title = `${r.name} · Roadmaps`;
  }

  function renderCols() {
    const r = roadmap();
    const root = $('#cols');
    root.replaceChildren();
    for (const c of COLS) {
      const items = r[c.id];
      const list = el('div', { class: 'col__list', role: 'list' });
      items.forEach(it => list.append(cardEl(it, c.id)));
      if (!items.length) list.append(el('div', { class: 'empty' }, 'Nothing here yet.', el('button', { class: 'btn btn--outline btn--sm', html: icon('plus') + ' Add feature', onclick: () => itemDialog(null, c.id) })));
      const col = el('section', { class: 'col', 'data-col': c.id },
        el('div', { class: 'col__head' },
          el('span', { class: 'col__dot' }), el('span', { class: 'col__title' }, c.label), el('span', { class: 'col__sub' }, c.sub), el('span', { class: 'col__count' }, String(items.length)),
          el('button', { class: 'btn btn--text btn--icon btn--sm col__add', title: `Add to ${c.label}`, 'aria-label': `Add to ${c.label}`, html: icon('plus'), onclick: () => itemDialog(null, c.id) })),
        list);
      wireDrop(col, list, c.id);
      root.append(col);
    }
  }

  function renderAll() {
    const has = roadmaps.length > 0;
    $('#welcome').hidden = has;
    $('#hero').hidden = !has;
    $('#cols').hidden = !has;
    if (!has) { renderSwitcher(); document.title = 'Roadmaps'; return; }
    renderSwitcher(); renderHero(); renderCols();
  }

  // ── gate (signed out / needs attention) ─────────────────────────────────────────────
  let gateKind = '';
  function showGate(msg, kind) {
    gateKind = kind || '';
    $('#gate').hidden = false;
    $('#app').hidden = true;
    $('#roadmaps').hidden = true;
    $('#user').hidden = true;
    $('#sync').hidden = true;
    $('#gate-msg').textContent = msg || '';
    const btn = $('#gate-btn');
    btn.disabled = gateKind === 'disabled';
    $('#gate-btn-label').textContent = gateKind === 'retry' ? 'Try again' : 'Continue with Google';
    $('#gate-switch').hidden = !(RMSync.user() && RMSync.user().email) || gateKind === 'disabled' || gateKind === 'retry';
    document.title = 'Sign in · Roadmaps';
  }

  $('#gate-btn').addEventListener('click', async () => {
    if (gateKind === 'retry') { $('#gate-msg').textContent = 'Trying again…'; await RMSync.retryBoot(); return; }
    $('#gate-msg').textContent = 'Opening Google sign-in…';
    RMSync.signIn(false);
  });
  $('#gate-switch').addEventListener('click', () => RMSync.signIn(true));

  function showApp(user) {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#user').hidden = false;
    if (user) {
      $('#user-name').textContent = user.given_name || user.name || 'You';
      $('#user-email').textContent = user.email || '';
      const img = $('#user-avatar');
      if (user.picture) { img.src = user.picture; img.hidden = false; } else img.hidden = true;
    }
    renderAll();
  }

  // ── user menu, sync status, theme ───────────────────────────────────────────────────
  // one menu, two buttons: the avatar on wide screens, the ⋮ button on phones (where everything but the tabs lives in it)
  const menu = $('#user-menu');
  const menuBtns = [$('#user-btn'), $('#more-btn')];
  const setMenu = open => { menu.hidden = !open; menuBtns.forEach(b => b.setAttribute('aria-expanded', String(open))); };
  menuBtns.forEach(b => b.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); }));
  document.addEventListener('click', e => { if (!e.target.closest('#user')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

  $('#btn-signout').addEventListener('click', async () => {
    setMenu(false);
    if (await RMSync.signOut()) { roadmaps = []; current = ''; showGate('You are signed out.'); }
  });

  function setStatus(state, label) {
    const s = $('#sync');
    s.hidden = false;
    s.className = 'chip ' + (state === 'synced' ? 'chip--ok' : state === 'syncing' ? 'chip--info' : state === 'error' ? 'chip--danger' : 'chip--muted');
    s.textContent = label;
    const m = $('#sync-m');
    m.className = s.className;
    m.textContent = label;
    $('#more-btn').dataset.sync = state;   // a dot on the ⋮ button when something needs attention
  }

  // ── backup ──────────────────────────────────────────────────────────────────────────
  $('#btn-export').addEventListener('click', () => {
    setMenu(false);
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'roadmaps', version: 1, current, roadmaps }, null, 2) + '\n'], { type: 'application/json' }));
    const a = el('a', { href: url, download: `roadmaps-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded');
  });
  $('#btn-import').addEventListener('click', () => { setMenu(false); $('#file').click(); });
  $('#file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 2e6) throw new Error('too large');
      const parsed = JSON.parse(await f.text());
      // a backup ({roadmaps:[…]}) or the older roadmap.json shape used on product pages ({products:[…]})
      const source = parsed && (Array.isArray(parsed.roadmaps) ? parsed.roadmaps : parsed.products);
      const list = (Array.isArray(source) ? source : []).map(normalizeRoadmap).filter(Boolean);
      if (!list.length) throw new Error('no roadmaps');
      const keep = new Map(roadmaps.map(r => [r.id, r]));
      list.forEach(r => { const old = keep.get(r.id); if (old && old.share) r.share = old.share; else delete r.share; });   // a backup never carries someone else's public link
      const kept = new Set(list.filter(r => r.share).map(r => r.share.fileId));
      const orphaned = roadmaps.filter(r => r.share && !kept.has(r.share.fileId));
      if (!await confirmDialog({ title: 'Replace your roadmaps?', message: `Everything here is replaced by the ${list.length} roadmap(s) in “${f.name}”.` + (orphaned.length ? ` ${orphaned.length} public roadmap(s) not in the file will stop being shared.` : ''), confirm: 'Replace', danger: true })) return;
      orphaned.forEach(r => RMSync.share.queueRevoke(r.share.fileId));
      roadmaps = list;
      current = list.some(r => r.id === parsed.current) ? parsed.current : list[0].id;
      touch();
      RMSync.share.publish();
      toast(`Imported ${list.length} roadmap(s)`);
    } catch { toast('That file isn’t a valid Roadmaps backup', 'warn'); }
  });

  $('#btn-first').addEventListener('click', () => roadmapDialog(null));

  // ── start ───────────────────────────────────────────────────────────────────────────
  RMSync.init({
    getData: () => ({ roadmaps, current }),
    applyData,
    onStatus: setStatus,
    onGate: showGate,
    onSignedIn: showApp,
    confirmConflict: conflictDialog,
    toast
  });
  RMSync.start();
})();
