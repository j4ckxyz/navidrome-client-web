// Lyrics from LRCLIB, used when your own server has none.
//
// LRCLIB (https://lrclib.net) is a free, open, no-account lyrics database built
// for exactly this — self-hosted music players whose libraries have no lyrics
// tags. Around three million tracks, most with time-synced LRC, MIT licensed
// and run without ads or profit. It is what the third-party iOS clients use.
//
// This is the app's only outbound call to a service that isn't your own server,
// so it is a setting and it is off unless you turn it on. What leaves the
// browser is the artist, title, album and duration of the track being played —
// no account, no identifier, nothing that ties the request to you.

import type { LyricsLine, Song, StructuredLyrics } from "~/api/types";
import { APP_NAME, APP_VERSION } from "~/lib/branding";
import { log } from "~/lib/log";

const BASE = "https://lrclib.net/api";

// LRCLIB asks clients to identify themselves so they can contact maintainers
// about misbehaving traffic rather than just blocking it.
const USER_AGENT = `${APP_NAME}/${APP_VERSION} (https://github.com/j4ckxyz/navidrome-client-web)`;

// A search hit is only accepted if its length is within this of the local file.
// Different masters, live versions and radio edits share a title and artist, so
// duration is the only cheap signal that the timings will actually line up.
const DURATION_TOLERANCE_S = 5;

const REQUEST_TIMEOUT_MS = 8_000;

interface LrclibTrack {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

// `[mm:ss.xx] text`, occasionally with hours or two-digit centiseconds. Metadata
// tags like [ar: …] use the same brackets but a non-numeric first field, so the
// numeric groups are what separate a timestamp from a tag.
const LRC_LINE = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]\s?(.*)$/;

export function parseLrc(text: string): LyricsLine[] {
  const out: LyricsLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = LRC_LINE.exec(raw.trim());
    if (!match) continue;
    const [, mm, ss, frac, value] = match;
    // Two digits mean centiseconds, three mean milliseconds.
    const fraction = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
    const start = Number(mm) * 60_000 + Number(ss) * 1_000 + fraction;
    // Blank lines are kept: they're the instrumental gaps, and dropping them
    // makes the highlight jump ahead of the music.
    out.push({ start, value: value.trim() });
  }
  return out;
}

function plainToLines(text: string): LyricsLine[] {
  return text
    .split(/\r?\n/)
    .map((value) => ({ value: value.trim() }))
    .filter((line, i, all) => line.value || (i > 0 && i < all.length - 1));
}

function toStructured(track: LrclibTrack): StructuredLyrics | null {
  if (track.instrumental) {
    return {
      synced: false,
      line: [{ value: "♪ Instrumental" }],
      displayArtist: track.artistName,
      displayTitle: track.trackName,
    };
  }
  if (track.syncedLyrics) {
    const line = parseLrc(track.syncedLyrics);
    if (line.length > 0) {
      return {
        synced: true,
        line,
        displayArtist: track.artistName,
        displayTitle: track.trackName,
      };
    }
  }
  if (track.plainLyrics) {
    const line = plainToLines(track.plainLyrics);
    if (line.length > 0) {
      return {
        synced: false,
        line,
        displayArtist: track.artistName,
        displayTitle: track.trackName,
      };
    }
  }
  return null;
}

async function request<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  try {
    const res = await fetch(url.toString(), {
      headers: { "Lrclib-Client": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 404 is the ordinary "we don't have it" answer, not a failure worth noise.
    if (res.status === 404) return null;
    if (!res.ok) {
      log.warn("lrclib", `HTTP ${res.status} for ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn("lrclib", "request failed", err);
    return null;
  }
}

export async function fetchLyricsFromLrclib(song: Song): Promise<StructuredLyrics | null> {
  const artist = (song.artist ?? "").trim();
  const title = (song.title ?? "").trim();
  if (!artist || !title) return null;

  // Exact lookup first: with album and duration, LRCLIB returns the record whose
  // timings match this specific release rather than a same-titled other one.
  const exact = await request<LrclibTrack>("/get", {
    artist_name: artist,
    track_name: title,
    album_name: (song.album ?? "").trim(),
    duration: song.duration ? String(Math.round(song.duration)) : "",
  });
  if (exact) {
    const structured = toStructured(exact);
    if (structured) {
      log.debug("lrclib", `exact match for ${artist} — ${title}`);
      return structured;
    }
  }

  // Fall back to search, which ignores album and duration. Tags in a
  // self-hosted library are often not what the database has (a compilation
  // album name, a slightly different duration), and that shouldn't mean no
  // lyrics — but the result has to be checked rather than trusted.
  const results = await request<LrclibTrack[]>("/search", {
    artist_name: artist,
    track_name: title,
  });
  if (!Array.isArray(results) || results.length === 0) return null;

  const target = song.duration ?? 0;
  const usable = results.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental);

  const best = target
    ? usable
        .filter((r) => Math.abs((r.duration ?? 0) - target) <= DURATION_TOLERANCE_S)
        // Prefer synced over plain, then whichever is closest in length.
        .sort((a, b) => {
          const synced = Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
          if (synced !== 0) return synced;
          return Math.abs((a.duration ?? 0) - target) - Math.abs((b.duration ?? 0) - target);
        })[0]
    : // No local duration to check against: only a synced result is worth
      // showing, since an unverifiable plain match is as likely wrong as right.
      usable.find((r) => r.syncedLyrics);

  if (!best) return null;
  log.debug("lrclib", `search match for ${artist} — ${title} (${best.albumName})`);
  return toStructured(best);
}
