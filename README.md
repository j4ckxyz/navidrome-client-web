# Navidrome Web Client

A modern, **desktop-first** web client for [Navidrome](https://www.navidrome.org/). It runs entirely in the browser, talks directly to your existing Navidrome server over its Subsonic/OpenSubsonic and native APIs, and keeps all durable state (playlists, favourites, play counts) **on the server** so it stays in sync with your other clients.

There is **no backend** and **no database**. The app is a static bundle. Everything happens in your browser.

> Designed for desktop browsers only: wide multi-pane layouts, hover states, right-click context menus, and keyboard shortcuts. Good iOS/Android clients already exist, so mobile layouts are intentionally out of scope.

## Features

- **Library browsing** — artists, albums, tracks, genres, plus recently added / recently played / most played.
- **Server-side search**, debounced.
- **Playlists** — view, create, rename, reorder (drag), remove tracks, delete. All persisted via the API.
- **Favourites / stars** with instant feedback, synced to the server.
- **Persistent now-playing bar** with full transport, a live seek bar, queue, and volume.
- **Queue** side panel with drag-to-reorder.
- **Lyrics** side panel, with synced (time-aligned) highlighting when your server provides it.
- **Album & artist pages** with metadata, cover art, biographies, and similar artists.
- **Gapless-ish playback, crossfade, and ReplayGain normalization** via the Web Audio API.
- **Keyboard shortcuts** for playback and navigation — fully rebindable.
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

## Running with Docker (recommended)

Trivially hostable on Windows (Docker Desktop), macOS, and Linux. The image is a single static container (nginx serving the built assets) with no backend process, no bind mounts, and no platform-specific paths.

```bash
docker compose up -d
```

Then open **http://localhost:8680** and log in with your Navidrome server URL, username, and password.

- Change the host port by editing the `ports` mapping in `docker-compose.yml` (e.g. `"9000:80"`).
- The Navidrome URL is entered **in the app**, not baked into the image, so the same image works against any server.
- Settings are stored in your browser, so nothing needs to be persisted on disk — there are no volumes to manage.

To build the image directly without compose:

```bash
docker build -t navidrome-client-web .
docker run -d -p 8680:80 --name navidrome-web navidrome-client-web
```

## ⚠️ CORS — read this if login fails

Because there is **no backend to proxy through**, your browser calls your Navidrome server directly. The server must therefore allow this app's origin via **CORS**, or the requests will be blocked by the browser (you'll see a network/login error even though your credentials are correct).

You have two options:

### Option A — Reverse-proxy both behind the same origin (simplest, no CORS at all)

Serve this app and Navidrome under the **same scheme + host + port**, e.g. this app at `https://music.example.com/` and Navidrome at `https://music.example.com/` too (Navidrome on a subpath, or this app on a subpath). Same origin means no CORS is involved. Example with nginx:

```nginx
server {
    server_name music.example.com;

    # This web client
    location / {
        proxy_pass http://navidrome-web:80;
    }

    # Navidrome API on the same origin
    location /rest/   { proxy_pass http://navidrome:4533; }
    location /auth/   { proxy_pass http://navidrome:4533; }
    location /api/    { proxy_pass http://navidrome:4533; }
    location /share/  { proxy_pass http://navidrome:4533; }
}
```

When proxied this way, enter the **same URL** you're viewing the app from as the server URL at login.

### Option B — Allow this app's origin on Navidrome

If you host them on different origins (e.g. app at `http://localhost:8680`, Navidrome at `http://localhost:4533`), configure Navidrome to send CORS headers permitting the app's origin. If your Navidrome version/reverse-proxy supports adding response headers, the relevant ones are:

```
Access-Control-Allow-Origin: http://localhost:8680
Access-Control-Allow-Headers: Content-Type, x-nd-authorization, x-nd-client-unique-id
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

If you put a reverse proxy (nginx/Caddy/Traefik) in front of Navidrome, add those headers there and make sure `OPTIONS` preflight requests get a `204`.

> Tip: same-origin (Option A) is the most robust and avoids CORS entirely. Reach for it if you hit trouble.

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

No backend/API layer, no mobile/PWA layouts, and no library administration (scanning, user management). This is a playback and browsing client, not an admin panel.
