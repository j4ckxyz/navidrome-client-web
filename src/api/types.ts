// Domain types for the Subsonic / OpenSubsonic + Navidrome native API surface.
// These are intentionally narrowed to the fields this client consumes.

export interface ArtistSummary {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  starred?: string; // ISO date when starred, absent when not
}

export interface Artist extends ArtistSummary {
  albums: Album[];
  biography?: string;
  similarArtist?: ArtistSummary[];
}

export interface Album {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  starred?: string;
  created?: string;
  playCount?: number;
  played?: string; // OpenSubsonic: last-played timestamp
  userRating?: number;
}

export interface AlbumWithSongs extends Album {
  song: Song[];
}

export interface Song {
  id: string;
  parent?: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  size?: number;
  contentType?: string;
  suffix?: string;
  duration?: number;
  bitRate?: number;
  path?: string;
  starred?: string;
  playCount?: number;
  played?: string; // OpenSubsonic: last-played timestamp
  userRating?: number;
  // ReplayGain data from OpenSubsonic, used for normalization.
  replayGain?: {
    trackGain?: number;
    albumGain?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
}

export interface Genre {
  value: string;
  songCount: number;
  albumCount: number;
}

export interface Playlist {
  id: string;
  name: string;
  comment?: string;
  owner?: string;
  public?: boolean;
  songCount: number;
  duration: number;
  created?: string;
  changed?: string;
  coverArt?: string;
}

export interface PlaylistWithSongs extends Playlist {
  entry: Song[];
}

export interface SearchResult {
  artist: ArtistSummary[];
  album: Album[];
  song: Song[];
}

export interface LyricsLine {
  start?: number; // ms offset for synced lyrics
  value: string;
}

export interface StructuredLyrics {
  lang?: string;
  synced: boolean;
  line: LyricsLine[];
  displayArtist?: string;
  displayTitle?: string;
}

// What the native /auth/login endpoint returns.
export interface NativeLoginResponse {
  id: string;
  isAdmin: boolean;
  name: string;
  username: string;
  token: string; // JWT for native API
  subsonicSalt: string;
  subsonicToken: string; // md5(password + salt), reusable without the password
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly isAuthError = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
