# CLAUDE.md — Roadmaps

Instructions for Claude Code when working in this repository. Read `docs/NOTES.md` first for the product context.

## What this is
A small hosted app (Node + Express, vanilla JS, **no build step**) where anyone can sign in with Google and keep **Now / Next / Later roadmaps for their products**.
Each roadmap starts private; the owner can make it public, which gives a **public page** and an **embed snippet** that always point back to this site.
**The server stores nothing**: the user's roadmaps are a file in their own Google Drive (private app folder); a shared roadmap is a public copy in their Drive that the server reads for visitors.
Hosted on **Railway** at https://roadmaps.monco.io (no Volume needed; own Google Cloud project). The owner is David (talks in Portuguese; the UI and code are in English).

## Commands
```bash
npm install
npm test                          # must stay green (node:test): schema, public proxy, Google sign-in vs a fake Google, pages/headers
node --env-file=.env server.js    # run locally (see .env.example)
```

## Layout
- `server.js` wiring (CSP, routes) · `src/auth.js` Google sign-in session (refresh token in an encrypted cookie) · `src/public.js` `GET /api/public/:id` · `src/schema.js` cleaning of public files
- `public/index.html` product page · `public/app.html` + `js/app.js` the app (UI) · `js/sync.js` sign-in tokens, Drive sync, sharing · `r.html` + `js/viewer.js` public page (plain DOM with `app.css`, so page translators can read it; see `docs/PHASE3.md`) · `embed.js` widget (shadow DOM, for other sites) · `app.css` design tokens + components · `js/theme.js`
- `public/privacy.html` + `terms.html` (linked from the Google consent screen) · `public/product-page.css` · `test/server.test.js` · `test/sync.test.js` (sync.js in a vm against a fake Drive) · `docs/NOTES.md`

## Rules that matter
1. **Dark/light changes only colours.** Colours live in tokens per theme; sizes, spacing, radii and shadow geometry are defined once in `:root`. Never put non-colour properties inside `[data-theme]` blocks. When touching UI, compare computed styles in both themes — non-colour differences must be empty. (David's global rule.)
2. **User-written text is text.** Build DOM with `textContent` / the `el()` helper; `innerHTML` only for static icon markup. Public files are re-cleaned on the server (`src/schema.js`) — keep both.
3. **No inline scripts or inline `style=""`** (the CSP in `server.js` forbids them). The widget uses a constructed stylesheet for the same reason. If a page needs Google/Drive hosts, add them to `connect-src` deliberately.
4. **The server must stay stateless and secret-light.** No database, no files for user data, no tokens stored. The only secrets are env vars (`GOOGLE_CLIENT_SECRET`, `COOKIE_SECRET`, `DRIVE_API_KEY`).
5. **`/api/public/:id` is the only way visitors read a roadmap.** It must only accept well-formed ids, only talk to the Drive *files* API, only serve files marked `app: "roadmaps-public"`, and stay cached/rate-limited. Add a test when changing it.
6. **Drive sync safety (see `sync.js`):** never save after a failed/ambiguous load; ask before overwriting a newer Drive copy; edits made offline are flagged and reconciled later; a different Google account must never inherit another account's local data; deleting or importing over a shared roadmap must revoke its public copy (queued if offline).
7. **Phones (≤ 700 px): the top bar shows only the roadmap tabs and a ⋮ button.** Everything else (brand link, sync chip, theme toggle, export/import, sign-out) lives in `#user-menu`; mobile-only items use `.user__item--m`. New top-bar controls must be added to that menu too. Theme buttons carry `data-theme-toggle` (`theme.js` wires all of them).
8. Keep it dependency-light (Express only). Ask before adding a dependency or a database.
9. **The product pages of Roadmaps, Taskboards and Diagramico share one system.** The reference is the landing section of `app.css`; `public/product-page.css` is its generated extract (tokens, header, buttons, hero, sections, cards, steps, footer). Taskboards (`public/` and root copy) and Diagramico carry a copy and only override the accent tokens (`--primary*`, `--glow`). When you change the landing rules in `app.css`, regenerate `product-page.css` and copy it to those repos — a test fails when they drift. Taskboards' app header follows the Roadmaps top bar.

## Working style
- Reply to David in Portuguese, concisely: lead with the result, then only what he needs to act on.
- **Commit and push only when asked.** Check `git status` first; this repo is edited on Windows (CRLF warnings from git are normal). Railway deploys on every push to `main`, so set env vars first.
- Verify UI changes in a real browser (the preview pane), not just by reading code. Quirks learned: the pane freezes CSS transitions/animations while hidden — inject `*{transition:none!important;animation:none!important}` before measuring or taking screenshots; set the viewport with `resize_window` and reset it afterwards; clean `localStorage`/test data when done. A full sign-in + Drive loop can be tested with a fake Google (token/auth endpoints: `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_REVOKE_URL` env vars) and a fake Drive server — see how `test/server.test.js` fakes Google. For the browser, serve a copy of `public/` whose `app.html` loads a small script before `sync.js` that rewrites `https://www.googleapis.com/` fetches to the fake Drive (and add that origin to `connect-src` in the copy of `server.js`).
- Edit files with the Edit tool or small scripts; regex escapes (`\d`) get lost when pasted through shell heredocs.
- When a request is ambiguous and the answer changes the design, ask one short question; otherwise pick the sensible default and say what you chose.
- Don't paste secrets anywhere — they are set in Railway's Variables.
