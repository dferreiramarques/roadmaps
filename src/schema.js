'use strict';
// The shape of a roadmap, and the cleaning applied to everything read from outside (public Drive files).
// Nothing is trusted: strings are trimmed and capped, enums are checked, URLs must be http(s).

const COLUMNS = ['now', 'next', 'later'];
const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
const LIMITS = { name: 40, tagline: 140, url: 200, title: 80, description: 280, tag: 20, when: 12, itemsPerColumn: 100, releases: 20, entriesPerVersion: 100 };

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanUrl = v => { v = String(v || '').trim(); return /^https?:\/\/[^\s]+$/i.test(v) ? v.slice(0, LIMITS.url) : ''; };

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const cleanVersion = v => { v = String(v == null ? '' : v).trim(); return VERSION.test(v) ? v : ''; };
const cleanLang = v => { v = String(v == null ? '' : v).trim(); return LANG.test(v) ? v : 'en'; };
const cleanTime = v => { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 && v < 4102444800000 ? v : 0; };   // before 2100

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, LIMITS.title);
  if (!title) return null;
  return {
    title,
    description: str(raw.description, LIMITS.description),
    tag: str(raw.tag, LIMITS.tag),
    tone: TONES.includes(raw.tone) ? raw.tone : 'secondary',
    when: str(raw.when, LIMITS.when)
  };
}

// an entry of the shipped changelog: a feature plus the day it shipped
const cleanShipped = raw => { const it = cleanItem(raw); return it && { ...it, shippedAt: cleanTime(raw.shippedAt) }; };
const cleanShippedList = raw => (Array.isArray(raw) ? raw : []).slice(0, LIMITS.entriesPerVersion).map(cleanShipped).filter(Boolean);

// The published copy of a roadmap (the file a user makes public in their Drive).
// Returns null when the file is not one of ours.
function cleanPublic(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'roadmaps-public') return null;
  const name = str(raw.name, LIMITS.name);
  if (!name) return null;
  const out = { name, tagline: str(raw.tagline, LIMITS.tagline), url: cleanUrl(raw.url), lang: cleanLang(raw.lang), version: cleanVersion(raw.version), shipped: cleanShippedList(raw.shipped) };
  for (const col of COLUMNS) {
    out[col] = (Array.isArray(raw[col]) ? raw[col] : []).slice(0, LIMITS.itemsPerColumn).map(cleanItem).filter(Boolean);
  }
  out.releases = (Array.isArray(raw.releases) ? raw.releases : []).slice(0, LIMITS.releases)
    .map(v => v && cleanVersion(v.version) ? { version: cleanVersion(v.version), closedAt: cleanTime(v.closedAt), items: cleanShippedList(v.items) } : null)
    .filter(Boolean);
  return out;
}

module.exports = { COLUMNS, TONES, LIMITS, VERSION, str, cleanUrl, cleanItem, cleanVersion, cleanLang, cleanPublic };
