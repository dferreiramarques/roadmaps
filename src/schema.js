'use strict';
// The shape of a product and its roadmap, and the cleaning applied to everything that comes in.
// Nothing user-written is ever trusted: strings are trimmed and capped, enums are checked, URLs must be http(s).

const COLUMNS = ['now', 'next', 'later'];
const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
const VISIBILITY = ['public', 'private'];

const LIMITS = { name: 40, tagline: 140, url: 200, title: 80, description: 280, tag: 20, itemsPerColumn: 100, products: 100 };

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'product';
const cleanUrl = v => { v = String(v || '').trim(); return /^https?:\/\/[^\s]+$/i.test(v) ? v.slice(0, LIMITS.url) : ''; };
const newId = () => Math.random().toString(36).slice(2, 9);

function cleanItem(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, LIMITS.title);
  if (!title) return null;
  let id = str(raw.id, 24).replace(/[^\w-]/g, '') || newId();
  while (seen.has(id)) id = newId();
  seen.add(id);
  return {
    id,
    title,
    description: str(raw.description, LIMITS.description),
    tag: str(raw.tag, LIMITS.tag),
    tone: TONES.includes(raw.tone) ? raw.tone : 'secondary'
  };
}

// Returns the editable part of a product (no id/rev/timestamps — the store owns those).
// Throws a ValidationError when the input can't be a product at all.
function cleanProduct(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Expected an object');
  const name = str(raw.name, LIMITS.name);
  if (!name) throw new ValidationError('A product needs a name');
  const seen = new Set();
  const out = {
    name,
    tagline: str(raw.tagline, LIMITS.tagline),
    url: cleanUrl(raw.url),
    visibility: VISIBILITY.includes(raw.visibility) ? raw.visibility : 'public'
  };
  for (const col of COLUMNS) {
    const list = Array.isArray(raw[col]) ? raw[col] : [];
    out[col] = list.slice(0, LIMITS.itemsPerColumn).map(it => cleanItem(it, seen)).filter(Boolean);
  }
  return out;
}

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

// The public view of a product: what visitors, the embed widget and the viewer page get.
const publicProduct = p => ({
  id: p.id, name: p.name, tagline: p.tagline, url: p.url,
  now: p.now, next: p.next, later: p.later
});

module.exports = { COLUMNS, TONES, VISIBILITY, LIMITS, str, slug, cleanUrl, newId, cleanProduct, publicProduct, ValidationError };
