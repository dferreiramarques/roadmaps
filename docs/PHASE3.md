# Phase 3 — items with a date, shipped changelog by version, language

Decided with David on 2026-10-19 (Q&A). Implemented on the `phase3` branch.

## Decisions
- **Item**: one new optional field, `when` — a short free text ("Q1 2027", "Dec", up to 12 characters), shown on the card. No status field, no link field.
- **Shipped**: a card gets **Mark shipped** (asks for the date, today by default). The item leaves the columns and goes to the roadmap's *current version* with title, description, tag, date and shipped date.
- **Versions**: semver. The first version is `1.0.0`. **New version** closes the current one (it is archived, with its closing date) and opens the next; the app proposes patch / minor / major and the label can be edited (letters, digits, dots, hyphens). A version needs at least one shipped entry to be closed.
- **Public**: shipped is public by default. The public page and the widget get a **Shipped** button (rocket icon) that lists the current version's entries and links to the previous versions. The server renders Markdown on the fly from the public copy: `/r/<id>/changelog.md` (everything) and `/r/<id>/changelog/<version>.md`. Nothing is stored on the server. The Atom feed gets one extra entry per closed version.
- **Limits** (protect the Drive file and the page): the public copy carries the current version plus the last 20 closed versions, at most 100 entries each.
- **Language**: every roadmap has a source language (`lang`, chosen when it is created, default from the browser). The public page sets `<html lang>` and shows a *Translate* link (Google Translate) when the visitor's browser language differs. The widget does not translate by itself.
  - Finding (tested): Google's translation proxy does **not** translate text inside a shadow root, so the public page `/r/<id>` renders its roadmap in the normal DOM (using `app.css`) instead of through the widget. The widget stays a shadow-DOM component for other sites.
- **Migration**: existing roadmaps keep working unchanged; they get `lang: "en"` and no version until the first item is marked shipped.

## Data (private file, per roadmap)
`when` on items · `lang` · `version` (current label) · `shipped: [{id,title,description,tag,tone,when,shippedAt}]` (current version) · `releases: [{version, closedAt, items:[…]}]` (closed, newest first).

## Public copy (`app: "roadmaps-public"`)
Same fields without ids: `lang`, `version`, `shipped`, `releases` (last 20), items with `when`. `src/schema.js` cleans all of it again on the server.
