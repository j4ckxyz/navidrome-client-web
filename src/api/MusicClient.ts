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

// Per-user listening figures for the Stats page.
//
// Every field is optional and the page renders only what it gets. The two
// backends expose very different amounts here — Jellyfin tracks per-item play
// counts and dates for each user, Navidrome only exposes the equivalent through
// its native (password-login) API — and a figure that is silently wrong is worse
// than one that is plainly absent.
export interface UserStats {
  // Distinct tracks played at least once.
  tracksPlayed?: number;
  // Every play counted, repeats included.
  totalPlays?: number;
  // Time spent listening: plays × track length.
  listeningSeconds?: number;
  // Distinct albums / artists with at least one play.
  albumsPlayed?: number;
  artistsPlayed?: number;
  // Favourites, by kind.
  favoriteSongs?: number;
  favoriteAlbums?: number;
  favoriteArtists?: number;
  // When anything was last played, ISO.
  lastPlayed?: string;
  // Leaderboards, already sorted, each carrying its playCount.
  topSongs?: Song[];
  topAlbums?: Album[];
  topArtists?: ArtistSummary[];
  // True when the totals are a floor, not an exact figure: counting every play
  // means walking every played track, and that walk is capped so a huge library
  // can't turn one page view into a request storm. The UI says so rather than
  // presenting a truncated number as final.
  approximate?: boolean;
  // Set when the backend can't report listening figures for this session at all
  // (a Subsonic-token login has no access to Navidrome's native API), so the UI
  // can explain the gap instead of showing an empty section.
  unavailableReason?: string;
}

export interface ClientOptions {
  onAuthError?: (creds: ServerCredentials) => void;
}

// A resolved, playable stream for one track.
//
// Subsonic hands back a URL you can just play. Jellyfin needs a negotiation
// round-trip first (POST /Items/{id}/PlaybackInfo), which decides direct-play
// vs transcode and issues the PlaySessionId that ties the stream, the transcode
// job, and every later progress report together. The extra fields carry that
// context back so the player can report and tear down correctly.
export interface StreamHandle {
  url: string;
  // Opaque per-playback id. Jellyfin scopes its ffmpeg jobs to this; report it
  // on start/progress/stop so the right job is reused and later killed.
  playSessionId?: string;
  mediaSourceId?: string;
  playMethod?: "DirectPlay" | "DirectStream" | "Transcode";
  // False for a live server-side transcode: the response has no stable byte
  // layout, so an element-level seek would land somewhere arbitrary. The player
  // re-requests the stream from a new offset instead.
  canSeek: boolean;
  // Seconds already skipped server-side (startTimeTicks). The element's own
  // currentTime is relative to this.
  startOffset: number;
  // Server-reported track length, when the negotiation revealed one.
  duration?: number;
}

export interface StreamOptions {
  // User's max-bitrate preference in kbps; 0/undefined = original quality.
  maxBitRateKbps?: number;
  // Start this many seconds into the track (server-side seek).
  startSeconds?: number;
  // Skip direct play — the browser already failed to decode this source.
  forceTranscode?: boolean;
}

// What the player tells the server about the current playback.
export interface PlaybackReport {
  songId: string;
  positionSeconds: number;
  durationSeconds?: number;
  isPaused?: boolean;
  isMuted?: boolean;
  volume?: number; // 0..1
  repeat?: "off" | "all" | "one";
  shuffle?: boolean;
  stream?: StreamHandle;
  // Upcoming queue, so a Jellyfin remote can show what's next.
  queue?: { id: string; playlistItemId?: string }[];
}

export type PlaybackEvent = "start" | "progress" | "pause" | "stop";

// How a backend wants playback reported.
//   "scrobble" — Subsonic: a now-playing ping plus a one-shot submission once
//                the listen threshold is passed. Progress isn't a concept.
//   "session"  — Jellyfin: a real session lifecycle (start → periodic progress
//                → stop). The *stop* report is what banks the play count and
//                resume position, so it must land at the end, not mid-track.
export type PlaybackReportingStyle = "scrobble" | "session";

// A music library the server exposes. Jellyfin users routinely have more than
// one ("Music", "Soundtracks", "Vinyl rips"); Subsonic has a single namespace.
export interface LibraryView {
  id: string;
  name: string;
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

  // --- Playback ---
  // Negotiate a playable stream. Always prefer this over streamUrl() for actual
  // playback: on Jellyfin it is the difference between a correct direct play
  // and an unmanaged transcode.
  resolveStream(id: string, opts?: StreamOptions): Promise<StreamHandle>;
  readonly playbackReporting: PlaybackReportingStyle;
  reportPlayback(event: PlaybackEvent, report: PlaybackReport): Promise<void>;

  // --- Connectivity ---
  ping(): Promise<boolean>;
  // Human-readable server name/version for Settings. Null when unavailable.
  getServerInfo(): Promise<{ name?: string; version?: string } | null>;
  // Revoke this session server-side, where the backend supports it.
  revokeSession(): Promise<void>;

  // --- Libraries ---
  // Music libraries to browse. Empty array = the backend has a single library.
  getLibraries(): Promise<LibraryView[]>;
  // Restrict subsequent library reads to one library id ("" = all).
  setLibrary(id: string): void;

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
  // "Instant mix" style radio seeded from any item (song, album, artist, genre).
  getInstantMix(
    id: string,
    kind: "song" | "album" | "artist" | "genre",
    count?: number,
  ): Promise<Song[]>;

  // --- Genres ---
  getGenres(): Promise<Genre[]>;
  getSongsByGenre(genre: string, count?: number, offset?: number): Promise<Song[]>;

  // --- Stats ---
  getLibraryStats(): Promise<LibraryStats>;
  // Listening figures for the logged-in user. Never rejects on a partial
  // failure: an unsupported sub-query leaves its field undefined.
  getUserStats(): Promise<UserStats>;

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
  // Move one entry to a new position. Backends with an atomic move use it;
  // others fall back to a rewrite. Returns false when the caller should rewrite.
  movePlaylistItem(id: string, fromIndex: number, toIndex: number): Promise<boolean>;

  // --- Lyrics ---
  // `hints` carries the track's artist/title when the caller already has them,
  // which it almost always does. Subsonic's plain lyrics endpoint is keyed by
  // artist+title rather than id, so without them the client has to fetch the
  // song again first — a whole round trip for a fallback that rarely fires.
  getLyrics(id: string, hints?: { artist?: string; title?: string }): Promise<StructuredLyrics[]>;

  // --- Capabilities (let the UI hide features a backend can't do) ---
  // Whether the *server* can bundle a whole album/playlist into one download
  // (Navidrome zips them server-side). When false the app zips in the browser
  // instead, so collection downloads still work — just not server-assisted.
  readonly canDownloadCollections: boolean;
  // Whether a custom playlist cover can be uploaded to the server.
  readonly canEditServerImages: boolean;
  // Whether playlists have a public/private flag at all.
  readonly canSetPlaylistVisibility: boolean;
  // Whether the backend exposes a 0–5 star rating (vs a like/dislike toggle).
  readonly hasFiveStarRatings: boolean;
  // Whether transcoded (lossy) downloads can be requested from the server.
  readonly canTranscodeDownloads: boolean;

  // --- Backend-specific escape hatches (used only by matching backends) ---
  // Auth headers for our own backend's /upload etc. (Navidrome proxy features).
  getServerAuthHeaders(): Record<string, string>;
  // Subsonic auth triplet for the transcoded-zip download backend.
  readonly subsonicAuth: { u: string; t: string; s: string };
  uploadPlaylistImage(id: string, file: File): Promise<void>;
  createShare(ids: string[], description?: string): Promise<string | null>;
}
