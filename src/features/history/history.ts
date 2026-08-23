// Listening history: a track-level log of what actually played here.
//
// "Recently played" elsewhere in the app is an *albums* carousel, which is a
// different thing — you remember a song, not the record it was on. This records
// individual plays with a timestamp so the question "what was that, an hour
// ago?" has an answer.
//
// Kept locally rather than read back from the server, because only Jellyfin
// exposes per-track play dates; Subsonic has no equivalent, and a feature that
// silently worked on one backend and not the other would be worse than one that
// plainly works on both. The trade-off is that this is the history of *this
// browser*, which is also what makes it exact.

import { createSignal } from "solid-js";
import type { Song } from "~/api/types";
import { client } from "~/auth/session";

export interface HistoryEntry {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  duration?: number;
  playedAt: number; // epoch ms
}

const PREFIX = "nd:history";
// Enough for months of normal listening while staying well inside the
// localStorage budget — roughly 100KB at this size.
const MAX_ENTRIES = 500;
// A track restarted or re-reported inside this window is the same listen, not a
// new one. Skipping back and forth would otherwise fill the log with noise.
const DEDUPE_MS = 30_000;

const [entries, setEntries] = createSignal<HistoryEntry[]>([]);
export { entries as historyEntries };

function key(): string | null {
  const url = client()?.serverUrl;
  return url ? `${PREFIX}:${url}` : null;
}

function persist(list: HistoryEntry[]): void {
  const k = key();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(list));
  } catch {
    // Quota — drop the oldest half and try once more rather than losing it all.
    try {
      const trimmed = list.slice(0, Math.floor(list.length / 2));
      localStorage.setItem(k, JSON.stringify(trimmed));
      setEntries(trimmed);
    } catch {
      // Storage genuinely unavailable; history is best-effort.
    }
  }
}

// Load the log for the active server. Called on boot and whenever the server
// changes, since history is per-server like the queue.
export function loadHistory(): void {
  const k = key();
  if (!k) {
    setEntries([]);
    return;
  }
  try {
    const raw = localStorage.getItem(k);
    const parsed = raw ? JSON.parse(raw) : [];
    setEntries(Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []);
  } catch {
    setEntries([]);
  }
}

export function recordPlay(song: Song): void {
  // Live radio has no library identity to record and would just be the station
  // name repeated forever.
  if (song.isRadio || !song.id) return;
  const now = Date.now();
  const current = entries();
  const last = current[0];
  if (last && last.id === song.id && now - last.playedAt < DEDUPE_MS) return;

  const entry: HistoryEntry = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    albumId: song.albumId,
    artistId: song.artistId,
    coverArt: song.coverArt,
    duration: song.duration,
    playedAt: now,
  };
  const next = [entry, ...current].slice(0, MAX_ENTRIES);
  setEntries(next);
  persist(next);
}

// Ids played recently, so radio doesn't keep serving back the same tracks
// session after session. Bounded because it's only used to filter a batch of a
// few dozen candidates.
export function recentlyPlayedIds(limit = 150): Set<string> {
  const out = new Set<string>();
  for (const entry of entries()) {
    out.add(entry.id);
    if (out.size >= limit) break;
  }
  return out;
}

export function clearHistory(): void {
  setEntries([]);
  const k = key();
  if (!k) return;
  try {
    localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

// Play counts over a window, for the "most played" summary on the page.
export function topFromHistory(sinceMs: number, limit = 10): { entry: HistoryEntry; plays: number }[] {
  const cutoff = Date.now() - sinceMs;
  const counts = new Map<string, { entry: HistoryEntry; plays: number }>();
  for (const entry of entries()) {
    if (entry.playedAt < cutoff) break; // newest-first, so we're past the window
    const seen = counts.get(entry.id);
    if (seen) seen.plays++;
    else counts.set(entry.id, { entry, plays: 1 });
  }
  return [...counts.values()].sort((a, b) => b.plays - a.plays).slice(0, limit);
}
