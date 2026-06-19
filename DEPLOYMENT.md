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
| `PORT` | `8080` | Listen port inside the container. |

The image exposes `8080`; the compose files map host `8680 → 8080`.

---

## Scenario A — Public client, users bring their own server

**Goal:** one URL anyone can visit and log into **their own** Navidrome.
Uploads are intentionally impossible here (the host has no access to users' music).

1. Use `docker-compose.yml` and **leave `NAVIDROME_URL` empty** (the default).
   You do **not** need the music volume; remove or ignore it.

   ```bash
   docker compose up -d
   ```

   Or by hand:

   ```bash
   docker run -d -p 8680:8080 --name navidrome-web navidrome-client-web
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
       location /        { proxy_pass http://navidrome-web:8080; }
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
   MUSIC_HOST_DIR=/path/to/your/music docker compose -f docker-compose.full.yml up -d
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
docker compose up -d
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
NAVIDROME_URL=https://navidrome.example.com docker compose up -d
```

By hand:
```bash
docker run -d -p 8680:8080 \
  -e NAVIDROME_URL=https://navidrome.example.com \
  --name navidrome-web navidrome-client-web
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
