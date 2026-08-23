// One lyrics lookup, shared by everything that shows lyrics.
//
// The side panel and the full-screen player both want the same words for the
// same track. They used to ask separately, under different query keys, which
// meant two independent trips to the server for one song — and only the panel
// ever consulted LRCLIB, so the full-screen player showed nothing at all for a
// library with no lyrics tags. Going through here they share one cache entry:
// whichever opens first pays, the other is instant, and both get the fallback.
//
// Your server is always asked first. LRCLIB is only consulted when the server
// has nothing *and* you've opted in — see features/lyrics/lrclib for what that
// sends.

import { client } from "~/auth/session";
import { queryClient, qk } from "~/lib/query";
import { settings } from "~/settings/store";
import { fetchLyricsFromLrclib } from "~/features/lyrics/lrclib";
import type { Song, StructuredLyrics } from "~/api/types";

// Where the words came from, so the UI can credit an external source.
export interface LyricsResult {
  source: "server" | "lrclib" | null;
  list: StructuredLyrics[];
}

const NONE: LyricsResult = { source: null, list: [] };

// Lyrics for a track don't change, so nothing here needs re-asking within a
// session — least of all LRCLIB, which is a free service run on donated time.
export const LYRICS_STALE_MS = 60 * 60_000;

// The online fallback is part of the answer, so it belongs in the key: turning
// the setting on has to re-ask rather than serve the empty result cached from
// when it was off.
export function lyricsKey(songId: string) {
  return [...qk.lyrics(songId), settings.playback.onlineLyrics] as const;
}

export async function fetchLyrics(song: Song): Promise<LyricsResult> {
  const c = client();
  if (!c) return NONE;

  // Passing what we already know about the track saves the client a round trip
  // it would otherwise spend looking the same song up again.
  const fromServer = await c
    .getLyrics(song.id, { artist: song.artist, title: song.title })
    .catch(() => []);
  const usable = fromServer.filter((l) => l.line.length > 0);
  if (usable.length > 0) return { source: "server", list: usable };

  if (!settings.playback.onlineLyrics) return NONE;
  // Radio has no stable identity to look up, and the "track" is whatever the
  // station happens to be playing.
  if (song.isRadio) return NONE;

  const online = await fetchLyricsFromLrclib(song);
  return online ? { source: "lrclib", list: [online] } : NONE;
}

// Warm the cache for a track nobody has asked for yet. Used for the *next* song
// in the queue while lyrics are on screen, so a track change doesn't put the
// panel back into a loading state for a second or two.
export function prefetchLyrics(song: Song | undefined): void {
  if (!song?.id || !client() || song.isRadio) return;
  void queryClient.prefetchQuery({
    queryKey: lyricsKey(song.id),
    queryFn: () => fetchLyrics(song),
    staleTime: LYRICS_STALE_MS,
  });
}
