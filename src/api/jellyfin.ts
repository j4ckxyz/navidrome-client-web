// Jellyfin backend. Implements the same MusicClient interface as SubsonicClient
// so the rest of the app is unaware which server it's talking to. Only Jellyfin's
// *music* surface is used (Audio / MusicAlbum / MusicArtist / Playlist item
// types) — films and TV are intentionally never requested.
//
// Jellyfin models everything as a BaseItemDto; the mapping helpers below narrow
// those to the app's domain types (Song, Album, Artist…). A single client is
// bound to one set of credentials; on a 401 it calls onAuthError so the UI can
// prompt re-login.

import {
  ApiError,
  type Album,
  type AlbumWithSongs,
  type Artist,
  type ArtistSummary,
  type Genre,
  type Playlist,
  type PlaylistWithSongs,
  type SearchResult,
  type Song,
  type StructuredLyrics,
} from "./types";
import { jellyfinAuthHeader, type ServerCredentials } from "./credentials";
import type {
  AlbumListType,
  ClientOptions,
  LibraryStats,
  MusicClient,
  ServerType,
} from "./MusicClient";

// Jellyfin's BaseItemDto, narrowed to the fields we read.
interface JfItem {
  Id: string;
  Name: string;
  Type?: string;
  Overview?: string;
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  AlbumArtists?: { Id: string; Name: string }[];
  Artists?: string[];
  ArtistItems?: { Id: string; Name: string }[];
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ProductionYear?: number;
  Genres?: string[];
  RunTimeTicks?: number;
  DateCreated?: string;
  ChildCount?: number;
  AlbumCount?: number;
  Container?: string;
  Path?: string;
  PlaylistItemId?: string;
  ImageTags?: { Primary?: string };
  AlbumPrimaryImageTag?: string;
  MediaSources?: { Bitrate?: number; Size?: number; Container?: string }[];
  UserData?: {
    IsFavorite?: boolean;
    PlayCount?: number;
    LastPlayedDate?: string;
    Played?: boolean;
  };
}

interface JfList {
  Items?: JfItem[];
  TotalRecordCount?: number;
}

// 1 tick = 100ns → seconds.
function ticksToSeconds(ticks?: number): number | undefined {
  return ticks != null ? Math.round(ticks / 10_000_000) : undefined;
}

// The item id whose Primary image should represent this item, or undefined when
// there is no art (so CoverArt shows its placeholder instead of a broken image).
function imageItemId(item: JfItem): string | undefined {
  if (item.ImageTags?.Primary) return item.Id;
  if (item.AlbumId && item.AlbumPrimaryImageTag) return item.AlbumId;
  return undefined;
}

function favMarker(item: JfItem): string | undefined {
  // The app treats `starred` as a truthy "is favourited" flag; Jellyfin has no
  // per-favourite timestamp, so use the last-played date if present else a
  // sentinel that is simply truthy.
  if (!item.UserData?.IsFavorite) return undefined;
  return item.UserData.LastPlayedDate ?? "favorite";
}

const SONG_FIELDS = "Genres,MediaSources,Path,ParentIndexNumber";
const ALBUM_FIELDS = "Genres,DateCreated,ChildCount";

export class JellyfinClient implements MusicClient {
  constructor(
    private creds: ServerCredentials,
    private opts: ClientOptions = {},
  ) {}

  readonly serverType: ServerType = "jellyfin";
  // Jellyfin has no server-side zip of a whole album/playlist.
  readonly canDownloadCollections = false;
  readonly canEditServerImages = false;

  get serverUrl(): string {
    return this.creds.serverUrl;
  }
  get username(): string {
    return this.creds.username;
  }
  private get userId(): string {
    return this.creds.userId ?? "";
  }
  private get token(): string {
    return this.creds.accessToken ?? "";
  }
  private get deviceId(): string {
    return this.creds.deviceId ?? "";
  }

  // --- URL builders -----------------------------------------------------------

  // Build a URL with auth. `api_key` is included so it also works in contexts
  // that can't set headers (<img>, <audio>, download links).
  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.creds.serverUrl}${path}`);
    u.searchParams.set("api_key", this.token);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  buildUrl(endpoint: string, params: Record<string, string | number | undefined> = {}): string {
    // DebugPanel passes a bare endpoint path (no leading slash).
    return this.url(`/${endpoint.replace(/^\//, "")}`, params);
  }

  streamUrl(id: string, maxBitRate?: number, format?: string): string {
    // Original codec, no cap → hand back the static file the browser plays
    // directly. Otherwise transcode to a progressive MP3 stream that any
    // <audio> element can consume (avoids HLS).
    if (!format && !maxBitRate) {
      return this.url(`/Audio/${id}/stream`, { static: "true", deviceId: this.deviceId });
    }
    return this.url(`/Audio/${id}/stream.mp3`, {
      deviceId: this.deviceId,
      audioCodec: "mp3",
      audioBitRate: maxBitRate ? maxBitRate * 1000 : undefined,
    });
  }

  coverArtUrl(id: string | undefined, size?: number): string {
    if (!id) return "";
    return this.url(`/Items/${id}/Images/Primary`, {
      fillWidth: size || undefined,
      fillHeight: size || undefined,
      quality: 90,
    });
  }

  downloadUrl(id: string): string {
    // Single-item original file. Collections aren't downloadable on Jellyfin.
    return this.url(`/Items/${id}/Download`);
  }

  // --- Core request -----------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { params?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const u = new URL(`${this.creds.serverUrl}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      "X-Emby-Token": this.token,
      "X-Emby-Authorization": jellyfinAuthHeader(this.deviceId, this.token),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(u.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new ApiError(`Network error calling ${path}`);
    }
    if (res.status === 401) {
      this.opts.onAuthError?.(this.creds);
      throw new ApiError("Authentication expired", 401, true);
    }
    if (!res.ok) throw new ApiError(`HTTP ${res.status} calling ${path}`, res.status);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  // --- Mappers ----------------------------------------------------------------

  private toSong(item: JfItem): Song {
    const source = item.MediaSources?.[0];
    return {
      id: item.Id,
      title: item.Name,
      album: item.Album,
      albumId: item.AlbumId,
      artist: item.Artists?.join(", ") || item.AlbumArtist,
      artistId: item.ArtistItems?.[0]?.Id ?? item.AlbumArtists?.[0]?.Id,
      track: item.IndexNumber,
      discNumber: item.ParentIndexNumber,
      year: item.ProductionYear,
      genre: item.Genres?.[0],
      coverArt: imageItemId(item),
      size: source?.Size,
      contentType: undefined,
      suffix: (item.Container ?? source?.Container)?.split(",")[0],
      duration: ticksToSeconds(item.RunTimeTicks),
      bitRate: source?.Bitrate ? Math.round(source.Bitrate / 1000) : undefined,
      path: item.Path,
      starred: favMarker(item),
      playCount: item.UserData?.PlayCount,
      played: item.UserData?.LastPlayedDate,
    };
  }

  private toAlbum(item: JfItem): Album {
    return {
      id: item.Id,
      name: item.Name,
      artist: item.AlbumArtist ?? item.AlbumArtists?.[0]?.Name,
      artistId: item.AlbumArtists?.[0]?.Id,
      coverArt: imageItemId(item),
      songCount: item.ChildCount,
      duration: ticksToSeconds(item.RunTimeTicks),
      year: item.ProductionYear,
      genre: item.Genres?.[0],
      starred: favMarker(item),
      created: item.DateCreated,
      playCount: item.UserData?.PlayCount,
      played: item.UserData?.LastPlayedDate,
    };
  }

  private toArtist(item: JfItem): ArtistSummary {
    return {
      id: item.Id,
      name: item.Name,
      coverArt: imageItemId(item),
      albumCount: item.AlbumCount,
      starred: favMarker(item),
    };
  }

  // --- Connectivity -----------------------------------------------------------

  async ping(): Promise<boolean> {
    await this.get("/System/Info");
    return true;
  }

  // --- Library: artists -------------------------------------------------------

  async getArtists(): Promise<ArtistSummary[]> {
    const data = await this.get<JfList>("/Artists/AlbumArtists", {
      userId: this.userId,
      SortBy: "SortName",
      SortOrder: "Ascending",
    });
    return (data.Items ?? []).map((i) => this.toArtist(i));
  }

  async getArtist(id: string): Promise<Artist> {
    const item = await this.get<JfItem>(`/Items/${id}`, { userId: this.userId });
    const albumsData = await this.get<JfList>("/Items", {
      userId: this.userId,
      AlbumArtistIds: id,
      IncludeItemTypes: "MusicAlbum",
      Recursive: "true",
      SortBy: "ProductionYear,PremiereDate,SortName",
      SortOrder: "Descending",
      Fields: ALBUM_FIELDS,
    });
    return {
      ...this.toArtist(item),
      biography: item.Overview,
      albums: (albumsData.Items ?? []).map((a) => this.toAlbum(a)),
    };
  }

  async getArtistInfo(
    id: string,
  ): Promise<{ biography?: string; similarArtist?: ArtistSummary[] }> {
    const item = await this.get<JfItem>(`/Items/${id}`, { userId: this.userId }).catch(() => null);
    let similarArtist: ArtistSummary[] = [];
    try {
      const sim = await this.get<JfList>(`/Items/${id}/Similar`, {
        userId: this.userId,
        limit: 8,
      });
      similarArtist = (sim.Items ?? []).map((a) => this.toArtist(a));
    } catch {
      // similar unavailable — leave empty
    }
    return { biography: item?.Overview, similarArtist };
  }

  // --- Library: albums / songs ------------------------------------------------

  async getAlbum(id: string): Promise<AlbumWithSongs> {
    const item = await this.get<JfItem>(`/Items/${id}`, { userId: this.userId });
    const songs = await this.get<JfList>("/Items", {
      ParentId: id,
      userId: this.userId,
      IncludeItemTypes: "Audio",
      SortBy: "ParentIndexNumber,IndexNumber,SortName",
      Fields: SONG_FIELDS,
    });
    return {
      ...this.toAlbum(item),
      song: (songs.Items ?? []).map((s) => this.toSong(s)),
    };
  }

  async getAlbumList(
    type: AlbumListType,
    opts: { size?: number; offset?: number; genre?: string; fromYear?: number; toYear?: number } = {},
  ): Promise<Album[]> {
    const params: Record<string, string | number | undefined> = {
      userId: this.userId,
      IncludeItemTypes: "MusicAlbum",
      Recursive: "true",
      Limit: opts.size ?? 50,
      StartIndex: opts.offset ?? 0,
      Fields: ALBUM_FIELDS,
    };

    switch (type) {
      case "newest":
        params.SortBy = "DateCreated,SortName";
        params.SortOrder = "Descending";
        break;
      case "recent":
        params.SortBy = "DatePlayed,SortName";
        params.SortOrder = "Descending";
        params.Filters = "IsPlayed";
        break;
      case "frequent":
        params.SortBy = "PlayCount,SortName";
        params.SortOrder = "Descending";
        break;
      case "random":
        params.SortBy = "Random";
        break;
      case "starred":
        params.Filters = "IsFavorite";
        params.SortBy = "SortName";
        break;
      case "alphabeticalByName":
        params.SortBy = "SortName";
        params.SortOrder = "Ascending";
        break;
      case "alphabeticalByArtist":
        params.SortBy = "AlbumArtist,SortName";
        params.SortOrder = "Ascending";
        break;
      case "byGenre":
        params.Genres = opts.genre;
        params.SortBy = "SortName";
        params.SortOrder = "Ascending";
        break;
      case "byYear": {
        const from = opts.fromYear;
        const to = opts.toYear;
        if (from != null && to != null) {
          const lo = Math.min(from, to);
          const hi = Math.max(from, to);
          const years: number[] = [];
          for (let y = lo; y <= hi && years.length < 200; y++) years.push(y);
          params.Years = years.join(",");
          params.SortOrder = from <= to ? "Ascending" : "Descending";
        }
        params.SortBy = "ProductionYear,PremiereDate,SortName";
        break;
      }
    }

    const data = await this.get<JfList>("/Items", params);
    return (data.Items ?? []).map((a) => this.toAlbum(a));
  }

  async getSong(id: string): Promise<Song> {
    const item = await this.get<JfItem>(`/Items/${id}`, {
      userId: this.userId,
      Fields: SONG_FIELDS,
    });
    return this.toSong(item);
  }

  async getRandomSongs(size = 50, genre?: string): Promise<Song[]> {
    const data = await this.get<JfList>("/Items", {
      userId: this.userId,
      IncludeItemTypes: "Audio",
      Recursive: "true",
      SortBy: "Random",
      Limit: size,
      Genres: genre,
      Fields: SONG_FIELDS,
    });
    return (data.Items ?? []).map((s) => this.toSong(s));
  }

  async getTopSongs(artist: string, count = 50): Promise<Song[]> {
    // Subsonic keys this on the artist *name*; Jellyfin's Artists filter does too.
    const data = await this.get<JfList>("/Items", {
      userId: this.userId,
      IncludeItemTypes: "Audio",
      Recursive: "true",
      Artists: artist,
      SortBy: "PlayCount,SortName",
      SortOrder: "Descending",
      Limit: count,
      Fields: SONG_FIELDS,
    });
    return (data.Items ?? []).map((s) => this.toSong(s));
  }

  async getSimilarSongs(id: string, count = 50): Promise<Song[]> {
    // InstantMix is Jellyfin's "radio from this track" — the closest match to
    // Subsonic's similar-songs discovery.
    try {
      const data = await this.get<JfList>(`/Items/${id}/InstantMix`, {
        userId: this.userId,
        Limit: count,
        Fields: SONG_FIELDS,
      });
      const songs = (data.Items ?? []).map((s) => this.toSong(s));
      if (songs.length > 0) return songs;
    } catch {
      // fall through
    }
    try {
      const data = await this.get<JfList>(`/Items/${id}/Similar`, {
        userId: this.userId,
        limit: count,
        Fields: SONG_FIELDS,
      });
      return (data.Items ?? []).map((s) => this.toSong(s));
    } catch {
      return [];
    }
  }

  // --- Genres -----------------------------------------------------------------

  async getGenres(): Promise<Genre[]> {
    const data = await this.get<JfList>("/MusicGenres", {
      userId: this.userId,
      SortBy: "SortName",
    });
    // Jellyfin doesn't return per-genre counts cheaply; leave them at 0.
    return (data.Items ?? []).map((g) => ({ value: g.Name, songCount: 0, albumCount: 0 }));
  }

  async getSongsByGenre(genre: string, count = 100, offset = 0): Promise<Song[]> {
    const data = await this.get<JfList>("/Items", {
      userId: this.userId,
      IncludeItemTypes: "Audio",
      Recursive: "true",
      Genres: genre,
      SortBy: "Album,ParentIndexNumber,IndexNumber",
      Limit: count,
      StartIndex: offset,
      Fields: SONG_FIELDS,
    });
    return (data.Items ?? []).map((s) => this.toSong(s));
  }

  // --- Library stats ----------------------------------------------------------

  async getLibraryStats(): Promise<LibraryStats> {
    const count = async (params: Record<string, string | number>) => {
      const data = await this.get<JfList>("/Items", {
        userId: this.userId,
        Recursive: "true",
        Limit: 0,
        EnableTotalRecordCount: "true",
        ...params,
      });
      return data.TotalRecordCount ?? 0;
    };
    const [albumCount, songCount, artistsData] = await Promise.all([
      count({ IncludeItemTypes: "MusicAlbum" }),
      count({ IncludeItemTypes: "Audio" }),
      this.get<JfList>("/Artists/AlbumArtists", {
        userId: this.userId,
        Limit: 0,
        EnableTotalRecordCount: "true",
      }),
    ]);
    return {
      artistCount: artistsData.TotalRecordCount ?? 0,
      albumCount,
      songCount,
      totalSize: undefined,
    };
  }

  // --- Starred / ratings ------------------------------------------------------

  async getStarred(): Promise<{ artist: ArtistSummary[]; album: Album[]; song: Song[] }> {
    const [songs, albums, artists] = await Promise.all([
      this.get<JfList>("/Items", {
        userId: this.userId,
        IncludeItemTypes: "Audio",
        Recursive: "true",
        Filters: "IsFavorite",
        SortBy: "SortName",
        Fields: SONG_FIELDS,
      }),
      this.get<JfList>("/Items", {
        userId: this.userId,
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        Filters: "IsFavorite",
        SortBy: "SortName",
        Fields: ALBUM_FIELDS,
      }),
      this.get<JfList>("/Artists/AlbumArtists", {
        userId: this.userId,
        Filters: "IsFavorite",
        SortBy: "SortName",
      }),
    ]);
    return {
      song: (songs.Items ?? []).map((s) => this.toSong(s)),
      album: (albums.Items ?? []).map((a) => this.toAlbum(a)),
      // Defensive: some servers ignore Filters on the Artists endpoint, so drop
      // any non-favourite that slipped through before mapping.
      artist: (artists.Items ?? [])
        .filter((a) => a.UserData?.IsFavorite)
        .map((a) => this.toArtist(a)),
    };
  }

  async star(id: string): Promise<void> {
    await this.request("POST", `/Users/${this.userId}/FavoriteItems/${id}`);
  }

  async unstar(id: string): Promise<void> {
    await this.request("DELETE", `/Users/${this.userId}/FavoriteItems/${id}`);
  }

  async setRating(id: string, rating: number): Promise<void> {
    // Jellyfin has a like/dislike, not a 0-5 scale. Map any positive rating to a
    // "like" and 0 to clearing it. Best-effort — never surfaces an error.
    try {
      if (rating > 0) {
        await this.request("POST", `/Users/${this.userId}/Items/${id}/Rating`, {
          params: { Likes: "true" },
        });
      } else {
        await this.request("DELETE", `/Users/${this.userId}/Items/${id}/Rating`);
      }
    } catch {
      // ignore
    }
  }

  // --- Scrobbling -------------------------------------------------------------

  async scrobble(id: string, submission: boolean, time?: number): Promise<void> {
    if (!submission) {
      await this.request("POST", "/Sessions/Playing", {
        body: { ItemId: id, PlayMethod: "DirectStream", PositionTicks: 0 },
      });
      return;
    }
    await this.request("POST", "/Sessions/Playing/Stopped", {
      body: { ItemId: id, PositionTicks: time ? Math.round(time * 10_000_000) : 0 },
    });
  }

  // --- Search -----------------------------------------------------------------

  async search(
    query: string,
    opts: { artistCount?: number; albumCount?: number; songCount?: number } = {},
  ): Promise<SearchResult> {
    const [artists, albums, songs] = await Promise.all([
      this.get<JfList>("/Artists/AlbumArtists", {
        userId: this.userId,
        searchTerm: query,
        Limit: opts.artistCount ?? 20,
      }),
      this.get<JfList>("/Items", {
        userId: this.userId,
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        searchTerm: query,
        Limit: opts.albumCount ?? 20,
        Fields: ALBUM_FIELDS,
      }),
      this.get<JfList>("/Items", {
        userId: this.userId,
        IncludeItemTypes: "Audio",
        Recursive: "true",
        searchTerm: query,
        Limit: opts.songCount ?? 50,
        Fields: SONG_FIELDS,
      }),
    ]);
    return {
      artist: (artists.Items ?? []).map((a) => this.toArtist(a)),
      album: (albums.Items ?? []).map((a) => this.toAlbum(a)),
      song: (songs.Items ?? []).map((s) => this.toSong(s)),
    };
  }

  // --- Playlists --------------------------------------------------------------

  async getPlaylists(): Promise<Playlist[]> {
    const data = await this.get<JfList>("/Items", {
      userId: this.userId,
      IncludeItemTypes: "Playlist",
      Recursive: "true",
      SortBy: "SortName",
      Fields: "ChildCount",
    });
    return (data.Items ?? []).map((p) => ({
      id: p.Id,
      name: p.Name,
      owner: this.username,
      public: false,
      songCount: p.ChildCount ?? 0,
      duration: ticksToSeconds(p.RunTimeTicks) ?? 0,
      created: p.DateCreated,
      coverArt: imageItemId(p),
    }));
  }

  async getPlaylist(id: string): Promise<PlaylistWithSongs> {
    const [item, entries] = await Promise.all([
      this.get<JfItem>(`/Items/${id}`, { userId: this.userId }),
      this.get<JfList>(`/Playlists/${id}/Items`, {
        userId: this.userId,
        Fields: SONG_FIELDS,
      }),
    ]);
    const songs = (entries.Items ?? []).map((s) => this.toSong(s));
    return {
      id: item.Id,
      name: item.Name,
      owner: this.username,
      public: false,
      songCount: songs.length,
      duration: ticksToSeconds(item.RunTimeTicks) ?? 0,
      created: item.DateCreated,
      coverArt: imageItemId(item),
      entry: songs,
    };
  }

  async createPlaylist(
    name: string,
    songIds: string[] = [],
    _isPublic = false,
  ): Promise<string | undefined> {
    const res = await this.request<{ Id?: string }>("POST", "/Playlists", {
      body: { Name: name, Ids: songIds, UserId: this.userId, MediaType: "Audio" },
    });
    return res?.Id;
  }

  async setPlaylistVisibility(): Promise<void> {
    // Jellyfin playlists don't have Subsonic's public/private toggle. No-op.
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.request("DELETE", `/Items/${id}`);
  }

  // Resolve each playlist entry's stable PlaylistItemId (needed to remove/reorder).
  private async playlistEntryIds(id: string): Promise<string[]> {
    const data = await this.get<JfList>(`/Playlists/${id}/Items`, { userId: this.userId });
    return (data.Items ?? []).map((e) => e.PlaylistItemId).filter((x): x is string => !!x);
  }

  async updatePlaylist(
    id: string,
    changes: {
      name?: string;
      comment?: string;
      public?: boolean;
      songIdToAdd?: string[];
      songIndexToRemove?: number[];
    },
  ): Promise<void> {
    if (changes.name !== undefined) {
      // Rename (Jellyfin 10.9+). Non-fatal on older servers.
      try {
        await this.request("POST", `/Playlists/${id}`, { body: { Name: changes.name } });
      } catch {
        // ignore — rename unsupported
      }
    }
    if (changes.songIdToAdd?.length) {
      await this.request("POST", `/Playlists/${id}/Items`, {
        params: { Ids: changes.songIdToAdd.join(","), userId: this.userId },
      });
    }
    if (changes.songIndexToRemove?.length) {
      const all = await this.playlistEntryIds(id);
      const entryIds = changes.songIndexToRemove
        .map((idx) => all[idx])
        .filter((x): x is string => !!x);
      if (entryIds.length) {
        await this.request("DELETE", `/Playlists/${id}/Items`, {
          params: { EntryIds: entryIds.join(",") },
        });
      }
    }
  }

  async overwritePlaylist(id: string, songIds: string[]): Promise<void> {
    // Reorder = clear then re-add in the new order (no atomic reorder needed).
    const existing = await this.playlistEntryIds(id);
    if (existing.length) {
      await this.request("DELETE", `/Playlists/${id}/Items`, {
        params: { EntryIds: existing.join(",") },
      });
    }
    if (songIds.length) {
      await this.request("POST", `/Playlists/${id}/Items`, {
        params: { Ids: songIds.join(","), userId: this.userId },
      });
    }
  }

  // --- Lyrics -----------------------------------------------------------------

  async getLyrics(id: string): Promise<StructuredLyrics[]> {
    try {
      const data = await this.get<{ Lyrics?: { Text: string; Start?: number }[] }>(
        `/Audio/${id}/Lyrics`,
      );
      const lines = data.Lyrics ?? [];
      if (lines.length === 0) return [];
      const synced = lines.some((l) => l.Start != null);
      return [
        {
          synced,
          line: lines.map((l) => ({
            // Jellyfin lyric offsets are in ticks (100ns) → ms.
            start: l.Start != null ? Math.round(l.Start / 10_000) : undefined,
            value: l.Text,
          })),
        },
      ];
    } catch {
      return [];
    }
  }

  // --- Backend-specific escape hatches (unused for Jellyfin) ------------------

  getServerAuthHeaders(): Record<string, string> {
    return { "x-emby-token": this.token };
  }

  get subsonicAuth(): { u: string; t: string; s: string } {
    return { u: "", t: "", s: "" };
  }

  async uploadPlaylistImage(): Promise<void> {
    throw new ApiError("Setting a playlist cover isn't supported on Jellyfin.");
  }

  async createShare(): Promise<string | null> {
    return null;
  }
}
