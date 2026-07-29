# Tonearm

**Tonearm** is a modern, **desktop-first** web client for [Navidrome](https://www.navidrome.org/) **and [Jellyfin](https://jellyfin.org/)** (music only). It runs entirely in the browser, talks directly to your existing server — Navidrome over its Subsonic/OpenSubsonic and native APIs, or Jellyfin over its native API — and keeps all durable state (playlists, favourites, play counts) **on the server** so it stays in sync with your other clients.

At login you pick which server you're connecting to; the choice is stored with your credentials so the app knows which API to use. Existing Navidrome logins keep working unchanged across an update — to try Jellyfin, just log out and log back in with the Jellyfin option. (Only Jellyfin's music library is used — films and TV are never touched.)

There is **no database**, and in its simplest form **no backend** — the app is a static bundle and everything happens in your browser. An optional thin proxy server ships in the Docker image to avoid CORS and (for admins) enable uploads; see [Running with Docker](#running-with-docker-recommended). The proxy and admin upload are Navidrome-only; Jellyfin connects directly and needs [CORS enabled](https://jellyfin.org/docs/general/networking/) for this app's origin.

> Designed for desktop browsers only: wide multi-pane layouts, hover states, right-click context menus, and keyboard shortcuts. Good iOS/Android clients already exist, so mobile layouts are intentionally out of scope.

## Features

- **Library browsing** — artists, albums, tracks, genres, plus recently added / recently played / most played.
- **Server-side search**, debounced.
- **Playlists** — view, create, rename, reorder (drag), remove tracks, delete. All persisted via the API. Upload a **custom cover photo** per playlist, stored on the server so it syncs to every client. Reordering uses each backend's best mechanism (Jellyfin's atomic move; a rewrite on Subsonic).
- **Favourites / stars** with instant feedback, synced to the server.
- **Persistent now-playing bar** with full transport, a live seek bar, queue, and volume.
- **Queue** side panel with drag-to-reorder.
- **Lyrics** side panel, with synced (time-aligned) highlighting when your server provides it.
- **Album & artist pages** with metadata, cover art, biographies, and similar artists.
- **Gapless-ish playback, crossfade, and ReplayGain normalization** via the Web Audio API.
- **Keyboard shortcuts** for playback and navigation — fully rebindable.
- **Admin music upload** — when deployed alongside your server (see below), admins get an upload button that accepts audio files, whole folders, or a ZIP, writes them into the library, and triggers a scan. All embedded metadata is preserved.
- **Update checking** — admins can see, from Settings, whether the deployment is behind the latest release, and (opt-in) update it in one click.
- **A deep settings system** (see below).

### Jellyfin specifics

Tonearm speaks Jellyfin the way Jellyfin's own clients do, rather than treating it
as a Subsonic server with different URLs:

- **Negotiated playback.** Every track goes through `POST /Items/{id}/PlaybackInfo`
  with a device profile built from what your browser can actually decode. Jellyfin
  hands back either the original file to direct-play or a transcode URL, plus the
  `PlaySessionId` that keys the server-side encoder. Nothing is guessed.
- **Correct session reporting.** Playback start, progress every 10s, and a single
  stop at the end — so play counts increment, Now Playing appears on the Jellyfin
  dashboard, and resume positions are real.
- **Remote control.** The app registers its capabilities and holds a WebSocket, so
  it shows up as a "Play On" target and can be driven from the Jellyfin app or web
  dashboard (play/pause, skip, seek, volume, repeat, shuffle, queue push).
- **Quick Connect** sign-in — no password typing on a TV or shared machine.
- **Multiple music libraries**, picked from the sidebar.
- **Instant Mix radio** seeded from a track, album, artist, or genre.
- **Live radio and music videos** from the same server, with no second login.
- **Album/playlist downloads**, zipped in the browser since Jellyfin has no
  server-side bundling endpoint.

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
| `UPDATE_REPO` | `j4ckxyz/navidrome-client-web` | Repo the update check compares against. Change it if you run a fork. |
| `UPDATE_BRANCH` | `main` | Branch the update check follows. |
| `SELF_UPDATE` | _(off)_ | Set to `1` to let admins apply updates from the Settings page. Requires the extra mounts described below — **off by default**. |
| `REPO_DIR` | `/repo` | Where the git checkout is mounted when `SELF_UPDATE` is on. |
| `JELLYFIN_URL` | _(empty)_ | Jellyfin server used to verify that a caller is an admin. Only needed for `SELF_UPDATE` on a Jellyfin-backed deployment. |

Uploads are **off by default** and gated three ways, so a public deployment can't be abused: the operator must explicitly set `MUSIC_DIR` + mount the matching folder, the request must come from a user the **proxied server confirms is an admin**, and direct mode disables the endpoint entirely.

### Checking for updates

Admins get an **Updates** card in Settings → Connections. It compares the commit this build was made from against the head of `UPDATE_BRANCH` on GitHub and tells you how far behind you are, with a link to the diff.

Installing the update is a separate question, because the shipped container deliberately has no git checkout and no Docker socket:

- **Default (recommended).** The card shows the one command to run in the folder you deployed from:

  ```bash
  bun run update
  ```

  That's the same updater the button would run — it inspects your existing Compose project, preserves your `docker-compose*.yml` and `.env`, pulls, and rebuilds in place.

- **Opt-in one-click updates.** Set `SELF_UPDATE=1` and give the container what the updater needs — the checkout and the Docker socket:

  ```yaml
  environment:
    SELF_UPDATE: "1"
  volumes:
    - .:/repo                                   # the git checkout, including .git
    - /var/run/docker.sock:/var/run/docker.sock # lets it rebuild itself
  ```

  > **Understand what this trades away.** Mounting the Docker socket gives the container root-equivalent control of the Docker host. Only do this on a deployment you trust and don't expose publicly. The endpoint additionally requires a caller your server confirms is an admin, and refuses outright unless both mounts are actually present.


### Quick start

**A) All-in-one (also runs Navidrome) — simplest path to every feature:**

```bash
COMMIT_HASH=$(git rev-parse HEAD) MUSIC_HOST_DIR=/path/to/your/music docker compose -f docker-compose.full.yml up -d
# open http://localhost:8680 and create your admin account on first login
```

**B) Alongside an existing Navidrome, with uploads:** uncomment the `volumes:` lines in `docker-compose.yml`, then:

```bash
NAVIDROME_URL=http://host.docker.internal:4533 \
MUSIC_DIR=/music \
MUSIC_HOST_DIR=/path/to/your/music \
bun run compose:up
```

**C) Public client, users bring their own server (no uploads):**

```bash
bun run compose:up   # NAVIDROME_URL stays empty → direct mode
```

In direct mode each user's Navidrome must allow this app's origin via **CORS** (or be reverse-proxied behind the same origin). See [DEPLOYMENT.md](DEPLOYMENT.md#direct-mode-cors) for the exact headers and an nginx same-origin example.

To build and run the image by hand:

```bash
docker build -t tonearm .
docker run -d -p 8680:8080 \
  -e NAVIDROME_URL=http://host.docker.internal:4533 \
  -e MUSIC_DIR=/music \
  -v /path/to/your/music:/music \
  --name tonearm tonearm
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

### Native desktop builds

Tonearm uses Tauri for its macOS, Windows and Linux application. Unlike Electron,
it reuses the operating system WebView instead of shipping a separate Chromium
runtime for every install; the release profile also enables LTO, size optimisation,
symbol stripping and abort-on-panic. This keeps startup, package size and baseline
memory use close to the web client rather than adding a browser process.

```bash
bun run desktop:dev
bun run desktop:build
```

Tags matching `v*` trigger `.github/workflows/desktop-release.yml`, producing a
universal (Apple Silicon + Intel) macOS 15+ DMG, Windows NSIS and MSI installers
and a Linux AppImage on a public GitHub release. Publishing a release through
GitHub's UI also triggers the same builds and attaches them to that release. The
workflow can also be run manually with a release tag. Playback commands are exposed
as native menu accelerators using Command on macOS and Control on Windows/Linux.
The same track, album and playlist Download actions as the web app save music for
offline listening. Desktop icons are generated from the existing web icon at build
time, so native binary assets are not duplicated in the repository. Native builds
also retain the platform window controls and use macOS Vibrancy or Windows 11 Mica
behind the draggable title bar; unsupported compositors fall back to an opaque
window without extra work.

See [docs/windows-release.md](docs/windows-release.md) for the Windows specifics:
why the window effects have to stay best-effort, and how to enable Authenticode
signing so Windows Security stops quarantining the installer.

## Out of scope

No mobile/PWA layouts, and no broad library administration (user management, library configuration). This is a playback and browsing client, not an admin panel — though admins can upload music and trigger scans when the client is deployed alongside the server (see Docker above).
