# CLAUDE.md — Roadmaps

Instructions for Claude Code when working in this repository. Read `docs/NOTES.md` first for the product context.

## What this is
A small hosted app (Node + Express, vanilla JS, **no build step**) that holds the **Now / Next / Later roadmap of several products**:
an admin editor, public pages, and an embeddable widget other sites use to show a product's roadmap.
It runs on **Railway** with a **Volume** for the data (JSON files). The owner is David (talks in Portuguese; the UI and code are in English).

## Commands
```bash
npm install
npm test                      # must stay green — 13 API/auth/validation/revision/import tests (node:test)
node --env-file=.env server.js   # run locally (set ADMIN_TOKEN in .env)
node scripts/seed.js [file]   # import a roadmaps.json into DATA_DIR
```

## Layout
- `server.js` wiring · `src/api.js` routes · `src/auth.js` admin session · `src/store.js` file storage + revisions · `src/schema.js` validation/cleaning
- `public/` — `index.html` (directory), `p.html` (+ `js/viewer.js`: public page = the widget in header mode), `admin.html` + `js/admin.js` (editor), `embed.js` (widget), `app.css` (design tokens + components), `js/theme.js`
- `test/api.test.js` · `seed/roadmap.json` (example data) · `docs/NOTES.md` (product notes)

## Rules that matter
1. **Dark/light changes only colours.** Colours live in tokens per theme; sizes, spacing, radii and shadow geometry are defined once in `:root`. Never put non-colour properties inside `[data-theme]` blocks. When touching UI, compare computed styles in both themes — the non-colour differences must be empty. (David's global rule.)
2. **User-written text is text.** Build DOM with `textContent` / the `el()` helper; `innerHTML` only for static icon markup. The data is also sanitised on the server (`src/schema.js`) — keep both.
3. **No inline scripts or inline `style=""`** — the CSP (`server.js`) forbids them. The widget uses a constructed stylesheet for the same reason.
4. **Admin writes are same-origin JSON only** (`auth.requireAdmin` + the JSON check in `api.js`). Keep every new write route behind `requireAdmin`.
5. **Public data is public.** `publicProduct()` is the only shape visitors get; private products must never leak through list/get/dataset endpoints. Add a test when adding an endpoint.
6. **Writes go through `Store`** (serialised + atomic). Don't write files from routes. Product updates carry the `rev` they were based on; keep the 409 behaviour.
7. Keep it dependency-light (Express only). Ask before adding a dependency or a database.

## Working style
- Reply to David in Portuguese, concisely: lead with the result, then only what he needs to act on.
- **Commit and push only when asked.** Check `git status` first; this repo is edited on Windows (CRLF warnings from git are normal).
- Verify UI changes in a real browser (the preview pane), not just by reading code. Quirks learned: the pane freezes CSS transitions/animations while hidden — inject `*{transition:none!important;animation:none!important}` before measuring or taking screenshots; set the viewport with `resize_window` and reset it afterwards; clean `localStorage`/test data when done.
- When a request is ambiguous and the answer changes the design, ask one short question; otherwise pick the sensible default and say what you chose.
- Don't paste secrets (`ADMIN_TOKEN`, `SESSION_SECRET`) anywhere — they're set in Railway's Variables.
