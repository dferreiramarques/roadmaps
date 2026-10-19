'use strict';
// Admin editor. Everything is saved to the server as you type (debounced); the server keeps a numbered
// revision of every change, and refuses to overwrite a newer version (409) so two tabs can't clobber each other.
(() => {
  const COLS = [
    { id: 'now',   label: 'Now',   sub: 'Working on' },
    { id: 'next',  label: 'Next',  sub: 'Up next' },
    { id: 'later', label: 'Later', sub: 'On the horizon' }
  ];
  const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
  const TONE_LABEL = { success: 'Success', info: 'Info', warn: 'Warning', danger: 'Danger', secondary: 'Neutral', contrast: 'Contrast' };
  const SAVE_DELAY = 600;
  const LS_CUR = 'roadmaps-admin-current';

  const $ = s => document.querySelector(s);
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const uid = () => Math.random().toString(36).slice(2, 9);

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
    clock:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ext:    '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'
  };
  const icon = name => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

  // ── API ─────────────────────────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    if (r.status !== 204) { try { data = await r.json(); } catch {} }
    if (!r.ok) {
      const e = new Error((data && data.message) || r.statusText || 'Request failed');
      e.status = r.status; e.data = data;
      throw e;
    }
    return data;
  }

  // ── state ───────────────────────────────────────────────────────────────────────────
  let products = [];       // full products from the server (+ local edits)
  let current = '';
  let saveState = 'saved'; // saved | saving | unsaved | error
  let saveError = '';
  let saveTimer = null;
  let saving = false;
  let again = false;

  const product = () => products.find(p => p.id === current) || products[0];
  const editable = p => ({ name: p.name, tagline: p.tagline, url: p.url, visibility: p.visibility, now: p.now, next: p.next, later: p.later, rev: p.rev });

  function setStatus(s, err) { saveState = s; saveError = err || ''; renderHero(); }

  function touch(p = product()) {
    p._dirty = true;
    setStatus('unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAll, SAVE_DELAY);
    renderAll();
  }

  async function saveAll() {
    clearTimeout(saveTimer);
    if (saving) { again = true; return; }
    saving = true;
    setStatus('saving');
    try {
      for (const p of products.filter(x => x._dirty)) {
        p._dirty = false;
        try {
          const saved = await api('PUT', `/api/products/${p.id}`, editable(p));
          p.rev = saved.rev; p.updatedAt = saved.updatedAt;
        } catch (e) {
          p._dirty = true;
          if (e.status === 409) { await resolveConflict(p, e.data && e.data.current); }
          else throw e;
        }
      }
      setStatus(products.some(x => x._dirty) || again ? 'unsaved' : 'saved');
    } catch (e) {
      if (e.status === 401) { showLogin('Your session ended. Sign in again to keep editing.'); }
      else setStatus('error', e.message);
    } finally {
      saving = false;
      if (again) { again = false; saveTimer = setTimeout(saveAll, 0); }
    }
  }

  window.addEventListener('beforeunload', e => { if (products.some(p => p._dirty) || saving) { e.preventDefault(); e.returnValue = ''; } });

  function resolveConflict(p, theirs) {
    return new Promise(resolve => {
      const d = openDialog({
        title: 'Changed somewhere else',
        body: el('p', { class: 'dialog__msg' }, `“${p.name}” was changed in another tab or device since you opened it. You can load that version (your latest edits here are lost), or keep yours and overwrite it.`),
        foot: [
          el('button', { class: 'btn btn--outline', onclick: () => { Object.assign(p, theirs, { _dirty: false }); d.close(); renderAll(); resolve(); } }, 'Load their version'),
          el('button', { class: 'btn btn--primary', onclick: () => { p.rev = theirs.rev; p._dirty = true; d.close(); resolve(); again = true; } }, 'Keep mine')
        ],
        onClose: () => resolve()
      });
    });
  }

  // ── toast ───────────────────────────────────────────────────────────────────────────
  function toast(msg, tone) {
    const t = el('div', { class: 'toast' + (tone === 'warn' ? ' toast--warn' : ''), html: icon(tone === 'warn' ? 'x' : 'check') }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ── dialog ──────────────────────────────────────────────────────────────────────────
  function openDialog({ title, body, foot, onClose }) {
    const prev = document.activeElement;
    const overlay = el('div', { class: 'overlay', role: 'presentation' });
    const dlg = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
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
    return { close, dlg };
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

  // ── product dialog ──────────────────────────────────────────────────────────────────
  function productDialog(p) {
    const isNew = !p;
    const name = el('input', { class: 'input', maxlength: 40, placeholder: 'Product name', value: p?.name || '' });
    const tagline = el('input', { class: 'input', maxlength: 140, placeholder: 'One line about the product', value: p?.tagline || '' });
    const url = el('input', { class: 'input', maxlength: 200, placeholder: 'https://', value: p?.url || '', inputmode: 'url' });
    const vis = el('select', { class: 'select' },
      el('option', { value: 'public' }, 'Public — on the site and in embeds'),
      el('option', { value: 'private' }, 'Private — only you, in this editor'));
    vis.value = p?.visibility || 'public';

    const save = async () => {
      if (!str(name.value, 40)) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
      try {
        if (isNew) {
          const created = await api('POST', '/api/products', { name: name.value, tagline: tagline.value, url: url.value, visibility: vis.value });
          products.push(created);
          select(created.id, true);
        } else {
          Object.assign(p, { name: str(name.value, 40), tagline: str(tagline.value, 140), url: url.value.trim(), visibility: vis.value });
          touch(p);
        }
        d.close();
        renderAll();
      } catch (e) { toast(e.message, 'warn'); }
    };
    const foot = [
      !isNew && products.length > 1 && el('button', { class: 'btn btn--text btn--danger-text btn--del-left', onclick: async () => {
        if (!await confirmDialog({ title: `Delete “${p.name}”?`, message: 'The product and its roadmap are removed. A copy is kept on the server in case of a mistake.', confirm: 'Delete', danger: true })) return;
        try {
          await api('DELETE', `/api/products/${p.id}`);
          products = products.filter(x => x.id !== p.id);
          d.close();
          select(products[0].id, true);
          renderAll();
        } catch (e) { toast(e.message, 'warn'); }
      } }, 'Delete product'),
      el('button', { class: 'btn btn--text', onclick: () => d.close() }, 'Cancel'),
      el('button', { class: 'btn btn--primary', onclick: save }, isNew ? 'Add product' : 'Save')
    ];
    const d = openDialog({
      title: isNew ? 'Add product' : 'Edit product',
      body: [field('Name', name), field('Tagline', tagline), field('Website', url, 'Shown as a link under the title.'), field('Visibility', vis)],
      foot
    });
    [name, tagline, url].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
  }

  // ── history ─────────────────────────────────────────────────────────────────────────
  async function historyDialog() {
    const p = product();
    let revs;
    try { revs = await api('GET', `/api/products/${p.id}/revisions`); } catch (e) { toast(e.message, 'warn'); return; }
    const list = el('div', { class: 'revs' }, revs.length ? revs.map(r => el('div', { class: 'rev' },
      el('div', { class: 'rev__main' },
        el('div', { class: 'rev__title' }, `Revision ${r.rev}${r.rev === p.rev ? ' (current)' : ''}`),
        el('div', { class: 'rev__meta' }, `${new Date(r.updatedAt).toLocaleString()} · ${r.now} now · ${r.next} next · ${r.later} later`)),
      r.rev !== p.rev && el('button', { class: 'btn btn--outline btn--sm', onclick: async () => {
        if (!await confirmDialog({ title: `Restore revision ${r.rev}?`, message: 'It becomes a new revision. The current version stays in the history.', confirm: 'Restore' })) return;
        try {
          if (p._dirty) await saveAll();
          Object.assign(p, await api('POST', `/api/products/${p.id}/restore`, { revision: r.rev, rev: p.rev }), { _dirty: false });
          d.close();
          renderAll();
          toast(`Restored revision ${r.rev}`);
        } catch (e) { toast(e.message, 'warn'); }
      } }, 'Restore'))) : el('p', { class: 'dialog__msg' }, 'No history yet.'));
    const d = openDialog({ title: `History — ${p.name}`, body: list, foot: [el('button', { class: 'btn btn--primary', onclick: () => d.close() }, 'Close')] });
  }

  // ── feature dialog ──────────────────────────────────────────────────────────────────
  function colOf(id) { const p = product(); return COLS.find(c => p[c.id].some(x => x.id === id))?.id; }

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

    const save = () => {
      const t = str(title.value, 80);
      if (!t) { title.setAttribute('aria-invalid', 'true'); title.focus(); return; }
      const fields = { title: t, description: str(desc.value, 280), tag: str(tag.value, 20), tone: draft.tone };
      const p = product();
      if (isNew) {
        p[draft.col].push({ id: uid(), ...fields });
      } else if (draft.col === colId) {
        Object.assign(item, fields);
      } else {
        p[colId] = p[colId].filter(x => x.id !== item.id);
        Object.assign(item, fields);
        p[draft.col].push(item);
      }
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
        field('Title', title),
        field('Description', desc),
        el('div', { class: 'row2' }, field('Tag', tag, 'A short label on the card.'), el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Column'), colSeg)),
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tag colour'), tones)
      ],
      foot
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  }

  async function deleteItem(id) {
    const p = product();
    const col = colOf(id);
    const it = col && p[col].find(x => x.id === id);
    if (!it) return;
    if (!await confirmDialog({ title: 'Delete this feature?', message: `“${it.title}” will be removed from the ${COLS.find(c => c.id === col).label.toLowerCase()} list. You can bring it back from the history.`, confirm: 'Delete', danger: true })) return;
    p[col] = p[col].filter(x => x.id !== id);
    touch();
  }

  // ── moving ──────────────────────────────────────────────────────────────────────────
  function moveItem(id, toCol, toIdx) {
    const p = product();
    let item = null;
    for (const c of COLS) {
      const i = p[c.id].findIndex(x => x.id === id);
      if (i >= 0) { item = p[c.id].splice(i, 1)[0]; break; }
    }
    if (!item) return;
    const arr = p[toCol];
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
      const arr = product()[col];
      const i = arr.findIndex(x => x.id === id);
      const j = i + dIdx;
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
    col.addEventListener('dragleave', e => {
      if (col.contains(e.relatedTarget)) return;
      col.classList.remove('over');
      slot?.remove();
    });
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

  function renderProducts() {
    const box = $('#products');
    box.replaceChildren(...[
      ...products.map(p => el('button', { class: 'seg__btn', 'aria-pressed': String(p.id === current), onclick: () => select(p.id) }, p.name)),
      el('button', { class: 'seg__btn seg__add', title: 'Add product', 'aria-label': 'Add product', html: icon('plus'), onclick: () => productDialog(null) })
    ]);
    box.hidden = false;
  }

  const STATUS = {
    saved:   ['chip chip--ok', 'Saved'],
    saving:  ['chip chip--info', 'Saving…'],
    unsaved: ['chip', 'Unsaved changes'],
    error:   ['chip chip--danger', 'Couldn’t save']
  };

  function renderHero() {
    const p = product();
    if (!p) return;
    const [cls, label] = STATUS[saveState];
    let host = '';
    try { host = p.url ? new URL(p.url).host : ''; } catch {}
    $('#hero').replaceChildren(
      el('div', { class: 'hero__row' },
        el('div', {}, el('h1', {}, p.name), p.tagline && el('p', { class: 'hero__tag' }, p.tagline)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn--outline', html: icon('clock') + ' History', onclick: historyDialog }),
          el('button', { class: 'btn btn--outline', html: icon('pencil') + ' Edit product', onclick: () => productDialog(p) }))),
      el('div', { class: 'hero__meta' },
        el('span', { class: p.visibility === 'public' ? 'chip chip--ok' : 'chip chip--muted' }, p.visibility === 'public' ? 'Public' : 'Private'),
        el('span', { class: cls, title: saveError }, label),
        p.visibility === 'public' && el('a', { href: `/p/${encodeURIComponent(p.id)}`, target: '_blank', rel: 'noopener', html: icon('ext') + ' Public page' }),
        p.url && el('a', { href: p.url, target: '_blank', rel: 'noopener' }, host),
        el('span', {}, 'Revision ' + p.rev))
    );
    document.title = `${p.name} · Roadmaps admin`;
  }

  function renderCols() {
    const p = product();
    const root = $('#cols');
    root.replaceChildren();
    for (const c of COLS) {
      const items = p[c.id];
      const list = el('div', { class: 'col__list', role: 'list' });
      items.forEach(it => list.append(cardEl(it, c.id)));
      if (!items.length) {
        list.append(el('div', { class: 'empty' }, 'Nothing here yet.',
          el('button', { class: 'btn btn--outline btn--sm', html: icon('plus') + ' Add feature', onclick: () => itemDialog(null, c.id) })));
      }
      const col = el('section', { class: 'col', 'data-col': c.id },
        el('div', { class: 'col__head' },
          el('span', { class: 'col__dot' }),
          el('span', { class: 'col__title' }, c.label),
          el('span', { class: 'col__sub' }, c.sub),
          el('span', { class: 'col__count' }, String(items.length)),
          el('button', { class: 'btn btn--text btn--icon btn--sm col__add', title: `Add to ${c.label}`, 'aria-label': `Add to ${c.label}`, html: icon('plus'), onclick: () => itemDialog(null, c.id) })),
        list);
      wireDrop(col, list, c.id);
      root.append(col);
    }
  }

  function renderAll() { renderProducts(); renderHero(); renderCols(); }

  function select(id, silent) {
    if (!products.some(p => p.id === id)) id = products[0]?.id;
    current = id;
    try { localStorage.setItem(LS_CUR, id); } catch {}
    if (!silent) renderAll();
  }

  // ── sign in / out ───────────────────────────────────────────────────────────────────
  function show(which) {
    $('#login').hidden = which !== 'login';
    $('#app').hidden = which !== 'app';
    $('#actions').hidden = which !== 'app';
    $('#products').hidden = which !== 'app';
  }

  function showLogin(msg, disabled) {
    show('login');
    $('#login-msg').textContent = msg || 'Enter the admin token to edit the roadmaps.';
    $('#login-form').querySelectorAll('input, button').forEach(e => { e.disabled = !!disabled; });
    $('#login-err').textContent = '';
    if (!disabled) $('#token').focus();
  }

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#login-err').textContent = '';
    $('#login-btn').disabled = true;
    try {
      await api('POST', '/api/login', { token: $('#token').value });
      $('#token').value = '';
      await start();
    } catch (err) {
      $('#login-err').textContent = err.message;
    } finally { $('#login-btn').disabled = false; }
  });

  $('#btn-signout').addEventListener('click', async () => {
    if (products.some(p => p._dirty)) await saveAll();
    try { await api('POST', '/api/logout', {}); } catch {}
    products = [];
    showLogin('You are signed out.');
  });

  // ── export / import ─────────────────────────────────────────────────────────────────
  $('#btn-export').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/export', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await r.blob());
      const a = el('a', { href: url, download: 'roadmaps.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('roadmaps.json downloaded');
    } catch (e) { toast(e.message, 'warn'); }
  });
  $('#btn-import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 500000) throw new Error('That file is too big.');
      const parsed = JSON.parse(await f.text());
      if (!Array.isArray(parsed?.products)) throw new Error('That file has no products.');
      if (!await confirmDialog({ title: 'Import products?', message: `${parsed.products.length} product(s) from “${f.name}” are added. Products with the same id are replaced; the old versions stay in their history.`, confirm: 'Import' })) return;
      if (products.some(p => p._dirty)) await saveAll();
      const r = await api('POST', '/api/import', parsed);
      await load();
      toast(`Imported ${r.imported} product(s)`);
    } catch (err) { toast(err.message || 'That isn’t a valid roadmaps.json', 'warn'); }
  });

  // ── start ───────────────────────────────────────────────────────────────────────────
  async function load() {
    products = await api('GET', '/api/products?full=1');
    if (!products.length) products = [await api('POST', '/api/products', { name: 'My product' })];
    let start = '';
    try { start = localStorage.getItem(LS_CUR) || ''; } catch {}
    select(products.some(p => p.id === start) ? start : products[0].id, true);
    renderAll();
  }

  async function start() {
    const me = await api('GET', '/api/me');
    if (!me.editingEnabled) return showLogin('Editing is switched off: set ADMIN_TOKEN on the server and redeploy.', true);
    if (!me.admin) return showLogin();
    show('app');
    await load();
  }

  start().catch(e => showLogin('Couldn’t reach the server: ' + e.message, true));
})();
