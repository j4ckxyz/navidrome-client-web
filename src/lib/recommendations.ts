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

// The next batch of radio tracks to append: drop anything already queued or
// recently played, then apply discovery filters (with the non-empty fallback).
//
// Excluding recent plays matters because getSimilarSongs is deterministic for a
// given seed — without it, every radio session from the same anchor serves the
// same handful of tracks back, which reads as the queue being stuck. If that
// filter would leave nothing, queue-position dedupe alone is used, since
// stalling playback is worse than a repeat.
export function nextRadioBatch(
  queue: Song[],
  similar: Song[],
  recentlyPlayed: ReadonlySet<string> = new Set(),
): Song[] {
  const existing = new Set(queue.map((s) => s.id));
  const notQueued = similar.filter((s) => !existing.has(s.id));
  const unheard = notQueued.filter((s) => !recentlyPlayed.has(s.id));
  return pickRecommendations(unheard.length > 0 ? unheard : notQueued);
}


// --- Radio scoring ----------------------------------------------------------
//
// Why this exists: the servers' own "similar songs" is weak for music. Jellyfin
// answers /InstantMix for an audio item with what is effectively a library
// shuffle — seeded with 1992 West Coast hip-hop it returned Taylor Swift, Lady
// Gaga and Conan Gray, fifteen tracks with fifteen different artists and no
// shared genre. Navidrome does better when its Last.fm agent is configured and
// no better than Jellyfin when it isn't.
//
// So the server's mix becomes one input among several rather than the answer,
// and candidates are ranked here against signals every library actually has:
// genre, artist, era, and what you've favourited. Pure, so it can be evaluated
// against a real library without playing anything.

export interface ScoreOptions {
  // Ids to push to the back: already queued, or heard recently.
  exclude?: ReadonlySet<string>;
  // At most this many tracks by one artist, so a batch can't become an
  // accidental artist-radio.
  maxPerArtist?: number;
  // Deterministic ordering for tests. Omit for a little run-to-run variety.
  jitter?: () => number;
}

function genreTokens(genre: string | undefined): Set<string> {
  if (!genre) return new Set();
  return new Set(
    genre
      .toLowerCase()
      .split(/[;,/|]+/)
      .map((g) => g.trim())
      .filter(Boolean),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / Math.min(a.size, b.size);
}

// Score one candidate against the seed. Higher is better; -Infinity means never.
export function scoreCandidate(seed: Song, candidate: Song, opts: ScoreOptions = {}): number {
  if (candidate.id === seed.id) return -Infinity;
  if (candidate.isRadio) return -Infinity;

  let score = 0;

  // Genre is the strongest signal a self-hosted library reliably carries, and
  // the one whose absence made the server mixes feel random.
  const shared = overlap(genreTokens(seed.genre), genreTokens(candidate.genre));
  score += shared * 6;

  const sameArtist = !!seed.artist && candidate.artist === seed.artist;
  // Some same-artist is wanted — it's why you're listening — but this is a
  // radio, not the artist's discography, so the pull is deliberately gentle and
  // the per-artist cap below does the real limiting.
  if (sameArtist) score += 2;
  // Straight back into the record you're already playing is the one thing a
  // radio definitely shouldn't do.
  if (candidate.albumId && candidate.albumId === seed.albumId) score -= 3;

  // Era. Music that sits decades apart rarely belongs in the same run, even
  // within a genre.
  if (seed.year && candidate.year) {
    const gap = Math.abs(seed.year - candidate.year);
    if (gap <= 3) score += 2;
    else if (gap <= 8) score += 1;
    else if (gap > 25) score -= 1;
  }

  // Your own signals.
  if (candidate.starred) score += 1.5;

  // Already queued or just heard: keep as a last resort rather than dropping,
  // so a small library can still fill a queue.
  if (opts.exclude?.has(candidate.id)) score -= 10;

  const jitter = opts.jitter ?? Math.random;
  return score + jitter() * 0.75;
}

// Rank candidates and return the best `count`, capped per artist so one artist
// can't take over the batch.
export function rankRadioCandidates(
  seed: Song,
  candidates: Song[],
  count: number,
  opts: ScoreOptions = {},
): Song[] {
  const maxPerArtist = opts.maxPerArtist ?? 2;

  const seen = new Set<string>();
  const unique: Song[] = [];
  for (const song of candidates) {
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    unique.push(song);
  }

  const scored = unique
    .map((song) => ({ song, score: scoreCandidate(seed, song, opts) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);

  // Fill in passes, relaxing the per-artist cap one step at a time. A single
  // pass plus an uncapped backfill looks equivalent and isn't: when the pool is
  // dominated by one artist — which is exactly when the cap matters — the
  // backfill hands the whole rest of the batch to that artist anyway. Measured
  // on a real library, that turned a cap of 2 into eight consecutive tracks by
  // the same act. Relaxing evenly keeps the spread as wide as the pool allows.
  const perArtist = new Map<string, number>();
  const chosen = new Set<string>();
  const out: Song[] = [];

  for (let cap = maxPerArtist; out.length < count; cap++) {
    let added = false;
    for (const { song } of scored) {
      if (out.length >= count) break;
      if (chosen.has(song.id)) continue;
      const key = (song.artist ?? "").toLowerCase();
      const used = perArtist.get(key) ?? 0;
      if (key && used >= cap) continue;
      perArtist.set(key, used + 1);
      chosen.add(song.id);
      out.push(song);
      added = true;
    }
    // A pass that placed nothing means the pool is exhausted, not that the cap
    // is too tight — raising it further would loop forever.
    if (!added) break;
  }

  const filtered = applyDiscoveryFilters(out);
  return filtered.length > 0 ? filtered : out;
}
