// Helpers that fetch a collection's songs then act on the player. Used by album
// and artist cards/menus where the song list isn't already loaded.

import { client } from "~/auth/session";
import { player } from "~/player/store";
import { buildVibeQueue } from "~/lib/recommendations";

export async function playAlbum(albumId: string, shuffle = false): Promise<void> {
  const c = client();
  if (!c) return;
  const album = await c.getAlbum(albumId);
  const songs = shuffle ? shuffled(album.song) : album.song;
  player.playNow(songs, 0);
}

export async function queueAlbum(albumId: string, position: "next" | "end"): Promise<void> {
  const c = client();
  if (!c) return;
  const album = await c.getAlbum(albumId);
  if (position === "next") player.playNext(album.song);
  else player.addToQueue(album.song);
}

export async function playArtist(artistId: string, shuffle = false): Promise<void> {
  const c = client();
  if (!c) return;
  const artist = await c.getArtist(artistId);
  const albums = artist.albums ?? [];
  const all: Awaited<ReturnType<typeof c.getAlbum>>["song"] = [];
  for (const a of albums) {
    const full = await c.getAlbum(a.id);
    all.push(...full.song);
  }
  player.playNow(shuffle ? shuffled(all) : all, 0);
}

// Vibe Roulette: anchor a fresh listening session on one random track, then
// build a cohesive queue from songs similar to it (rather than a chaotic random
// mix). Returns false when nothing could be generated — empty library, or a
// server with no similar-songs support. Infinite radio then keeps it going.
export async function vibeRoulette(): Promise<boolean> {
  const c = client();
  if (!c) return false;
  const [seed] = await c.getRandomSongs(1);
  if (!seed) return false;
  const similar = await c.getSimilarSongs(seed.id, 25);
  player.playNow(buildVibeQueue(seed, similar), 0);
  return true;
}

function shuffled<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
