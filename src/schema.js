'use strict';
// The shape of a roadmap, and the cleaning applied to everything read from outside (public Drive files).
// Nothing is trusted: strings are trimmed and capped, enums are checked, URLs must be http(s).

const COLUMNS = ['now', 'next', 'later'];
const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
const LIMITS = { name: 40, tagline: 140, url: 200, title: 80, description: 280, tag: 20, itemsPerColumn: 100 };

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanUrl = v => { v = String(v || '').trim(); return /^https?:\/\/[^\s]+$/i.test(v) ? v.slice(0, LIMITS.url) : ''; };

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, LIMITS.title);
  if (!title) return null;
  return {
    title,
    description: str(raw.description, LIMITS.description),
    tag: str(raw.tag, LIMITS.tag),
    tone: TONES.includes(raw.tone) ? raw.tone : 'secondary'
  };
}

// The published copy of a roadmap (the file a user makes public in their Drive).
// Returns null when the file is not one of ours.
function cleanPublic(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'roadmaps-public') return null;
  const name = str(raw.name, LIMITS.name);
  if (!name) return null;
  const out = { name, tagline: str(raw.tagline, LIMITS.tagline), url: cleanUrl(raw.url) };
  for (const col of COLUMNS) {
    out[col] = (Array.isArray(raw[col]) ? raw[col] : []).slice(0, LIMITS.itemsPerColumn).map(cleanItem).filter(Boolean);
  }
  return out;
}

module.exports = { COLUMNS, TONES, LIMITS, str, cleanUrl, cleanItem, cleanPublic };
