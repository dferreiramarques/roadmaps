# Roadmaps

Plan a product roadmap in minutes, keep it private until you're ready, then share a page or embed it on your website.
**Sign in with Google; your roadmaps live in your own Google Drive.** There is no database.

- **Now / Next / Later** columns for each of your products — drag, tag, edit (Aura-style UI, light and dark). Labels you already used in a roadmap are offered when you add a card.
- **Coloured tabs like Taskboards:** each roadmap has its own colour (automatic, or right-click the tab to pick one); drag the tabs to reorder them.
- **Private by default.** Press **Share → Make public** to get a **public page** and an **embed snippet**. Make it private again and both stop working.
- **Always a Roadmaps address.** The page is `https://<this site>/r/<id>` and the snippet loads `https://<this site>/embed.js`, so every share starts from here.
- **Your data stays yours.** All your roadmaps are one file in the private app folder of *your* Drive; a public roadmap is a copy that exists only while it is shared.

```
you (browser) ──sign in──▶ /auth/*  (token exchange only, nothing stored)
     │
     ├── edit ──▶ your Google Drive (private app folder: roadmaps-data.json)
     └── share ─▶ your Drive (one public "Roadmap — <name>" file per shared roadmap)

visitors / other sites ──▶ /r/<id> · /embed.js · /api/public/<id> ──(read-only API key)──▶ the public file
```

## How it works

- **`/`** product page · **`/app`** the app (sign in with Google) · **`/r/<id>`** a public roadmap · **`/embed.js`** the widget.
- **Sign-in** (`src/auth.js`): Google's authorization-code flow. The server keeps your refresh token in an encrypted `HttpOnly` cookie and exchanges it for short-lived access tokens, so you stay signed in for months without Google pop-ups. It stores nothing.
- **Data** (`public/js/sync.js`): the browser reads and writes Drive directly. Local working copy + dirty flag + "ask before overwriting a newer version" + offline editing that reconciles later.
- **Public reads** (`src/public.js`): visitors never talk to Google. `GET /api/public/<id>` fetches the public Drive file with a read-only API key, checks it really is a Roadmaps file, cleans it, caches it for 30 s and serves it with open CORS. (So a roadmap that is made private can still be served for up to ~30 s.)
- **Embed** (`public/embed.js`): a shadow-root widget that only ever inserts text, follows the host page's theme, and works on pages with a strict CSP.

## Embed on a website

```html
<div data-roadmap="THE-ID" data-header="true"></div>
<script src="https://<this site>/embed.js" defer></script>
```

`THE-ID` is in the **Share** dialog (and in the page address). Optional: `data-header="true"` shows the name, tagline and link; `data-theme="light|dark"` forces a theme (default: follows `<html data-theme>` or the visitor's OS).

## Run it locally

```bash
npm install
cp .env.example .env       # fill in the values (see the file)
node --env-file=.env server.js
# → http://localhost:3000
```

## Set up Google (once)

1. **Google Cloud Console → Credentials → OAuth client (Web application).** Add the redirect URI `https://<your site>/auth/callback` (and `http://localhost:3000/auth/callback` for local work). You can reuse the Taskboards project and client, or make a separate one — a separate client keeps the consent screen name and the private app folder apart.
2. **Google Auth Platform → Data access:** the scopes `…/auth/drive.appdata` (your private data) and `…/auth/drive.file` (the public copy of a shared roadmap). Both are non-sensitive, so no Google review. Publishing status: **In production**.
3. **Credentials → API key → Drive API only.** No HTTP-referrer restriction — it is used by the server.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo.** Railway detects Node; `railway.json` sets the start command and a health check on `/healthz`.
2. **Variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_SECRET`, `DRIVE_API_KEY` (see `.env.example`). `PUBLIC_URL` only if Google redirects to the wrong address. **No Volume is needed** — the server stores nothing.
3. **Settings → Networking → Custom Domain** (e.g. `roadmap.yourdomain.com`), add the CNAME Railway shows, and add `https://<that domain>/auth/callback` to the OAuth client.
4. Open `/app`, sign in, create a roadmap, **Share → Make public**, open the public page.

## API

| | |
|---|---|
| `GET /api/public/:id` | a shared roadmap — `{ id, name, tagline, url, now, next, later, updatedAt }` (CORS open, cached 30 s) |
| `GET /api/config` | `{ signIn, publicRoadmaps }` — what this server has configured |
| `GET /auth/login` · `/auth/callback` · `POST /auth/refresh` · `POST /auth/logout` | Google sign-in (same-origin; refresh/logout must come from this site) |
| `GET /healthz` | health check |

## Data

- **Private:** `roadmaps-data.json` in your Drive's private app folder — `{ app: "roadmaps", version: 1, current, roadmaps: [{ id, name, tagline, url, now, next, later, share?: { fileId } }] }`.
- **Public copy:** a Drive file `Roadmap — <name>` readable by anyone with the link — `{ app: "roadmaps-public", name, tagline, url, now, next, later }`. Item ids and everything else about your account are left out.
- An item is `{ title, description, tag, tone }`, `tone` one of `success info warn danger secondary contrast`.
- **Backup:** *user menu → Export backup* downloads everything; *Import* restores it (it also accepts the older `{ products: [...] }` roadmap.json shape).

## Security, briefly

- Strict Content-Security-Policy on every page (no inline scripts or styles). All user text is rendered as text.
- Sign-in cookies are `HttpOnly`, `SameSite=Lax`, AES-GCM encrypted; state-changing calls must come from the same origin.
- `/api/public/:id` only reaches the Drive *files* API for a well-formed id, only serves files that are Roadmaps files, and is rate limited.
- A public roadmap is public: anyone with the link can read it. Don't put secrets in it.

## Tests

```bash
npm test      # schema cleaning, public proxy, Google sign-in (against a fake Google), pages and headers
```

## More

`docs/NOTES.md` has the product notes: decisions, what exists, open questions, the plan, and a prompt to start a new working session.
