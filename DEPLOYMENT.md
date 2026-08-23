# Deployment Guide

This guide covers every way to run the Navidrome web client. It is written to be
followed step-by-step by a person **or** an automated agent. Each scenario lists
the exact files, environment variables, commands, and verification checks.

---

## Concepts (read this first)

The Docker image is a small [Bun](https://bun.sh) HTTP server (`server/index.ts`)
that serves the built web app and, optionally, proxies API calls to Navidrome.
It has exactly **two modes**, decided by one variable:

| Mode | Condition | What happens | CORS? | Uploads possible? |
|------|-----------|--------------|-------|-------------------|
| **Proxy** | `NAVIDROME_URL` is set | The server forwards `/rest/*`, `/auth/*`, `/api/*`, and `/upload` to that one Navidrome server. The browser only talks to this app. | No — same origin | Yes, if `MUSIC_DIR` is also mounted |
| **Direct** | `NAVIDROME_URL` is empty | No proxy. Each user types their **own** Navidrome URL at login; the browser talks to it directly. | Yes — each user's server must allow this origin | **Never** |

**Rule of thumb:**
- Hosting one client for **many people who each own a different Navidrome** → **Direct mode**.
- Running it for **yourself/your household against one server you control**, and you want browser uploads → **Proxy mode with `MUSIC_DIR`**.

### Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `NAVIDROME_URL` | _(empty)_ | e.g. `http://navidrome:4533` (same compose network) or `http://host.docker.internal:4533` (same host, Docker Desktop). Empty selects direct mode. |
| `MUSIC_DIR` | _(empty — uploads off)_ | Path **inside the container**. Only matters in proxy mode. Set it (e.g. `/music`) **and** mount that path to the folder Navidrome scans to enable uploads. Empty keeps uploads off. |
| `NAVIDROME_OG_USER` / `NAVIDROME_OG_PASS` | _(empty — previews off)_ | A **read-only** Navidrome account. Only matters in proxy mode. When both are set, shared links (`/album/:id`, `/playlist/:id`, `/artist/:id`) render rich OpenGraph/Twitter/Bluesky previews for crawlers. Empty keeps previews off. See [Link previews](#link-previews). |
| `PORT` | `8080` | Listen port inside the container. |
| `UPDATE_REPO` | `j4ckxyz/navidrome-client-web` | Repo the update check compares against. Point at your fork if you run one. |
| `UPDATE_BRANCH` | `main` | Branch the update check follows. |
| `SELF_UPDATE` | _(empty — off)_ | `1` lets admins apply updates from Settings. Needs the git checkout and the Docker socket mounted too; see [Updating](#updating). Off by default. |
| `REPO_DIR` | `/repo` | Where the git checkout is mounted when `SELF_UPDATE` is on. |
| `JELLYFIN_URL` | _(empty)_ | Jellyfin server used to confirm a caller is an admin. Only needed for `SELF_UPDATE` when Jellyfin is the backend. |

The image exposes `8080`; the compose files map host `8680 → 8080`.

---

## Scenario A — Public client, users bring their own server

**Goal:** one URL anyone can visit and log into **their own** Navidrome.
Uploads are intentionally impossible here (the host has no access to users' music).

1. Use `docker-compose.yml` and **leave `NAVIDROME_URL` empty** (the default).
   You do **not** need the music volume; remove or ignore it.

   ```bash
   bun run compose:up
   ```

   Or by hand:

   ```bash
   docker run -d -p 8680:8080 --name tonearm tonearm
   ```

2. Users open the site and enter their **own** server URL, username, and password.

3. <a id="direct-mode-cors"></a>**CORS (only relevant in direct mode).** Because the browser calls each
   user's Navidrome directly, that server must allow this app's origin, or the
   browser blocks the request (login appears to fail even with correct creds).
   Each user (or you, per server) handles this one of two ways:

   **Option 1 — Same origin via reverse proxy (most robust, no CORS at all).**
   Serve the app and Navidrome under the same scheme+host+port:

   ```nginx
   server {
       server_name music.example.com;
       location /        { proxy_pass http://tonearm:8080; }
       location /rest/   { proxy_pass http://navidrome:4533; }
       location /auth/   { proxy_pass http://navidrome:4533; }
       location /api/    { proxy_pass http://navidrome:4533; }
       location /share/  { proxy_pass http://navidrome:4533; }
   }
   ```
   Then users enter the **same URL they're viewing the app from** as the server URL.

   **Option 2 — Allow the origin on Navidrome.** Add these response headers
   (via Navidrome's reverse proxy) and make `OPTIONS` preflights return `204`:

   ```
   Access-Control-Allow-Origin: https://your-client-origin.example.com
   Access-Control-Allow-Headers: Content-Type, x-nd-authorization, x-nd-client-unique-id
   Access-Control-Allow-Methods: GET, POST, OPTIONS
   ```

**Verify:**
```bash
curl -s http://localhost:8680/api/config
# expect: {"proxyMode":false,"uploadEnabled":false,"version":"..."}
```

---

## Scenario B — Same device as Navidrome, with uploads

**Goal:** personal/household setup where admins can drag music into the browser.
This is the recommended setup — it unlocks every feature and needs no CORS.

### B1. All-in-one (also runs Navidrome for you)

Uses `docker-compose.full.yml`, which starts Navidrome **and** the client sharing
one music folder.

1. Point it at your library and start it:

   ```bash
   COMMIT_HASH=$(git rev-parse HEAD) MUSIC_HOST_DIR=/path/to/your/music docker compose -f docker-compose.full.yml up -d
   ```

2. Open `http://localhost:8680`. On first login, create your admin account.

3. As an admin you'll see an **upload button** in the sidebar footer. Drop in
   audio files, a whole folder, or a `.zip`; they're written into the library and
   a scan runs automatically.

### B2. Alongside an existing Navidrome on the same host

Uses `docker-compose.yml`. Mount the **same folder your existing Navidrome scans**.
First **uncomment the `volumes:` lines** in `docker-compose.yml`, then start it with
all three variables set (the `MUSIC_DIR` env is what actually switches uploads on):

```bash
NAVIDROME_URL=http://host.docker.internal:4533 \
MUSIC_DIR=/music \
MUSIC_HOST_DIR=/path/to/your/music \
bun run compose:up
```

> `host.docker.internal` resolves to the host from inside the container on Docker
> Desktop (macOS/Windows). On Linux, either add
> `--add-host=host.docker.internal:host-gateway`, use the host's LAN IP, or put
> both services on the same Docker network and use the service name.

**Critical:** `MUSIC_DIR` inside the container must map to the **exact directory
Navidrome reads**. The client writes files there; Navidrome then scans them. If
the paths differ, uploads land somewhere Navidrome never looks.

**Verify the full chain:**
```bash
# 1. Upload is advertised as enabled
curl -s http://localhost:8680/api/config
# expect: {"proxyMode":true,"uploadEnabled":true,...}

# 2. Proxy reaches Navidrome (auth error is fine — it proves connectivity)
curl -s "http://localhost:8680/rest/ping.view?f=json"
# expect a {"subsonic-response":...} envelope

# 3. Non-admin / unauthenticated uploads are rejected
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8680/upload
# expect: 403
```

---

## Scenario C — Separate machines/containers, no uploads

**Goal:** run the client somewhere other than Navidrome (different server, VM, or
just a separate container) and avoid CORS, but you don't need uploads.

Use proxy mode and simply **don't mount a music volume**:

```bash
NAVIDROME_URL=https://navidrome.example.com bun run compose:up
```

By hand:
```bash
docker run -d -p 8680:8080 \
  -e NAVIDROME_URL=https://navidrome.example.com \
  --name tonearm tonearm
```

Because `NAVIDROME_URL` is set, there's no CORS to deal with. Because no music
folder is mounted, `uploadEnabled` is `false` and the upload UI/endpoint stay off.

**Verify:**
```bash
curl -s http://localhost:8680/api/config
# expect: {"proxyMode":true,"uploadEnabled":false,...}
```

---

## How uploads work (and why they're safe to expose)

When a request hits `POST /upload`, the server:

1. Refuses immediately unless `MUSIC_DIR` **and** `NAVIDROME_URL` are configured.
2. Verifies the caller is an **admin** by asking the proxied Navidrome
   (`/api/user` via JWT, or Subsonic `getUser.view` → `adminRole`). Non-admins get `403`.
3. Writes audio files into `MUSIC_DIR`, preserving folder structure. For a `.zip`,
   it extracts only audio entries and skips junk (`__MACOSX`, dotfiles). Path
   traversal (`../`) is rejected.
4. Triggers a Navidrome rescan so new tracks appear.

The admin check runs **before** the upload body is parsed, so unauthorized callers
can't push large payloads. All three gates (operator mounts `MUSIC_DIR`, server
confirms admin, direct mode disables the route) must pass — which is why a public
direct-mode deployment can't be used to write files.

Supported audio extensions: `mp3, flac, ogg, opus, m4a, aac, wav, wv, ape, mpc,
wma, aiff, aif, dsf, dff`, plus `.zip` archives of them.

---

## Custom playlist covers

From a playlist's detail page you can upload a custom cover photo (hover the cover
→ **Cover photo**, or the "…" menu). This uses Navidrome's native
`POST /api/playlist/{id}/image` endpoint, so the image is stored **on the server**
and syncs to every client — including Navidrome's own UI.

- Requires a **password (native) login**; Subsonic-token-only logins don't get a
  JWT, so the button is hidden for them.
- Requires **edit permission** on the playlist (owner or admin); otherwise the
  server returns `403` and the client shows a message.
- Accepts JPEG, PNG, GIF, or WebP.
- Works in both proxy and direct mode (in direct mode the target server must allow
  this origin via CORS, like every other API call).

---

## Downloads

Albums, playlists, and individual songs have a **Download…** action (the "…" menu
or right-click on a track). You pick a quality:

- **Original** — the untranscoded source files. A song downloads its file; an
  album/playlist downloads a ZIP that **Navidrome** assembles. Works in **any**
  mode (proxy or direct).
- **Opus 192k / MP3 320k / MP3 128k** — transcoded by Navidrome's transcoder.
  - A **single song** transcodes and downloads anywhere.
  - A whole **album/playlist** is transcoded and zipped by this app's backend
    (`POST /download/zip`), so it streams to disk without buffering. This needs
    **proxy mode** (`NAVIDROME_URL` set); in direct mode only Original is offered.

Files are named sensibly (`01 Title.opus` inside `Artist - Album.zip`). Lossy
formats must be enabled in Navidrome's transcoding settings (the defaults cover
Opus and MP3).

---

## Link previews

<a id="link-previews"></a>When someone shares a link to an album, playlist, or
artist, crawlers (Twitter/X, Discord, Slack, Facebook, Bluesky, Mastodon, …) can
show a rich card with the cover art and a proper title — rendered **server-side**
so it works without JavaScript.

**Enable it (proxy mode only):**

1. In Navidrome, create a dedicated **read-only** user (any non-admin account).
2. Set `NAVIDROME_OG_USER` and `NAVIDROME_OG_PASS` to that account.

```bash
# verify it's on
curl -s http://localhost:8680/api/config
# expect: {"proxyMode":true,...,"linkPreviews":true,...}
```

How it behaves:

- **Crawlers** requesting `/album/:id` etc. get an `index.html` with `og:*` /
  `twitter:*` tags. The cover is served via a public `/og/cover/:id` proxy (it
  fetches with the read-only account, so anonymous crawlers can load the image).
- **Humans** still get the normal app and the **login screen** — previews never
  expose playback or bypass auth; they only reveal a title and cover for whatever
  ID is in the link.
- With the variables empty, the server behaves exactly as before (plain shell,
  generic `Navidrome` title).

---

## Updating

### Checking from the app

Admins see an **Updates** card in Settings → Connections. It compares what the server
is running against GitHub, shows how far behind you are, and links to the diff. It
checks on load and every six hours by default; the toggle is on the card.

The check is read-only and needs no configuration. It caches for 15 minutes and is
single-flighted, so a busy instance can't burn through GitHub's unauthenticated rate
limit.

Two identities are compared, because one is often missing:

| | Where it comes from | When it's absent |
|---|---|---|
| **Commit** | the `COMMIT_HASH` build arg | a plain `docker compose up --build`, which defaults it to empty — `.git` is excluded from the build context, so the image can't work it out either |
| **Release version** | `package.json`, copied into the image | never |

If the card says **"Running: unknown"**, the image was built without the build arg.
The version comparison still works, so the check is accurate either way — and
`bun run update` always passes the commit, so one run through the updater fixes the
display permanently. To fix it without updating, rebuild with:

```bash
COMMIT_HASH=$(git rev-parse HEAD) docker compose up -d --build
# or just: bun run compose:up
```

By default the card then shows you the command to run — the shipped container has no
git checkout and no Docker socket, so it genuinely cannot rebuild itself.

### Scheduled updates (no extra privilege)

The recommended way to keep an instance current. `bun run update` is fully
non-interactive and exits without touching anything when you're already up to date,
so it can run on a timer. Crucially the **host** runs it, not the container — so
nothing needs the Docker socket, and the app gets no privilege it didn't already
have.

`--quiet` suppresses the progress chatter, printing only when something actually
changed or failed, which keeps a nightly job out of your logs unless it matters.

**systemd** (put the checkout path in both files):

```ini
# /etc/systemd/system/tonearm-update.service
[Unit]
Description=Update Tonearm
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/tonearm
ExecStart=/usr/local/bin/bun run update --quiet
```

```ini
# /etc/systemd/system/tonearm-update.timer
[Unit]
Description=Update Tonearm nightly

[Timer]
OnCalendar=daily
# Spread the load off the hour, and catch up after downtime.
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tonearm-update.timer
systemctl list-timers tonearm-update.timer   # confirm it's scheduled
sudo systemctl start tonearm-update.service  # run once now to test
journalctl -u tonearm-update.service         # see what it did
```

**cron**, if you'd rather:

```cron
# Nightly at 04:17. Absolute path to bun — cron's PATH is minimal.
17 4 * * * cd /srv/tonearm && /usr/local/bin/bun run update --quiet
```

An update rebuilds the image and restarts the container, so playback stops and
listeners need to reload the page. Schedule it for a time nobody is listening.

### One-click updates (opt-in)

To let the button do it for you, give the container what the updater needs and turn
the flag on:

```yaml
services:
  tonearm:
    environment:
      SELF_UPDATE: "1"
      # Only needed when Jellyfin is the backend — used to confirm the caller is
      # a Jellyfin administrator before running anything.
      JELLYFIN_URL: http://jellyfin:8096
    volumes:
      - .:/repo                                   # the checkout, including .git
      - /var/run/docker.sock:/var/run/docker.sock # so it can rebuild itself
```

> **Weigh this up before enabling it.** Mounting the Docker socket gives the
> container root-equivalent control of the Docker host — that is the price of a
> container rebuilding itself, and it's why this is off by default. Enable it only on
> a deployment you trust, and don't expose such an instance publicly.

The endpoint is defended three ways regardless: it's inert unless `SELF_UPDATE` is
set, it requires a caller your configured server confirms is an **admin**, and it
refuses if the checkout or Docker aren't actually reachable. The command it runs is a
fixed argv (`bun run scripts/update.ts`) with no shell and nothing from the request
in it.

Applying an update restarts the container, so the request is usually cut off
mid-flight; the UI expects that and re-checks the version once it's back.

### From the command line

From a git checkout of this repo, run:

```bash
bun run update
```

It works in three safe steps:

1. **Inspects your setup first** and prints a plan before changing anything. It reads
   the exact Compose project and compose file that created your running `tonearm`
   container, so it always rebuilds *your* deployment — full stack or client-only —
   rather than guessing.
2. **Updates the source** from GitHub (`origin`) if there's a newer version,
   **without touching your local `docker-compose*.yml` or `.env`** files.
3. **Rebuilds in place** with `up -d --build` against your own project only.

Because it only ever acts on the project that owns `tonearm` and never removes
a `navidrome` container, it **cannot touch a Navidrome you run separately**, and the
"container name already in use" conflict is impossible. The command is cross-platform
(Windows, macOS, Linux) and supports Docker Compose v2 (`docker compose`) and v1
(`docker-compose`). It's safe to re-run: if you're already on the latest commit and
the container matches, it exits without rebuilding.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Login fails in direct mode, creds are correct | CORS not configured on the target Navidrome | See [CORS](#direct-mode-cors), or switch to proxy mode |
| No upload button as an admin | Not in proxy mode, or `MUSIC_DIR` not mounted | `curl /api/config` — need `uploadEnabled:true`; mount the music volume + set `NAVIDROME_URL` |
| Upload succeeds but tracks don't appear | `MUSIC_DIR` ≠ the folder Navidrome scans, or scan disabled | Make both mounts point at the same host folder; check Navidrome logs / trigger a manual scan |
| `POST /upload` returns `403` | Caller isn't an admin on the proxied server | Log in as an admin of that Navidrome |
| `POST /upload` returns `503` | `MUSIC_DIR`/`NAVIDROME_URL` not set | You're in direct mode or didn't mount music — uploads are off by design |
| `docker compose` can't pull images on macOS | Docker Desktop credential helper not on `PATH` | `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` |

---

## File reference

| File | Purpose |
|------|---------|
| `docker-compose.yml` | The client only. Defaults to direct mode; set `NAVIDROME_URL` for proxy mode. Music volume + `MUSIC_DIR` enable uploads. |
| `docker-compose.full.yml` | All-in-one: Navidrome **and** the client sharing a music folder. |
| `Dockerfile` | Builds the static bundle and the Bun runtime image. |
| `server/index.ts` | The Bun server: static hosting, API proxy, `/upload`, `/api/config`. |
| `scripts/update.ts` | Cross-platform updater run by `bun run update` (pulls latest, preserves config, rebuilds). |
