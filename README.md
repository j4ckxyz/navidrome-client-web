# Navidrome Web Client

A modern, **desktop-first** web client for [Navidrome](https://www.navidrome.org/). It runs entirely in the browser, talks directly to your existing Navidrome server over its Subsonic/OpenSubsonic and native APIs, and keeps all durable state (playlists, favourites, play counts) **on the server** so it stays in sync with your other clients.

There is **no database**, and in its simplest form **no backend** — the app is a static bundle and everything happens in your browser. An optional thin proxy server ships in the Docker image to avoid CORS and (for admins) enable uploads; see [Running with Docker](#running-with-docker-recommended).

> Designed for desktop browsers only: wide multi-pane layouts, hover states, right-click context menus, and keyboard shortcuts. Good iOS/Android clients already exist, so mobile layouts are intentionally out of scope.

## Features

- **Library browsing** — artists, albums, tracks, genres, plus recently added / recently played / most played.
- **Server-side search**, debounced.
- **Playlists** — view, create, rename, reorder (drag), remove tracks, delete. All persisted via the API. Upload a **custom cover photo** per playlist (stored on the server via Navidrome's native API, so it syncs to every client).
- **Favourites / stars** with instant feedback, synced to the server.
- **Persistent now-playing bar** with full transport, a live seek bar, queue, and volume.
- **Queue** side panel with drag-to-reorder.
- **Lyrics** side panel, with synced (time-aligned) highlighting when your server provides it.
- **Album & artist pages** with metadata, cover art, biographies, and similar artists.
- **Gapless-ish playback, crossfade, and ReplayGain normalization** via the Web Audio API.
- **Keyboard shortcuts** for playback and navigation — fully rebindable.
- **Admin music upload** — when deployed alongside your server (see below), admins get an upload button that accepts audio files, whole folders, or a ZIP, writes them into the library, and triggers a scan. All embedded metadata is preserved.
- **A deep settings system** (see below).

## The settings system

Settings live in `localStorage` under `nd:settings`, namespaced separately from credentials, and never leave your browser.

- **Theming** — nine independently themeable regions (sidebar, content, surfaces, accent, now-playing bar, text colours…). Choose a preset (Dark, Light, Midnight, Warm, Mono) or customize:
  - **Simple** mode: pick a base (dark/light) + an accent; the rest of the palette is derived in OKLCH with contrast kept readable.
  - **Advanced** mode: full control over all nine regions.
  - **Share a theme** as a short `ndtheme:…` code or a QR image. Import by pasting a code or uploading a QR screenshot. Great for self-hosters sharing looks around.
- **Layout** — density (compact / comfortable / spacious), cover-art size, default landing page, default panel visibility.
- **Playback** — default volume, crossfade, gapless, scrobbling, ReplayGain mode + pre-amp, max streaming bitrate, resume-queue-on-launch.
- **Power user** — rebindable keyboard shortcuts, next-track prefetch, cover-art cache budget, polling/cache intervals, a **debug panel** that shows raw API responses, and a log level.
- **Backup** — export/import the full settings as a validated JSON file (credentials are never included), plus reset-to-defaults.

## Deploying

The Docker image is a small Bun server. Depending on how you configure it, it runs in one of two modes:

- **Proxy mode** (`NAVIDROME_URL` set) — the server forwards all API/auth calls to one Navidrome server. The browser only ever talks to this app's own origin, so **there is no CORS to configure**. This is the mode that can enable uploads.
- **Direct mode** (`NAVIDROME_URL` unset) — no proxy. Each user types their own Navidrome URL at login and the browser talks to it directly. Use this to host **one public client that many people point at their own servers**. Uploads are never available in this mode.

> **Full walkthrough for every scenario (great for scripts/agents): [DEPLOYMENT.md](DEPLOYMENT.md).**

### Which setup do I want?

| Your situation | Use | Uploads |
|----------------|-----|---------|
| **I host this publicly** for many people, each with their **own** Navidrome | Direct mode (`docker-compose.yml`, leave `NAVIDROME_URL` empty) | ❌ off by design |
| **Just me / my household**, client + Navidrome on the **same box**, I want to upload music from the browser | All-in-one (`docker-compose.full.yml`) **or** proxy mode + mounted music folder | ✅ admins only |
| Client and Navidrome on **different machines/containers**, no uploads needed | Proxy mode (`docker-compose.yml`, set `NAVIDROME_URL`) | ❌ |

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NAVIDROME_URL` | _(empty)_ | Target server to proxy to. **Empty = direct mode** (users enter their own URL). Set = proxy mode (no CORS). |
| `MUSIC_DIR` | _(empty — uploads off)_ | Path **inside the container** where music lives. To enable the **admin upload** UI you must set this (e.g. `/music`), mount that path to the exact folder your Navidrome scans, **and** have `NAVIDROME_URL` set. Empty keeps uploads off. |
| `PORT` | `8080` | Port the server listens on. |

Uploads are **off by default** and gated three ways, so a public deployment can't be abused: the operator must explicitly set `MUSIC_DIR` + mount the matching folder, the request must come from a user the **proxied server confirms is an admin**, and direct mode disables the endpoint entirely.

### Quick start

**A) All-in-one (also runs Navidrome) — simplest path to every feature:**

```bash
MUSIC_HOST_DIR=/path/to/your/music docker compose -f docker-compose.full.yml up -d
# open http://localhost:8680 and create your admin account on first login
```

**B) Alongside an existing Navidrome, with uploads:** uncomment the `volumes:` lines in `docker-compose.yml`, then:

```bash
NAVIDROME_URL=http://host.docker.internal:4533 \
MUSIC_DIR=/music \
MUSIC_HOST_DIR=/path/to/your/music \
docker compose up -d
```

**C) Public client, users bring their own server (no uploads):**

```bash
docker compose up -d   # NAVIDROME_URL stays empty → direct mode
```

In direct mode each user's Navidrome must allow this app's origin via **CORS** (or be reverse-proxied behind the same origin). See [DEPLOYMENT.md](DEPLOYMENT.md#direct-mode-cors) for the exact headers and an nginx same-origin example.

To build and run the image by hand:

```bash
docker build -t navidrome-client-web .
docker run -d -p 8680:8080 \
  -e NAVIDROME_URL=http://host.docker.internal:4533 \
  -e MUSIC_DIR=/music \
  -v /path/to/your/music:/music \
  --name navidrome-web navidrome-client-web
```

## Authentication & privacy

- On first load you enter your server URL, username, and password (or a Subsonic salt+token if you have one).
- The app authenticates via Navidrome's native `/auth/login`, which returns a JWT **and** a Subsonic salt+token. It stores the salt+token (a hash of your password) and the JWT — **never your raw password**.
- If native login isn't available, it falls back to standard Subsonic token auth (generating a salt and hashing locally), again without storing the password.
- Credentials are stored in `localStorage`, **namespaced per server URL**, so you can switch between servers without losing previous logins.
- Expired/invalid auth surfaces a re-login prompt rather than failing silently.

## Tech stack & architecture

- **SolidJS + Vite + TypeScript**, with **Bun** as the package manager. Solid's fine-grained reactivity suits a media-heavy, frequently-updating UI (the now-playing bar updates continuously without re-rendering the rest of the app).
- **TanStack Solid Query** for server state (caching, dedup, background refresh); mutations invalidate the right keys so changes reflect across views.
- **Kobalte** for accessible headless primitives (menus, dialogs), styled from scratch.
- **Web Audio API** for volume, crossfade, and ReplayGain; a two-deck `<audio>` graph enables gapless preloading.
- Theming is implemented as **CSS custom properties** written by a theme provider, which is what makes per-region, live theming cheap.

```
src/
  api/        Subsonic + native API client, auth, types, md5
  auth/       session store, login screen
  player/     playback store, queue, Web Audio engine
  features/   shell, player UI, playlists, settings, stars
  pages/      routed views
  ui/         styled primitives (cards, rows, icons, menus)
  theme/      color math, presets, provider, share codes
  settings/   schema + persisted store
```

## Local development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev        # start the dev server (http://localhost:5173)
bun run build      # typecheck + production build to dist/
bun run preview    # preview the production build
bun run typecheck  # type-check only
```

During development you'll hit the same CORS rules above. The easiest dev setup is to run Navidrome locally and use a reverse proxy, or enable permissive CORS on your dev Navidrome instance.

## Out of scope

No mobile/PWA layouts, and no broad library administration (user management, library configuration). This is a playback and browsing client, not an admin panel — though admins can upload music and trigger scans when the client is deployed alongside the server (see Docker above).
