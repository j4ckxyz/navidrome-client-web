// Gathering candidates for Infinite radio.
//
// The server's own "similar songs" is one input here, not the answer. On
// Jellyfin an audio InstantMix is close to a library shuffle; on Navidrome it's
// good only when the Last.fm agent is configured. Pulling from several sources
// and ranking them (lib/recommendations) gives a run that actually holds
// together on any library, without needing a metadata service.
//
// Everything is best-effort and runs in parallel: a source that errors or
// returns nothing just contributes nothing.

import type { MusicClient } from "~/api/MusicClient";
import type { Song } from "~/api/types";
import { rankRadioCandidates } from "./recommendations";
import { log } from "./log";

// Per-source fetch sizes. Generous because ranking discards most of it — the
// point is a wide pool to choose from, not a big queue.
const PER_GENRE = 60;
const FROM_ARTIST = 20;
const FROM_SERVER_MIX = 40;
const FROM_SIMILAR_ARTIST = 10;
// Only the first couple of genres; a track tagged with six is usually
// over-tagged and the tail is noise.
const MAX_GENRES = 2;
const MAX_SIMILAR_ARTISTS = 3;

async function settled<T>(promise: Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await promise;
  } catch (err) {
    log.debug("radio", `${label} failed`, err);
    return [];
  }
}

function genresOf(song: Song): string[] {
  if (!song.genre) return [];
  return song.genre
    .split(/[;,/|]+/)
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, MAX_GENRES);
}

// Build the candidate pool for a seed track.
export async function gatherRadioCandidates(
  client: MusicClient,
  seed: Song,
): Promise<{ candidates: Song[]; sources: Record<string, number> }> {
  const genres = genresOf(seed);

  const jobs: Promise<Song[]>[] = [
    // The server's mix. Kept because when it *is* good (Navidrome with Last.fm)
    // it's the best single source available.
    settled(client.getSimilarSongs(seed.id, FROM_SERVER_MIX), "server mix"),
    ...genres.map((g) => settled(client.getSongsByGenre(g, PER_GENRE), `genre:${g}`)),
    seed.artist
      ? settled(client.getTopSongs(seed.artist, FROM_ARTIST), "artist top")
      : Promise.resolve([]),
  ];

  // Similar artists, where the backend knows any. Navidrome fills this from
  // Last.fm; a stock Jellyfin returns nothing, which is why it can't be the
  // only source.
  const similarArtistJob = seed.artistId
    ? client
        .getArtistInfo(seed.artistId)
        .then(async (info) => {
          const artists = (info?.similarArtist ?? []).slice(0, MAX_SIMILAR_ARTISTS);
          const lists = await Promise.all(
            artists.map((a) => settled(client.getTopSongs(a.name, FROM_SIMILAR_ARTIST), "similar")),
          );
          return lists.flat();
        })
        .catch(() => [] as Song[])
    : Promise.resolve([] as Song[]);

  const [serverMix, ...rest] = await Promise.all([...jobs, similarArtistJob]);
  const genreLists = rest.slice(0, genres.length);
  const artistTop = rest[genres.length] ?? [];
  const similarArtists = rest[genres.length + 1] ?? [];

  const sources: Record<string, number> = {
    serverMix: serverMix.length,
    genre: genreLists.reduce((n, l) => n + l.length, 0),
    artist: artistTop.length,
    similarArtists: similarArtists.length,
  };

  return {
    candidates: [...serverMix, ...genreLists.flat(), ...artistTop, ...similarArtists],
    sources,
  };
}

// Full pipeline: gather, then rank down to `count`.
export async function buildRadioBatch(
  client: MusicClient,
  seed: Song,
  count: number,
  exclude: ReadonlySet<string>,
): Promise<Song[]> {
  const { candidates, sources } = await gatherRadioCandidates(client, seed);
  if (candidates.length === 0) return [];
  const picked = rankRadioCandidates(seed, candidates, count, { exclude });
  log.debug(
    "radio",
    `${candidates.length} candidates → ${picked.length} picked`,
    sources,
  );
  return picked;
}
