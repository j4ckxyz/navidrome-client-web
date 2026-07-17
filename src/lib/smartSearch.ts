// Fuzzy search over the Subsonic search3 endpoint. search3 is essentially
// prefix/contains matching, so on its own a typo returns nothing. We fan the
// query out into a few variants (words, trimmed prefixes), merge the results,
// and re-rank everything with the local fuzzy scorer. The full artist list —
// already cached for the Artists page — is folded in as a typo-tolerant
// artist index for free.

import type { MusicClient } from "~/api/MusicClient";
import type { Album, ArtistSummary, SearchResult, Song } from "~/api/types";
import { fuzzyScore, queryVariants } from "./fuzzy";

const MIN_SCORE = 0.5;

function dedupeById<T extends { id: string }>(lists: T[][]): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

function rank<T>(items: T[], score: (item: T) => number, limit: number): T[] {
  return items
    .map((item) => ({ item, s: score(item) }))
    .filter((x) => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.item);
}

function songScore(q: string, s: Song): number {
  return Math.max(
    fuzzyScore(q, s.title),
    0.92 * fuzzyScore(q, `${s.artist ?? ""} ${s.title}`),
    0.85 * fuzzyScore(q, s.artist ?? ""),
    0.75 * fuzzyScore(q, s.album ?? ""),
  );
}

function albumScore(q: string, a: Album): number {
  return Math.max(
    fuzzyScore(q, a.name),
    0.92 * fuzzyScore(q, `${a.artist ?? ""} ${a.name}`),
    0.8 * fuzzyScore(q, a.artist ?? ""),
  );
}

export async function smartSearch(
  client: MusicClient,
  query: string,
  allArtists?: ArtistSummary[],
): Promise<SearchResult> {
  const variants = queryVariants(query);
  const results = await Promise.all(
    variants.map((v) =>
      client.search(v).catch((): SearchResult => ({ artist: [], album: [], song: [] })),
    ),
  );

  const artists = dedupeById([...results.map((r) => r.artist), allArtists ?? []]);
  const albums = dedupeById(results.map((r) => r.album));
  const songs = dedupeById(results.map((r) => r.song));

  return {
    artist: rank(artists, (a) => fuzzyScore(query, a.name), 20),
    album: rank(albums, (a) => albumScore(query, a), 20),
    song: rank(songs, (s) => songScore(query, s), 50),
  };
}
