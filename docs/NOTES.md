# Roadmaps — product notes and hand-off

Updated 2026-10-19. A new working session can start from this file. **Status: v0.2 is deployed at https://roadmaps.monco.io (Railway, custom domain) with its own Google Cloud project; sign-in works.**

## 1. What and why

David has several small products (Taskboards, Diagramico, more to come) and wants a place to **define each product's roadmap and show it on the product's own page** ("what we're building now, next and later"). It also works as a way to collect interest before building. It is meant to become a **product of its own**: anyone signs in with Google, creates roadmaps for their products, keeps them private, and makes them public (page + embed snippet) when ready — all anchored on this site's address.

History: it started as an editor page inside Taskboards (`roadmap.html`, localStorage + exported `roadmap.json`). Version 0.1 was a token-protected admin with file storage on a Railway Volume. **Version 0.2 (current) replaced that** with the Taskboards model: Google sign-in, data in the user's own Drive, nothing stored by the server.

## 2. Decisions taken

- **Product page** at `/` (similar in structure to Taskboards' landing: hero, example board, features, how it works, embed, privacy). The app lives at `/app`.
- **Access = Google account**, exactly like Taskboards: the server keeps a refresh token in an encrypted cookie (`src/auth.js`, copied from Taskboards' session server), the browser talks to Drive directly. Same-origin, so no CORS/third-party-cookie problems.
- **Storage = the user's Drive**: one private file `roadmaps-data.json` (app folder, scope `drive.appdata`). No database, no Volume on Railway.
- **Private by default; public on demand.** *Make public* creates a separate Drive file readable by "anyone with the link" (scope `drive.file`), kept in sync on every edit; *Make private* (or deleting the roadmap) deletes it. The public copy has no ids and no account data.
- **Shares always start from this site:** page `https://<site>/r/<fileId>`, snippet `<div data-roadmap="<fileId>" data-header="true"></div><script src="https://<site>/embed.js" defer></script>`.
- **Visitors never talk to Google:** `GET /api/public/<fileId>` reads the public file with a **server-side API key**, validates/cleans it, caches 30 s, open CORS. Chosen over a browser-side API key because a key restricted by HTTP referrer would break on every site that embeds the widget.
- **UI:** PrimeNG **Aura**-inspired (zinc surfaces, emerald primary, 6 px controls / 12 px panels, tinted tags). Dark/light only swap colours (David's rule, see `CLAUDE.md`). English UI.
- **Own Google Cloud project** (decided 2026-10-19): products stay autonomous, so Roadmaps has its own project, OAuth client and API key — separate consent-screen branding, quotas and risk, and the user's app folder belongs to the client so it could not be moved later. Taskboards' project is untouched.
- **Working style:** Portuguese conversation, concise, commit/push only when asked, tests + a real-browser check for UI work.

## 3. What exists now

- Product page, sign-in gate, the app (roadmaps as **coloured tabs** using the Taskboards palette — automatic colour, right-click / long-press to pick one, drag to reorder — with a lock/rocket icon, hero with *Edit* / *Share*, three columns, drag & drop + ‹ › + Alt+arrows, compact title-only cards, existing **labels offered when adding a card**, autosave status chip, user menu with Export/Import/Sign out). **On phones (≤ 700 px) the top bar keeps only the tabs and a ⋮ menu** holding brand link, sync status, theme toggle, export/import and sign-out (one `#user-menu`, two buttons: avatar on desktop, ⋮ on phones; `data-theme-toggle` buttons all toggle the theme), share dialog (private ⇄ public, page link, embed snippet, copy buttons), public page, widget.
- Sync (`public/js/sync.js`): token lifecycle, Drive load/save with conflict prompt, offline editing + reconcile, share create/publish/revoke with a durable revoke queue, account-switch safety.
- 7 server tests passing (schema cleaning, public proxy incl. rate limit/cache/ETag, Google sign-in against a fake Google, pages + CSP). The client was tested end to end in a browser against a fake Google and a fake Drive: sign-in, create, autosave, re-consent for `drive.file`, make public, public page through the proxy, auto-publish on edit, make private, delete a shared roadmap, offline edit → reconnect, export/import, sign-out.
- **Not done:** History/revisions (v0.1 had them on the server; with Drive they would need a Drive-side approach), multi-editor collaboration, analytics.
- **Open (Google):** the consent screen is still **Testing** — *Publish app* stayed greyed out ("finish the configuration on the Branding page") even with Branding saved, the Drive scopes added and the optional domain fields cleared. Until it is **In production**, only listed test users can sign in and their sign-in expires after 7 days. Things to try: save Branding again and reload *Audience*; look at *Verification Center*; wait a few minutes after creating the project; add privacy-policy and terms links once there is a page for them.

## 4. Setup checklist (Google + Railway)

Done on 2026-10-19 except where marked. The step-by-step is in the README ("Set up Google").
1. Google Cloud (own project `roadmaps`): Drive API enabled, consent screen External + Branding, Data access scopes `drive.appdata` + `drive.file`, **Web client** with redirect `https://roadmaps.monco.io/auth/callback`, **API key** restricted to the Drive API (no application restriction). ⚠ Consent screen still in *Testing* — see "Open (Google)" above.
2. Railway variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_SECRET`, `DRIVE_API_KEY`, `PUBLIC_URL=https://roadmaps.monco.io`. The old v0.1 variables (`ADMIN_TOKEN`, `SESSION_SECRET`, `DATA_DIR`) and the Volume are not used. Gotcha: Railway's *Suggested variables* are only saved after clicking **Add**; `/api/config` showed `signIn:false` until `COOKIE_SECRET` was really added.
3. Custom domain `roadmaps.monco.io` is live.
4. Smoke test: `/healthz`, `/api/config` (both `true`), sign in at `/app`, create a roadmap, make it public, open `/r/<id>` in a private window, make it private, check the page stops (≤ 30 s because of the cache).

## 5. Connect the other apps

- **Taskboards** (`D:\Documents\GitHub\taskboards`, `taskboards.monco.io`): `roadmap.html` / `roadmap.js` are a read-only viewer and `roadmap-embed.js` a widget, both reading `ROADMAP_SRC` from `config.js` (default: the local `roadmap.json`). With this app live: create the Taskboards roadmap here (Import accepts the old `roadmap.json` shape), make it public, then either embed `<div data-roadmap="<id>">` + this site's `/embed.js` on the landing page, or point `ROADMAP_SRC` at `https://<site>/api/public/<id>` (the viewer/widget understand a single-roadmap response as well as the old `{products:[…]}` file — check the Taskboards viewer first, it only knows the old shape).
- **Diagramico** (`D:\Documents\GitHub\diagramico`): its landing has the roadmap hard-coded (`ROAD` in `index.html`, PT + EN). Replace it with the two-line embed once its roadmap exists here.

## 6. Open questions for David

1. ~~Name, domain and OAuth client~~ — settled: Roadmaps at `roadmaps.monco.io`, separate Google project.
3. **Languages:** Diagramico is PT/EN — should items carry translations and the widget pick by `lang`?
4. **Item model:** status/ETA, a "read more" link, votes / "I want this" (feeds a waitlist), a **Shipped** column or changelog?
5. **History:** is a per-roadmap version history needed? (Drive's app-folder files have none that users can see; options: keep N snapshots inside the data file, or a second Drive file.)
6. **Collaboration:** several editors per roadmap (shared Drive file + merge — the hard part Taskboards also postponed)?
7. **Visitors:** subscribe-for-updates, votes, comments? They would make the server hold personal data → privacy notice/GDPR, and probably a database.
8. **Monetisation:** free for personal use; teams / "install in your own Google Workspace or Microsoft 365" as a paid, service-led plan (see Taskboards' plans page).

## 7. Suggested plan

- **Phase 1 — ship:** (setup done; get the consent screen **In production**), recreate the Taskboards and Diagramico roadmaps, embed them on both product pages, retire the old copies.
- **Phase 2 — polish:** (roadmap ordering and per-roadmap colour are done) duplicate roadmap, a privacy page + terms linked from the consent screen, "last updated" control, nicer public page header, RSS/Atom feed of changes.
- **Phase 3 — richer items:** status/dates/links, Shipped/changelog, PT/EN translations.
- **Phase 4 — audience:** opt-in subscribe, votes, analytics (settle privacy and a database first).
- **Phase 5 — teams:** shared roadmaps with roles, own-tenant installation.

## 8. Start a new working session

Open this repository in Claude Code and paste:

> You're continuing the **Roadmaps** app (see `CLAUDE.md` and `docs/NOTES.md`). Version 0.2 — Google sign-in, data in the user's Drive, public pages and an embed widget — is deployed at https://roadmaps.monco.io and sign-in works. First run `npm test` and `git status`, and check `/healthz` and `/api/config` from the outside. Then help me get the Google consent screen from *Testing* to *In production* (see "Open (Google)" in section 3), and move on to Phase 1: recreate the Taskboards and Diagramico roadmaps here and embed them. I'll answer the open questions in section 6 as we go; for anything that changes the design ask me one short question first. Reply in Portuguese, concisely, and don't commit or push until I say so.

## 9. References

- Taskboards: `auth.js` (the session server this one was adapted from), `app.js` (sync code `sync.js` was derived from), `share-core.js`/`view.js` (its encrypted sharing — a different design), `roadmap.*` and `roadmap-embed.js` (viewer and widget), `README.md`.
- Diagramico: `index.html` (`PLANS`, `ROAD`, waitlist → Formspree), `docs/ROADMAP.md`.
- Design reference: PrimeNG Aura (tokens in `public/app.css`).
