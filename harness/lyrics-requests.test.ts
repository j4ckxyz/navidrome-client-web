// How many round trips a lyrics lookup costs, against a mock Subsonic server
// that records every request.
//
// This is the thing that made lyrics feel slow: the miss path — a library with
// no lyrics tags, which is most of them — walked three endpoints one after
// another before the LRCLIB fallback even started. The counts below are the
// regression guard, since nothing about the returned lyrics would change if
// they went back to being serial.

import { installShims } from "./shims";
installShims();

const { SubsonicClient } = await import("~/api/client");
import type { ServerCredentials } from "~/api/credentials";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), a);

// Endpoints hit, in order, plus how many were in flight at once.
let hits: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

// What the server pretends to have. Flipped per scenario.
let hasStructured = false;
let hasPlain = false;

const ENVELOPE = (body: Record<string, unknown>) => ({ "subsonic-response": { status: "ok", ...body } });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const endpoint = url.pathname.split("/").pop() ?? "";
    hits.push(endpoint);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Hold the response briefly so genuinely parallel requests overlap and a
    // serial implementation can't accidentally look concurrent.
    await Bun.sleep(60);
    inFlight--;

    if (endpoint === "getLyricsBySongId.view") {
      return Response.json(
        ENVELOPE({
          lyricsList: hasStructured
            ? { structuredLyrics: [{ synced: true, line: [{ start: 0, value: "structured" }] }] }
            : { structuredLyrics: [] },
        }),
      );
    }
    if (endpoint === "getLyrics.view") {
      return Response.json(ENVELOPE({ lyrics: hasPlain ? { value: "plain words" } : {} }));
    }
    if (endpoint === "getSong.view") {
      return Response.json(ENVELOPE({ song: { id: "s1", title: "Title", artist: "Artist" } }));
    }
    return Response.json(ENVELOPE({}));
  },
});

const creds: ServerCredentials = {
  serverType: "navidrome",
  serverUrl: `http://localhost:${server.port}`,
  username: "tester",
  authMethod: "subsonic",
  subsonicSalt: "salt",
  subsonicToken: "token",
  savedAt: Date.now(),
};
const api = new SubsonicClient(creds);
const HINTS = { artist: "Artist", title: "Title" };

function reset(structured: boolean, plain: boolean): void {
  hits = [];
  maxInFlight = 0;
  inFlight = 0;
  hasStructured = structured;
  hasPlain = plain;
}

console.log("Nothing on the server — the common case, and the one that was slow");
reset(false, false);
let started = performance.now();
let out = await api.getLyrics("s1", HINTS);
let elapsed = performance.now() - started;
eq("returns nothing", out, []);
eq("asks both lyrics endpoints and nothing else", [...hits].sort(), [
  "getLyrics.view",
  "getLyricsBySongId.view",
]);
check("no redundant getSong round trip", !hits.includes("getSong.view"), hits);
check("both asked at once, not one after the other", maxInFlight === 2, maxInFlight);
check(
  `one round trip's worth of waiting, not two (${Math.round(elapsed)}ms)`,
  elapsed < 110,
  Math.round(elapsed),
);

console.log("\nServer has structured lyrics");
reset(true, false);
out = await api.getLyrics("s1", HINTS);
eq("prefers the structured set", out.length === 1 && out[0].synced, true);

console.log("\nServer has only plain lyrics");
reset(false, true);
out = await api.getLyrics("s1", HINTS);
eq("falls back to the plain text", out[0]?.line[0]?.value, "plain words");
eq("still unsynced", out[0]?.synced, false);

console.log("\nNo hints — the caller didn't know the artist/title");
reset(false, true);
out = await api.getLyrics("s1");
eq("still finds the plain lyrics", out[0]?.line[0]?.value, "plain words");
check("pays for the song lookup it now needs", hits.includes("getSong.view"), hits);

server.stop(true);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
