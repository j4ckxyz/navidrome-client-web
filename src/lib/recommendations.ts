// Shared shaping for algorithmically-suggested tracks (radio top-up, end-of-queue
// continuation, Vibe Roulette). Centralised so every discovery source behaves
// the same way the user has configured.

import type { Song } from "~/api/types";
import { settings } from "~/settings/store";

// "Forgotten Gems": when on, drop tracks the user has already played more than a
// couple of times so buried/never-heard music surfaces instead. Songs with no
// playCount count as the most forgotten and are always kept.
const FORGOTTEN_GEMS_MAX_PLAYS = 2;

export function applyDiscoveryFilters(songs: Song[]): Song[] {
  if (!settings.playback.forgottenGems) return songs;
  return songs.filter((s) => (s.playCount ?? 0) <= FORGOTTEN_GEMS_MAX_PLAYS);
}

// Apply discovery filters but never return an empty list when the input was
// non-empty: filtering to nothing would stall playback, so fall back to the
// unfiltered set. Use this for queue continuation; use applyDiscoveryFilters
// directly for previews where an empty result is fine.
export function pickRecommendations(songs: Song[]): Song[] {
  const filtered = applyDiscoveryFilters(songs);
  return filtered.length > 0 ? filtered : songs;
}

// Assemble a Vibe Roulette queue: the random seed first, then tracks similar to
// it (discovery-filtered, with the seed de-duplicated out of the tail). Pure so
// the queue-building logic can be unit-tested independently of the player.
export function buildVibeQueue(seed: Song, similar: Song[]): Song[] {
  const rest = pickRecommendations(similar).filter((s) => s.id !== seed.id);
  return [seed, ...rest];
}

// The next batch of radio tracks to append: drop anything already in the queue,
// then apply discovery filters (with the non-empty fallback). Pure.
export function nextRadioBatch(queue: Song[], similar: Song[]): Song[] {
  const existing = new Set(queue.map((s) => s.id));
  return pickRecommendations(similar.filter((s) => !existing.has(s.id)));
}
