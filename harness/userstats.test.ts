// getUserStats against a mock Jellyfin library.
//
// The counting endpoints are easy; the part worth testing is the play walk —
// it pages, it relies on a play-count-descending sort to stop early, and it has
// to survive a server that rejects one of the sub-queries. All three are checked
// here against a server that implements the /Items semantics the client depends
// on (Filters, SortBy/SortOrder, StartIndex/Limit, TotalRecordCount).

import { installShims } from "./shims";
installShims();

const { JellyfinClient } = await import("~/api/jellyfin");
import type { ServerCredentials } from "~/api/credentials";

const TICKS = 10_000_000;

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

interface MockItem {
  Id: string;
  Name: string;
  Type: string;
  RunTimeTicks: number;
  UserData: { PlayCount: number; IsFavorite: boolean; Played: boolean; LastPlayedDate?: string };
}

function audio(id: string, plays: number, seconds: number, favorite = false): MockItem {
  return {
    Id: id,
    Name: `Track ${id}`,
    Type: "Audio",
    RunTimeTicks: seconds * TICKS,
    UserData: {
      PlayCount: plays,
      IsFavorite: favorite,
      Played: plays > 0,
      LastPlayedDate: plays > 0 ? "2026-08-01T12:00:00.0000000Z" : undefined,
    },
  };
}

// 1200 tracks so the 500-per-page walk has to page; only the first 700 have
// plays, so the "stop at the first zero" shortcut is exercised too.
const PLAYED = 700;
const TOTAL = 1200;
const tracks: MockItem[] = [];
for (let i = 0; i < TOTAL; i++) {
  // Descending play counts, so the server's PlayCount sort is a no-op on this
  // array and the client's assumptions are tested rather than the mock's.
  const plays = i < PLAYED ? PLAYED - i : 0;
  tracks.push(audio(`song-${i}`, plays, 200, i % 10 === 0));
}
const expectedPlays = tracks.reduce((sum, t) => sum + t.UserData.PlayCount, 0);
const expectedSeconds = expectedPlays * 200;

const albums: MockItem[] = [
  { Id: "al-1", Name: "Album One", Type: "MusicAlbum", RunTimeTicks: 0, UserData: { PlayCount: 40, IsFavorite: true, Played: true } },
  { Id: "al-2", Name: "Album Two", Type: "MusicAlbum", RunTimeTicks: 0, UserData: { PlayCount: 10, IsFavorite: false, Played: true } },
  { Id: "al-3", Name: "Album Three", Type: "MusicAlbum", RunTimeTicks: 0, UserData: { PlayCount: 0, IsFavorite: false, Played: false } },
];

const artists: MockItem[] = [
  { Id: "ar-1", Name: "Artist One", Type: "MusicArtist", RunTimeTicks: 0, UserData: { PlayCount: 90, IsFavorite: true, Played: true } },
  { Id: "ar-2", Name: "Artist Two", Type: "MusicArtist", RunTimeTicks: 0, UserData: { PlayCount: 0, IsFavorite: false, Played: false } },
];

// Every walk page the server is asked for, by StartIndex.
let walkStarts: number[] = [];

// When set, the Artists endpoint 500s — standing in for a server that doesn't
// support the sort or filter being asked for.
let breakArtists = false;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const q = (name: string) => url.searchParams.get(name);

    if (url.pathname === "/Artists/AlbumArtists") {
      if (breakArtists) return new Response("nope", { status: 500 });
      let rows = artists;
      if (q("Filters") === "IsFavorite") rows = rows.filter((a) => a.UserData.IsFavorite);
      if (q("Filters") === "IsPlayed") rows = rows.filter((a) => a.UserData.Played);
      if (q("SortBy") === "PlayCount") {
        rows = [...rows].sort((a, b) => b.UserData.PlayCount - a.UserData.PlayCount);
      }
      const total = rows.length;
      const limit = Number(q("Limit") ?? rows.length);
      return Response.json({ Items: rows.slice(0, limit), TotalRecordCount: total });
    }

    if (url.pathname === "/Items") {
      const type = q("IncludeItemTypes");
      let rows: MockItem[] = type === "MusicAlbum" ? albums : tracks;
      const filter = q("Filters");
      if (filter === "IsPlayed") rows = rows.filter((r) => r.UserData.Played);
      if (filter === "IsFavorite") rows = rows.filter((r) => r.UserData.IsFavorite);

      if (q("SortBy") === "PlayCount") {
        rows = [...rows].sort((a, b) =>
          q("SortOrder") === "Descending"
            ? b.UserData.PlayCount - a.UserData.PlayCount
            : a.UserData.PlayCount - b.UserData.PlayCount,
        );
      }

      const total = rows.length;
      const start = Number(q("StartIndex") ?? 0);
      const limitRaw = q("Limit");
      const limit = limitRaw === null ? rows.length : Number(limitRaw);
      // The play walk is the only Audio query that pages with a 500 limit.
      if (type === "Audio" && limit === 500) walkStarts.push(start);
      return Response.json({
        Items: rows.slice(start, start + limit),
        TotalRecordCount: total,
      });
    }

    return new Response(null, { status: 204 });
  },
});

const creds: ServerCredentials = {
  serverType: "jellyfin",
  serverUrl: `http://localhost:${server.port}`,
  username: "tester",
  authMethod: "jellyfin",
  subsonicSalt: "",
  subsonicToken: "",
  accessToken: "token",
  userId: "user-1",
  deviceId: "device-1",
  savedAt: Date.now(),
};

console.log("getUserStats — Jellyfin");
const jf = new JellyfinClient(creds);
const stats = await jf.getUserStats();

eq("distinct tracks played", stats.tracksPlayed, PLAYED);
eq("total plays summed across pages", stats.totalPlays, expectedPlays);
eq("listening time derived from plays", stats.listeningSeconds, expectedSeconds);
eq("not flagged approximate under the page cap", stats.approximate, false);
eq("albums played", stats.albumsPlayed, 2);
eq("favourite songs", stats.favoriteSongs, tracks.filter((t) => t.UserData.IsFavorite).length);
eq("favourite albums", stats.favoriteAlbums, 1);
eq("artists played", stats.artistsPlayed, 1);
eq("favourite artists", stats.favoriteArtists, 1);
eq("top songs are the most played, in order", stats.topSongs?.slice(0, 3).map((s) => s.id), [
  "song-0",
  "song-1",
  "song-2",
]);
eq("top songs carry their play count", stats.topSongs?.[0]?.playCount, PLAYED);
eq("top albums are play-sorted", stats.topAlbums?.map((a) => a.id), ["al-1", "al-2"]);
eq("never-played artists are dropped from the leaderboard", stats.topArtists?.map((a) => a.id), [
  "ar-1",
]);
eq("top artists carry their play count", stats.topArtists?.[0]?.playCount, 90);
check("last played date reported", !!stats.lastPlayed, stats.lastPlayed);

// The walk sorts descending and stops at the first zero, so it should never
// request the pages beyond the played tracks: 2 pages here, not the 3 a naive
// walk of all 1200 tracks would take.
eq("walk pages requested, stopping at the first unplayed track", walkStarts, [0, 500]);

console.log("\nresilience — the Artists endpoint fails");
breakArtists = true;
walkStarts = [];
const degraded = await new JellyfinClient(creds).getUserStats();
eq("track figures survive", degraded.totalPlays, expectedPlays);
eq("artist count is absent rather than wrong", degraded.artistsPlayed, undefined);
eq("favourite artists absent", degraded.favoriteArtists, undefined);
eq("top artists absent", degraded.topArtists, undefined);
eq("album figures still present", degraded.albumsPlayed, 2);

server.stop(true);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
