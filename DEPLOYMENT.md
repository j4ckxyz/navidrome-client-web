# Deployment

Everything beyond the quick start in the [README](README.md). Jump to what you
need — you don't have to read this top to bottom.

- [The one setting that matters](#the-one-setting-that-matters)
- [All the settings](#all-the-settings)
- [Uploading music](#uploading-music)
- [Hosting for other people](#hosting-for-other-people)
- [Link previews](#link-previews)
- [Updating](#updating)
- [Something's wrong](#somethings-wrong)

## The one setting that matters

Tonearm ships as a small web server in a Docker container. `NAVIDROME_URL`
decides how it behaves, and everything else follows from it.

**If you set it** ("proxy mode") — Tonearm passes requests through to that one
server. Your browser only ever talks to Tonearm, so there's nothing to configure
about cross-origin requests, and uploads become possible.

**If you leave it empty** ("direct mode") — Tonearm doesn't touch your music
server at all. Each person types their own server URL when they log in, and their
browser talks to it directly. This is how you host one site for lots of people.
Uploads are impossible here by design.

Jellyfin always connects directly, whichever mode you're in.

## All the settings

Set these as environment variables in `docker-compose.yml` or on the command
line. Every one is optional.

| Setting | What it does |
|---|---|
| `NAVIDROME_URL` | Your Navidrome server, e.g. `http://navidrome:4533`. Empty means everyone brings their own. |
| `MUSIC_DIR` | Turns on browser uploads. See [Uploading music](#uploading-music). |
| `PORT` | Port inside the container. Default `8080`; the compose files publish it on `8680`. |
| `NAVIDROME_OG_USER` / `NAVIDROME_OG_PASS` | A read-only account used for [link previews](#link-previews). |
| `SELF_UPDATE` | Set to `1` to let admins install updates from the Settings page. See [Updating](#updating). |
| `JELLYFIN_URL` | Only needed with `SELF_UPDATE` when Jellyfin is your server — used to check the person clicking is an admin. |
| `UPDATE_REPO` / `UPDATE_BRANCH` | Change these if you run your own fork. |
| `REPO_DIR` | Where your checkout is mounted for `SELF_UPDATE`. Default `/repo`. |

To check what's actually switched on:

```bash
curl -s http://localhost:8680/api/config
```

## Uploading music

Admins get an upload button in the sidebar that accepts files, whole folders, or
a ZIP. It writes them into your library and tells Navidrome to scan.

It's off until you do all three of these:

1. Set `NAVIDROME_URL` (uploads only work in proxy mode).
2. Set `MUSIC_DIR=/music`.
3. Mount your music folder at that same path, by uncommenting the `volumes:`
   lines in `docker-compose.yml`.

```bash
NAVIDROME_URL=http://host.docker.internal:4533 \
MUSIC_DIR=/music \
MUSIC_HOST_DIR=/path/to/your/music \
bun run compose:up
```

**The folder has to be the one Navidrome scans.** If the paths differ, uploads
land somewhere Navidrome never looks and nothing appears.

Check it worked — `uploadEnabled` should be `true`:

```bash
curl -s http://localhost:8680/api/config
```

Uploading also requires being an admin on your music server; Tonearm asks the
server before writing anything, so a public deployment can't be used to dump
files on your disk.

Accepts `mp3, flac, ogg, opus, m4a, aac, wav, wv, ape, mpc, wma, aiff, aif, dsf,
dff`, and ZIPs of them.

## Hosting for other people

Leave `NAVIDROME_URL` empty and each person enters their own server at login.

The catch: browsers block a page on your domain from calling a server on someone
else's domain unless that server says it's allowed. Without this, logging in just
fails even with the right password. There are two ways to solve it.

**Option 1 — put both behind one address (no CORS at all).** If you control both,
serve them from the same hostname:

```nginx
server {
    server_name music.example.com;
    location /       { proxy_pass http://tonearm:8080; }
    location /rest/  { proxy_pass http://navidrome:4533; }
    location /auth/  { proxy_pass http://navidrome:4533; }
    location /api/   { proxy_pass http://navidrome:4533; }
    location /share/ { proxy_pass http://navidrome:4533; }
}
```

People then enter the same address they're already looking at.

**Option 2 — let the music server allow your site.** Each person adds these
headers to their Navidrome, and makes `OPTIONS` requests return `204`:

```
Access-Control-Allow-Origin: https://your-site.example.com
Access-Control-Allow-Headers: Content-Type, x-nd-authorization, x-nd-client-unique-id
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

Jellyfin needs [the same thing](https://jellyfin.org/docs/general/networking/).

## Link previews

When someone shares a link to an album, playlist or artist, this makes Discord,
Slack, Bluesky and the rest show the cover art and title instead of a bare URL.

Proxy mode only. Create a **read-only** (non-admin) account on your Navidrome,
then set:

```
NAVIDROME_OG_USER=preview
NAVIDROME_OG_PASS=...
```

Only the title and cover for whatever's in the link are exposed — people still
hit the login screen as normal.

## Updating

### The normal way

From the folder you installed to:

```bash
bun run update
```

It reads the compose setup that actually created your running container, so it
rebuilds *your* deployment and can't disturb a Navidrome you run separately. Your
`docker-compose.yml` and `.env` are left exactly as they are. Run it whenever —
if you're already current it exits without doing anything.

By hand, the equivalent is:

```bash
git pull
bun run compose:up
```

### Checking from the app

Admins see an **Updates** card in Settings → Connections. It compares what you're
running against GitHub and links to what changed. It checks on load and every six
hours; both are toggles on the card.

It notices two different things: a new release, and changes merged since the
release you're on. The second is the normal case between version bumps, and
`bun run update` installs either.

### On a schedule

See [docs/scheduled-updates.md](docs/scheduled-updates.md) for ready-made recipes
for Linux, macOS and Windows. Letting your own machine run the updater on a timer
is safer than the one-click option below, because Tonearm gains no extra power.

Note that an update restarts the container, so anyone listening will need to
reload the page. Pick a quiet hour.

### One-click updates from Settings (optional)

Add to `docker-compose.yml`:

```yaml
environment:
  SELF_UPDATE: "1"
volumes:
  - .:/repo
  - /var/run/docker.sock:/var/run/docker.sock
```

> **Know what this costs.** Mounting the Docker socket gives the container
> root-level control of the machine it's running on. Only do this on a private
> deployment you trust. Tonearm still requires the person clicking to be an admin
> on your music server, and refuses if the mounts aren't really there. Watchtower
> and similar tools need the same socket, so they aren't a way around it — a
> scheduled `bun run update` on the host is.

## Something's wrong

| What you see | Why | Fix |
|---|---|---|
| Login fails, password is definitely right | Direct mode, and the music server isn't allowing your site | [Hosting for other people](#hosting-for-other-people), or set `NAVIDROME_URL` |
| No upload button, and I am an admin | Not in proxy mode, or music isn't mounted | `curl /api/config` — you need `uploadEnabled:true` |
| Upload works but tracks never appear | `MUSIC_DIR` isn't the folder Navidrome scans | Point both at the same host folder, then rescan |
| Upload returns `403` | You aren't an admin on the music server | Log in as one |
| Upload returns `503` | Uploads are off | Set `NAVIDROME_URL` **and** `MUSIC_DIR`, and mount the folder |
| Updates card says "Running: unknown" | Image built without recording its version | Harmless — updates are still detected. `bun run update` fixes it |
| `docker compose` can't pull images on macOS | Docker Desktop isn't on your `PATH` | `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` |

## What each file does

| File | Purpose |
|---|---|
| `docker-compose.yml` | Tonearm on its own. |
| `docker-compose.full.yml` | Tonearm **and** Navidrome together, sharing a music folder. |
| `Dockerfile` | Builds the image. |
| `server/index.ts` | The web server: serves the app, proxies your music server, handles uploads. |
| `scripts/update.ts` | What `bun run update` runs. |
