# Tonearm

A music player for your own [Navidrome](https://www.navidrome.org/) or
[Jellyfin](https://jellyfin.org/) server. It runs in your browser (or as a
desktop app) and talks straight to the server you already have.

Playlists, favourites and play counts live **on your server**, so everything
stays in sync with whatever else you use. There's no database and no account to
create — Tonearm is just a nicer front end for music you already own.

> **Desktop only.** Wide layouts, right-click menus, keyboard shortcuts. Phones
> and tablets aren't supported — good mobile apps for both servers already exist.

## Features

**Playing music**
- Full library browsing — artists, albums, tracks, genres, recently added, most played
- Queue with drag-to-reorder, and a persistent player bar
- Crossfade, gapless-ish playback, and volume levelling (ReplayGain)
- A 10-band equaliser and a music-reactive full-screen visualiser
- Synced lyrics, with an optional fallback to [LRCLIB](https://lrclib.net) when your files have none
- **Infinite radio** — when the queue empties it keeps going with tracks that
  actually match what you were listening to, rather than drifting into a shuffle

**Your library**
- Search, favourites, and playlists (create, rename, reorder, custom cover art)
- Download tracks, albums or playlists for offline listening
- A **Stats** page: how much you've listened to, your most-played songs, albums
  and artists, and what's in the library
- Admins can upload music from the browser — files, folders or a ZIP

**Making it yours**
- Nine themeable regions with presets, or build your own and share it as a code or QR
- Rebindable keyboard shortcuts, adjustable density and cover-art size
- Settings export/import

**If you use Jellyfin**
- Quick Connect sign-in, multiple music libraries, Instant Mix radio, live radio and music videos
- **Remote control both ways** — control Tonearm from the Jellyfin app, or push
  playback from Tonearm to your phone or TV

## Install

You need [Docker](https://docs.docker.com/get-started/get-docker/) and
[git](https://git-scm.com/downloads). Start by grabbing the code:

```bash
git clone https://github.com/j4ckxyz/navidrome-client-web.git
cd navidrome-client-web
```

Then pick the one that describes you.

### I don't have a music server yet

This starts Navidrome **and** Tonearm together, sharing one music folder. Point
it at your music:

```bash
MUSIC_HOST_DIR=/path/to/your/music docker compose -f docker-compose.full.yml up -d
```

Open <http://localhost:8680> and create your account on first login.

### I already run Navidrome or Jellyfin

```bash
NAVIDROME_URL=http://host.docker.internal:4533 bun run compose:up
```

Replace the URL with your server's. Open <http://localhost:8680>.

> `host.docker.internal` means "the machine Docker is running on" and works on
> Docker Desktop for Mac and Windows. On Linux use your server's IP address
> instead.

To also upload music from the browser, see
[DEPLOYMENT.md](DEPLOYMENT.md#uploading-music).

### I want to host it for other people

Leave the server URL empty and everyone types in their own at login:

```bash
bun run compose:up
```

Each person's server then needs to allow your site to talk to it — see
[DEPLOYMENT.md](DEPLOYMENT.md#hosting-for-other-people).

## Updating

In the folder you installed to:

```bash
bun run update
```

That's it. It pulls the latest version, keeps your settings and compose files
untouched, and rebuilds. Safe to run any time — it does nothing if you're
already up to date.

Admins also get an **Updates** card in Settings → Connections showing whether
you're behind, with a link to what changed.

To have it update itself on a schedule, see
[docs/scheduled-updates.md](docs/scheduled-updates.md).

## Desktop app

Native apps for macOS, Windows and Linux are on the
[releases page](https://github.com/j4ckxyz/navidrome-client-web/releases), and
linked from Settings → Connections. They use your system's built-in web view
rather than bundling a whole browser, so they stay small and start fast.

## Your privacy

- Your password is never stored — only a token derived from it, kept in your browser.
- Nothing is sent anywhere except your own server, with one exception: if you
  turn on the LRCLIB lyrics fallback, the artist, title, album and length of the
  current track are sent to look them up.
- Settings and themes stay in your browser.

## Development

Needs [Bun](https://bun.sh).

```bash
bun install
bun run dev        # http://localhost:5173
bun run build      # typecheck + production build
bun run typecheck
```

Built with SolidJS, Vite and TypeScript; Tauri for the desktop apps.

```
src/
  api/        server clients (Navidrome + Jellyfin), auth, types
  auth/       session, login
  player/     playback, queue, audio engine
  features/   shell, player UI, playlists, settings
  pages/      routed views
  ui/         shared components
  theme/      colour maths, presets, share codes
  settings/   schema + storage
```

Desktop builds: `bun run desktop:dev` / `bun run desktop:build`. Pushing a `v*`
tag builds and publishes installers for all three platforms.

More detail: [DEPLOYMENT.md](DEPLOYMENT.md) ·
[docs/windows-release.md](docs/windows-release.md) ·
[docs/desktop-updates.md](docs/desktop-updates.md)

## Not included

No mobile layouts, and no server administration — this is a player, not an admin
panel. (Admins can upload music and trigger scans, but that's the extent of it.)
