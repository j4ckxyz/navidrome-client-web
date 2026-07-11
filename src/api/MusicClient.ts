// The common client interface shared by both server backends.
//
// The app was originally written against Navidrome's Subsonic/OpenSubsonic API
// (SubsonicClient). To support Jellyfin as an alternative music backend without
// touching every page, both backends implement this single interface and return
// the same domain types (Song, Album, Artist…). The active client is chosen at
// login time from the stored server type; everything downstream is agnostic.

import type { ServerCredentials } from "./credentials";
import type {
  Album,
  AlbumWithSongs,
  Artist,
  ArtistSummary,
  Genre,
  Playlist,
  PlaylistWithSongs,
  SearchResult,
  Song,
  StructuredLyrics,
} from "./types";

export type ServerType = "navidrome" | "jellyfin";

export type AlbumListType =
  | "newest"
  | "recent"
  | "frequent"
  | "random"
  | "starred"
  | "alphabeticalByName"
  | "alphabeticalByArtist"
  | "byYear"
  | "byGenre";

export interface LibraryStats {
  artistCount: number;
  albumCount: number;
  songCount: number;
  // Total size on disk in bytes. Undefined when it couldn't be determined.
  totalSize?: number;
}

export interface ClientOptions {
  onAuthError?: (creds: ServerCredentials) => void;
}

// The full surface the UI depends on. SubsonicClient and JellyfinClient both
// satisfy this; add a method here (and to both classes) rather than reaching for
// a backend-specific one from a component.
export interface MusicClient {
  readonly serverType: ServerType;
  readonly serverUrl: string;
  readonly username: string;

  // --- URL builders (used directly in <img>/<audio>/download links) ---
  streamUrl(id: string, maxBitRate?: number, format?: string): string;
  coverArtUrl(id: string | undefined, size?: number): string;
  downloadUrl(id: string): string;
  // Debug helper: build a raw API URL for an endpoint (masked in the UI).
  buildUrl(endpoint: string, params?: Record<string, string | number | undefined>): string;

  // --- Connectivity ---
  ping(): Promise<boolean>;

  // --- Library ---
  getArtists(): Promise<ArtistSummary[]>;
  getArtist(id: string): Promise<Artist>;
  getArtistInfo(id: string): Promise<{ biography?: string; similarArtist?: ArtistSummary[] }>;
  getAlbum(id: string): Promise<AlbumWithSongs>;
  getAlbumList(
    type: AlbumListType,
    opts?: { size?: number; offset?: number; genre?: string; fromYear?: number; toYear?: number },
  ): Promise<Album[]>;
  getSong(id: string): Promise<Song>;
  getRandomSongs(size?: number, genre?: string): Promise<Song[]>;
  getTopSongs(artist: string, count?: number): Promise<Song[]>;
  getSimilarSongs(id: string, count?: number): Promise<Song[]>;

  // --- Genres ---
  getGenres(): Promise<Genre[]>;
  getSongsByGenre(genre: string, count?: number, offset?: number): Promise<Song[]>;

  // --- Stats ---
  getLibraryStats(): Promise<LibraryStats>;

  // --- Starred / ratings ---
  getStarred(): Promise<{ artist: ArtistSummary[]; album: Album[]; song: Song[] }>;
  star(id: string, kind?: "song" | "album" | "artist"): Promise<void>;
  unstar(id: string, kind?: "song" | "album" | "artist"): Promise<void>;
  setRating(id: string, rating: number): Promise<void>;

  // --- Scrobbling ---
  scrobble(id: string, submission: boolean, time?: number): Promise<void>;

  // --- Search ---
  search(
    query: string,
    opts?: { artistCount?: number; albumCount?: number; songCount?: number },
  ): Promise<SearchResult>;

  // --- Playlists ---
  getPlaylists(): Promise<Playlist[]>;
  getPlaylist(id: string): Promise<PlaylistWithSongs>;
  createPlaylist(name: string, songIds?: string[], isPublic?: boolean): Promise<string | undefined>;
  setPlaylistVisibility(id: string, isPublic: boolean): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
  updatePlaylist(
    id: string,
    changes: {
      name?: string;
      comment?: string;
      public?: boolean;
      songIdToAdd?: string[];
      songIndexToRemove?: number[];
    },
  ): Promise<void>;
  overwritePlaylist(id: string, songIds: string[], currentCount: number): Promise<void>;

  // --- Lyrics ---
  getLyrics(id: string): Promise<StructuredLyrics[]>;

  // --- Capabilities (let the UI hide features a backend can't do) ---
  // Whether whole-album/playlist downloads are supported (Navidrome zips them
  // server-side; Jellyfin has no equivalent, so only single tracks download).
  readonly canDownloadCollections: boolean;
  // Whether a custom playlist cover can be uploaded to the server.
  readonly canEditServerImages: boolean;

  // --- Backend-specific escape hatches (used only by matching backends) ---
  // Auth headers for our own backend's /upload etc. (Navidrome proxy features).
  getServerAuthHeaders(): Record<string, string>;
  // Subsonic auth triplet for the transcoded-zip download backend.
  readonly subsonicAuth: { u: string; t: string; s: string };
  uploadPlaylistImage(id: string, file: File): Promise<void>;
  createShare(ids: string[], description?: string): Promise<string | null>;
}
