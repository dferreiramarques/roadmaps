# Roadmaps — product notes and hand-off

Written on 2026-10-19 at the end of the session that built the first version, so a new working session can start with full context.

## 1. What and why

David has several small products (Taskboards, Diagramico, others to come) and wants **one place to define each product's roadmap** and **show it on each product's own page** ("what we're building now, next and later"). The roadmap is also a way to collect interest before building (waitlists), so it should look careful and credible.

It started as a page inside Taskboards (`roadmap.html`, an editor that exported `roadmap.json`). That editor moved into **this app**, hosted on Railway, so editing is no longer tied to one product's repo. Taskboards keeps `roadmap.html` as a **read-only** viewer and the widget (`roadmap-embed.js`), and will read its data from here.

## 2. Decisions already taken

- **Columns:** Now / Next / Later, vertical lists, one set per product. Items: title, description, a coloured tag (free text + one of 6 tones: success, info, warn, danger, secondary, contrast).
- **Look:** PrimeNG **Aura**-inspired — zinc surfaces, emerald primary, 6 px controls / 12 px panels, tinted tags, soft focus rings. Dark and light themes that only swap colours (David's rule, see `CLAUDE.md`).
- **Data is public by design**; per-product `visibility` (public/private). Only the owner edits.
- **Hosting:** Railway, one service, a **Volume** at `/data`. Prefer a **same-site custom domain** (e.g. `roadmap.monco.io` — David's products live under `monco.io`) so any future cookies are first-party.
- **Storage:** one JSON file per product + a numbered revision per change (no database yet) — chosen for zero setup, easy backups and "no data we shouldn't hold". Public data only.
- **Auth (MVP):** one `ADMIN_TOKEN` → signed httpOnly cookie. Same-origin JSON only for writes. Good enough for a single owner; replace with Google sign-in when more editors are needed (the rest of the code only relies on `isAdmin(req)` / `requireAdmin`).
- **Embed:** `embed.js` — shadow-root widget, text-only rendering, follows the host page's theme, works on pages with strict CSP.
- **David's working style:** Portuguese conversation, concise answers, commit/push only when asked, tests + a real-browser check for UI work.

## 3. What exists now (v0.1.0, local — not deployed yet)

- Admin editor (`/admin`): sign in, products as tabs, add/edit/delete features and products, drag & drop + ‹ › buttons + Alt+arrows, autosave with status chip, **History** (restore), **conflict dialog** (409) when another tab changed the product, Export / Import, visibility toggle, link to the public page.
- Public: directory `/`, product page `/p/<id>`, `GET /api/roadmap.json`, `embed.js`.
- Storage with revisions, trash, atomic writes; validation/sanitising of everything that comes in.
- 13 automated API tests, all passing (`npm test`). The admin UI was smoke-tested in a browser (login, CRUD, autosave, visibility, history/restore, conflicts, public pages, sign-out).
- `seed/roadmap.json`: example data for Taskboards and Diagramico (copied from Taskboards' `roadmap.json`; the Taskboards items were written during the session from the pricing/plans discussion — **David should review/replace them**; Diagramico's come from its own public roadmap, EN).
- Not done: deployment, domain, product ordering UI (API `PUT /api/order` exists), item drag between products, any analytics.

## 4. Connect the other apps (the first jobs after deploying)

1. **Taskboards** (`D:\Documents\GitHub\taskboards`, repo `dferreiramarques/taskboards`, site `taskboards.monco.io` on GitHub Pages, Railway service for the session server at `auth.monco.io`):
   - `roadmap.html` + `roadmap.js` are the read-only viewer; `roadmap-embed.js` is the widget used on the landing page (`<div data-roadmap="taskboards">`).
   - They read `ROADMAP_SRC` from `config.js` (default: the local `roadmap.json`). After deploying here set `ROADMAP_SRC: 'https://<roadmaps-host>/api/roadmap.json'`, push, then retire `roadmap.json` there (or keep it as a fallback).
   - Cross-origin is fine: `/api/roadmap.json` sends `Access-Control-Allow-Origin: *`.
2. **Diagramico** (`D:\Documents\GitHub\diagramico`): its landing page has the roadmap hard-coded (`ROAD` in `index.html`, PT + EN) and `docs/ROADMAP.md` as the long version. Replace the hard-coded block with `<div data-roadmap="diagramico" data-header="false">` + the script. It is bilingual — see open question about languages.
3. Any other app: same two lines of HTML.

## 5. Open questions for David

1. **Name** of the product (working name "Roadmaps") and the **domain** (`roadmap.monco.io`?).
2. **Auth:** keep the single token, or move to Google sign-in with an allowed-email list now? (Taskboards already has a Google OAuth client and a session server at `auth.monco.io` to copy the pattern from.)
3. **Languages:** Diagramico is PT/EN. Should items carry translations (`title: {pt, en}`) and the widget pick by `lang`?
4. **Item model:** add status/ETA, a link ("read more"), votes or "I want this" (feeds the waitlist idea)? A fourth **"Shipped"/changelog** column or a separate changelog?
5. **Storage:** files on a Volume are fine for now. Move to Postgres only if we need multi-user, queries, or per-user audit.
6. **Visitors:** subscribe-for-updates, voting, comments — worth it? (They would make the app hold personal data → privacy notice, GDPR.)
7. **Per-product settings:** custom accent colour, hide the "Last updated" line, API keys for private roadmaps?

## 6. Suggested plan

- **Phase 1 — ship it:** deploy to Railway (Volume + variables + domain) → import/confirm the data → point Taskboards (`ROADMAP_SRC`) and Diagramico (widget) at it → retire the old copies.
- **Phase 2 — editors:** Google sign-in with allowed emails, "last edited by" in history, product ordering by drag, product duplication.
- **Phase 3 — richer roadmaps:** item status/dates/links, Shipped column or changelog, PT/EN translations, per-product theme colour, RSS/Atom feed of changes.
- **Phase 4 — audience:** opt-in subscribe, voting, simple analytics (which items get attention) — each with its privacy implications settled first.
- **Phase 5 — scale:** Postgres, roles, API keys, webhooks.

## 7. Start a new working session

Open this repository in Claude Code and paste:

> You're continuing the **Roadmaps** app (see `CLAUDE.md` and `docs/NOTES.md`). Version 0.1.0 exists locally with 13 passing tests and has not been deployed or committed to GitHub yet. First: (1) run `npm test`, `git status` and check what's already pushed; (2) help me deploy it on Railway — Volume at `/data`, the three variables, a custom domain — and walk me through each step; (3) then connect Taskboards (`ROADMAP_SRC`) and Diagramico (widget). I'll answer the open questions in section 5 as we go; for anything that changes the design, ask me one short question first. Reply in Portuguese, concisely, and don't commit or push until I say so.

## 8. Useful references

- Taskboards: `roadmap.html`, `roadmap.js`, `roadmap-embed.js`, `config.js` (`ROADMAP_SRC`), session-server pattern in `auth.js`, deployment notes in its `README.md`. The first version of the editor (localStorage + `roadmap.json` export) is in its git history at commit `bfe2402`.
- Diagramico: `index.html` (`PLANS`, `ROAD`, waitlist form → Formspree), `docs/ROADMAP.md`.
- Design reference: PrimeNG Aura (tokens are in `public/app.css`).
