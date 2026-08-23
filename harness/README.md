# Headless harnesses

Runtime tests for things `tsc` can't check and Playwright can't easily reach —
protocol-level behaviour against a mock server, with the real app modules loaded
unmodified.

## `remote.harness.ts` — Jellyfin remote control

```sh
bun run test:remote
```

Stands up a mock Jellyfin (`mockJellyfin.ts`) with the endpoints remote control
touches plus a real `/socket`, then drives the actual `jellyfinSocket`,
`remoteSessions`, `player/store` and `JellyfinClient` against it. Covers both
directions: discovering and driving another device, and being driven by one.

Two things to know if you touch this:

- **`--conditions=browser` is required** (it's in the npm script). Bun otherwise
  resolves solid-js's `node` export condition, which is the SSR build — where
  `createEffect` is a no-op and nothing reactive runs.
- **`shims.ts` must be imported before any app module.** Several modules read
  `localStorage` and construct `Audio` elements at import time.

## Live harnesses

These talk to a **real Jellyfin server** using `JELLYFIN_URL`,
`JELLYFIN_USERNAME` and `JELLYFIN_PASSWORD` from `.env`. They are diagnostics,
not CI — they touch real playback.

| Script | What it does |
|---|---|
| `bun run test:live:self` | Logs in, opens the socket, reads our own session back. Confirms the app registers as controllable (`SupportsRemoteControl=true`). |
| `bun run test:live:sessions` | Raw `/Sessions` dump with the picker's filter reasoning per session. **Start here when a device doesn't appear.** |
| `bun run test:live` | Observe-only: lists controllable devices and mirrors the first one. `--drive` also sends transport commands. |
| `bun run test:live:target` + `bun run test:live:control` | Full round trip. Run the target first (it plays real tracks and stays alive ~2 min), then the controller in another shell — it discovers the target through the real server and drives it. |

### If no devices show up

Jellyfin only lists a session as controllable when that client has POSTed
`/Sessions/Capabilities/Full` with `SupportsMediaControl: true`. Many clients
never do — `test:live:sessions` shows `SupportsRemoteControl=false` for those,
and Jellyfin's own `ControllableByUserId` filter excludes them. That's the
client's choice, not something this app can work around.
