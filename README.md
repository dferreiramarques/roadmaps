# Roadmaps

Plan the roadmap of several products in one place, and show it on each product's own page.

- **Now / Next / Later** columns for every product, edited in a clean admin (Aura-style UI, light and dark).
- **Public pages** — a directory (`/`) and one page per product (`/p/<id>`), read-only.
- **Embeddable widget** — one `<div>` and one `<script>` put a product's roadmap on any website.
- **History** — every change is a numbered revision you can restore; two tabs can't overwrite each other.
- **No database, no build step** — Node + Express, vanilla JS, one JSON file per product on a disk.

```
admin (you)  ──edit──▶  server  ──▶  /data/products/*.json (+ revisions)
                          │
visitors / other sites ◀──┴── /p/<id>  ·  /api/roadmap.json  ·  /embed.js
```

## Run it locally

```bash
npm install
cp .env.example .env      # then set ADMIN_TOKEN (see the file)
node --env-file=.env server.js
# → http://localhost:3000  (public)   http://localhost:3000/admin  (sign in with ADMIN_TOKEN)
```

The first start with an empty `DATA_DIR` loads the example roadmaps from `seed/roadmap.json`. Load another file any time:
`node scripts/seed.js path/to/roadmap.json` (products with the same `id` are replaced; the old versions stay in their history).

## Deploy on Railway

1. **New Project → Deploy from GitHub repo** (this repo). Railway detects Node; `railway.json` sets the start command and a health check on `/healthz`.
2. **Add a Volume** to the service, mount path **`/data`**. Without it the data is wiped on every deploy.
3. **Variables:**

   | Variable | Value |
   |---|---|
   | `ADMIN_TOKEN` | a long random string — the password for `/admin` |
   | `SESSION_SECRET` | another long random string (keeps you signed in across deploys) |
   | `DATA_DIR` | `/data` |

   Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. **Settings → Networking → Custom Domain**, e.g. `roadmap.yourdomain.com`, and add the CNAME Railway shows at your DNS.
5. Open `/admin`, sign in, done. Take backups from **Export** in the admin (a `roadmaps.json` you can re-import).

## Show a roadmap on a product page

```html
<div data-roadmap="my-product" data-header="true"></div>
<script src="https://roadmap.yourdomain.com/embed.js" defer></script>
```

`data-roadmap` is the product **id** (shown in the admin's address bar after you pick a product, and in `/p/<id>`).
Optional: `data-header="true"` adds the product name, tagline and link; `data-theme="light|dark"` forces a theme (default: follows `<html data-theme>` or the visitor's OS); `data-src` reads a different dataset.
The widget lives in a shadow root, so page CSS can't break it, and it only ever inserts text from the data, never HTML.

## API

Public (CORS open, anyone can read):

| | |
|---|---|
| `GET /api/roadmap.json` (also `/roadmap.json`) | every **public** product — what the widget reads |
| `GET /api/products` | list with counts |
| `GET /api/products/:id` | one product |

Admin (signed in, same origin only): `POST /api/login` · `POST /api/logout` · `GET /api/me` · `POST /api/products` · `PUT /api/products/:id` (send the `rev` you loaded; a stale one gets `409`) · `DELETE /api/products/:id` · `GET /api/products/:id/revisions` · `POST /api/products/:id/restore` · `PUT /api/order` · `GET /api/export` · `POST /api/import`.

## Data

```
DATA_DIR/products/<id>.json            current version of each product
DATA_DIR/revisions/<id>/<rev>.json     every version (the latest 100 are kept)
DATA_DIR/trash/<id>-<time>.json        deleted products
DATA_DIR/index.json                    the order products are listed in
```

A product is `{ id, name, tagline, url, visibility: "public"|"private", now: [], next: [], later: [], rev, createdAt, updatedAt }`;
an item is `{ id, title, description, tag, tone }` with `tone` one of `success info warn danger secondary contrast`.
Everything written is trimmed, length-capped and checked on the way in (`src/schema.js`).

## Security, briefly

- Editing needs the admin token; the session is a signed `HttpOnly` cookie. Every state-changing request must come from the same origin and be JSON.
- The roadmap data is **public by design** — private products are never sent to visitors, but don't put secrets in anything marked public.
- A strict Content-Security-Policy is set on every page (no inline scripts).

## Tests

```bash
npm test      # API, auth, validation, revisions, import/export, seeding (13 tests)
```

## More

`docs/NOTES.md` has the product notes: decisions so far, open questions, the plan, and a prompt to start a new working session.
