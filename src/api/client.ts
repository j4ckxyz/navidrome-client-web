// The API client. Most reads/writes go through the Subsonic/OpenSubsonic REST
// API; Navidrome's native API is used only where it offers more (shares).
//
// A single client instance is bound to one set of credentials. On an auth
// failure it invokes onAuthError so the UI can prompt re-login instead of
// failing silently.

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
import { updateJwt, type ServerCredentials } from "./credentials";

const API_VERSION = "1.16.1";
const CLIENT_NAME = "navidrome-web";

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

interface ClientOptions {
  onAuthError?: (creds: ServerCredentials) => void;
}

export class SubsonicClient {
  constructor(
    private creds: ServerCredentials,
    private opts: ClientOptions = {},
  ) {}

  get serverUrl(): string {
    return this.creds.serverUrl;
  }

  get username(): string {
    return this.creds.username;
  }

  private authParams(): URLSearchParams {
    return new URLSearchParams({
      u: this.creds.username,
      t: this.creds.subsonicToken,
      s: this.creds.subsonicSalt,
      v: API_VERSION,
      c: CLIENT_NAME,
      f: "json",
    });
  }

  // Build a fully-qualified Subsonic endpoint URL with auth + params.
  buildUrl(endpoint: string, params: Record<string, string | number | undefined> = {}): string {
    const search = this.authParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) search.set(k, String(v));
    }
    return `${this.creds.serverUrl}/rest/${endpoint}?${search.toString()}`;
  }

  streamUrl(id: string, maxBitRate?: number, format?: string): string {
    // Build stream URL manually so f=json isn't included — stream endpoints
    // return binary audio regardless, but some servers behave oddly with it.
    const search = new URLSearchParams({
      u: this.creds.username,
      t: this.creds.subsonicToken,
      s: this.creds.subsonicSalt,
      v: API_VERSION,
      c: CLIENT_NAME,
      id,
    });
    if (maxBitRate) search.set("maxBitRate", String(maxBitRate));
    if (format) search.set("format", format);
    return `${this.creds.serverUrl}/rest/stream.view?${search.toString()}`;
  }

  coverArtUrl(id: string | undefined, size?: number): string {
    if (!id) return "";
    return this.buildUrl("getCoverArt.view", { id, size: size || undefined });
  }

  private handleAuthError(): void {
    this.opts.onAuthError?.(this.creds);
  }

  // Core Subsonic GET: parses the subsonic-response envelope and surfaces auth
  // failures distinctly.
  private async get<T>(
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.buildUrl(endpoint, params));
    } catch {
      throw new ApiError(`Network error calling ${endpoint}`);
    }
    if (res.status === 401 || res.status === 403) {
      this.handleAuthError();
      throw new ApiError("Authentication expired", res.status, true);
    }
    if (!res.ok) throw new ApiError(`HTTP ${res.status} calling ${endpoint}`, res.status);

    const body = await res.json();
    const sub = body["subsonic-response"];
    if (!sub) throw new ApiError(`Malformed response from ${endpoint}`);
    if (sub.status !== "ok") {
      const code = sub.error?.code;
      // 40/41/42/44 are Subsonic auth-related error codes.
      const isAuth = [40, 41, 42, 44].includes(code);
      if (isAuth) this.handleAuthError();
      throw new ApiError(sub.error?.message ?? "API error", code, isAuth);
    }
    return sub as T;
  }

  // --- Connectivity ---

  async ping(): Promise<boolean> {
    await this.get("ping.view");
    return true;
  }

  // --- Library: artists / albums / songs ---

  async getArtists(): Promise<ArtistSummary[]> {
    const data = await this.get<{ artists?: { index?: { artist?: ArtistSummary[] }[] } }>(
      "getArtists.view",
    );
    const indexes = data.artists?.index ?? [];
    return indexes.flatMap((i) => i.artist ?? []);
  }

  async getArtist(id: string): Promise<Artist> {
    const data = await this.get<{ artist: Artist }>("getArtist.view", { id });
    return { ...data.artist, albums: (data.artist as any).album ?? [] };
  }

  async getArtistInfo(id: string): Promise<{ biography?: string; similarArtist?: ArtistSummary[] }> {
    const data = await this.get<{ artistInfo2?: { biography?: string; similarArtist?: ArtistSummary[] } }>(
      "getArtistInfo2.view",
      { id, count: 8 },
    );
    return data.artistInfo2 ?? {};
  }

  async getAlbum(id: string): Promise<AlbumWithSongs> {
    const data = await this.get<{ album: AlbumWithSongs }>("getAlbum.view", { id });
    return { ...data.album, song: data.album.song ?? [] };
  }

  async getAlbumList(
    type: AlbumListType,
    opts: { size?: number; offset?: number; genre?: string; fromYear?: number; toYear?: number } = {},
  ): Promise<Album[]> {
    const data = await this.get<{ albumList2?: { album?: Album[] } }>("getAlbumList2.view", {
      type,
      size: opts.size ?? 50,
      offset: opts.offset ?? 0,
      genre: opts.genre,
      fromYear: opts.fromYear,
      toYear: opts.toYear,
    });
    return data.albumList2?.album ?? [];
  }

  async getSong(id: string): Promise<Song> {
    const data = await this.get<{ song: Song }>("getSong.view", { id });
    return data.song;
  }

  async getRandomSongs(size = 50, genre?: string): Promise<Song[]> {
    const data = await this.get<{ randomSongs?: { song?: Song[] } }>("getRandomSongs.view", {
      size,
      genre,
    });
    return data.randomSongs?.song ?? [];
  }

  async getTopSongs(artist: string, count = 50): Promise<Song[]> {
    const data = await this.get<{ topSongs?: { song?: Song[] } }>("getTopSongs.view", {
      artist,
      count,
    });
    return data.topSongs?.song ?? [];
  }

  async getSimilarSongs(id: string, count = 50): Promise<Song[]> {
    const data = await this.get<{ similarSongs2?: { song?: Song[] } }>("getSimilarSongs2.view", {
      id,
      count,
    });
    return data.similarSongs2?.song ?? [];
  }

  // --- Genres ---

  async getGenres(): Promise<Genre[]> {
    const data = await this.get<{ genres?: { genre?: Genre[] } }>("getGenres.view");
    return data.genres?.genre ?? [];
  }

  async getSongsByGenre(genre: string, count = 100, offset = 0): Promise<Song[]> {
    const data = await this.get<{ songsByGenre?: { song?: Song[] } }>("getSongsByGenre.view", {
      genre,
      count,
      offset,
    });
    return data.songsByGenre?.song ?? [];
  }

  // --- Starred / ratings ---

  async getStarred(): Promise<{ artist: ArtistSummary[]; album: Album[]; song: Song[] }> {
    const data = await this.get<{
      starred2?: { artist?: ArtistSummary[]; album?: Album[]; song?: Song[] };
    }>("getStarred2.view");
    return {
      artist: data.starred2?.artist ?? [],
      album: data.starred2?.album ?? [],
      song: data.starred2?.song ?? [],
    };
  }

  async star(id: string, kind: "song" | "album" | "artist" = "song"): Promise<void> {
    const param = kind === "album" ? "albumId" : kind === "artist" ? "artistId" : "id";
    await this.get("star.view", { [param]: id });
  }

  async unstar(id: string, kind: "song" | "album" | "artist" = "song"): Promise<void> {
    const param = kind === "album" ? "albumId" : kind === "artist" ? "artistId" : "id";
    await this.get("unstar.view", { [param]: id });
  }

  async setRating(id: string, rating: number): Promise<void> {
    await this.get("setRating.view", { id, rating });
  }

  // --- Scrobbling ---

  async scrobble(id: string, submission: boolean, time?: number): Promise<void> {
    await this.get("scrobble.view", {
      id,
      submission: String(submission),
      time: time ?? undefined,
    });
  }

  // --- Search ---

  async search(query: string, opts: { artistCount?: number; albumCount?: number; songCount?: number } = {}): Promise<SearchResult> {
    const data = await this.get<{
      searchResult3?: { artist?: ArtistSummary[]; album?: Album[]; song?: Song[] };
    }>("search3.view", {
      query,
      artistCount: opts.artistCount ?? 20,
      albumCount: opts.albumCount ?? 20,
      songCount: opts.songCount ?? 50,
    });
    return {
      artist: data.searchResult3?.artist ?? [],
      album: data.searchResult3?.album ?? [],
      song: data.searchResult3?.song ?? [],
    };
  }

  // --- Playlists ---

  async getPlaylists(): Promise<Playlist[]> {
    const data = await this.get<{ playlists?: { playlist?: Playlist[] } }>("getPlaylists.view");
    return data.playlists?.playlist ?? [];
  }

  async getPlaylist(id: string): Promise<PlaylistWithSongs> {
    const data = await this.get<{ playlist: PlaylistWithSongs }>("getPlaylist.view", { id });
    return { ...data.playlist, entry: data.playlist.entry ?? [] };
  }

  async createPlaylist(name: string, songIds: string[] = []): Promise<void> {
    const search = this.authParams();
    search.set("name", name);
    for (const id of songIds) search.append("songId", id);
    await this.getRaw("createPlaylist.view", search);
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.get("deletePlaylist.view", { id });
  }

  // updatePlaylist handles renames, comment/visibility, adding, and removing by
  // index. Reordering is done by the caller via overwritePlaylist.
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
    const search = this.authParams();
    search.set("playlistId", id);
    if (changes.name !== undefined) search.set("name", changes.name);
    if (changes.comment !== undefined) search.set("comment", changes.comment);
    if (changes.public !== undefined) search.set("public", String(changes.public));
    for (const sid of changes.songIdToAdd ?? []) search.append("songIdToAdd", sid);
    for (const idx of changes.songIndexToRemove ?? []) search.append("songIndexToRemove", String(idx));
    await this.getRaw("updatePlaylist.view", search);
  }

  // Replace a playlist's entire contents in the given order. Used for reordering:
  // remove all, then re-add in the new sequence. Subsonic has no atomic reorder,
  // so we clear by index then add the new order.
  async overwritePlaylist(id: string, songIds: string[], currentCount: number): Promise<void> {
    // Remove existing entries (highest index first keeps indices valid).
    const removeIndexes = Array.from({ length: currentCount }, (_, i) => currentCount - 1 - i);
    if (removeIndexes.length > 0) {
      await this.updatePlaylist(id, { songIndexToRemove: removeIndexes });
    }
    if (songIds.length > 0) {
      await this.updatePlaylist(id, { songIdToAdd: songIds });
    }
  }

  // --- Lyrics ---

  async getLyrics(id: string): Promise<StructuredLyrics[]> {
    // Prefer OpenSubsonic structured lyrics; fall back to plain getLyrics.
    try {
      const data = await this.get<{ lyricsList?: { structuredLyrics?: StructuredLyrics[] } }>(
        "getLyricsBySongId.view",
        { id },
      );
      const list = data.lyricsList?.structuredLyrics;
      if (list && list.length > 0) return list;
    } catch {
      // ignore and fall through to plain lyrics
    }
    try {
      const song = await this.getSong(id);
      const data = await this.get<{ lyrics?: { value?: string } }>("getLyrics.view", {
        artist: song.artist,
        title: song.title,
      });
      const value = data.lyrics?.value;
      if (value) {
        return [{ synced: false, line: value.split("\n").map((v) => ({ value: v })) }];
      }
    } catch {
      // no lyrics available
    }
    return [];
  }

  // Headers for the /upload endpoint: JWT preferred, Subsonic creds as fallback.
  getUploadAuthHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "x-nd-subsonic-u": this.creds.username,
      "x-nd-subsonic-t": this.creds.subsonicToken,
      "x-nd-subsonic-s": this.creds.subsonicSalt,
    };
    if (this.creds.jwt) h["x-nd-authorization"] = `Bearer ${this.creds.jwt}`;
    return h;
  }

  // Raw GET for endpoints we build params for manually (multi-value params).
  private async getRaw(endpoint: string, search: URLSearchParams): Promise<void> {
    const res = await fetch(`${this.creds.serverUrl}/rest/${endpoint}?${search.toString()}`).catch(
      () => {
        throw new ApiError(`Network error calling ${endpoint}`);
      },
    );
    if (res.status === 401 || res.status === 403) {
      this.handleAuthError();
      throw new ApiError("Authentication expired", res.status, true);
    }
    const body = await res.json();
    const sub = body["subsonic-response"];
    if (!sub || sub.status !== "ok") {
      const isAuth = [40, 41, 42, 44].includes(sub?.error?.code);
      if (isAuth) this.handleAuthError();
      throw new ApiError(sub?.error?.message ?? "API error", sub?.error?.code, isAuth);
    }
  }

  // --- Native API (shares): used because Subsonic share support is limited ---

  // Whether this session can use native-API write features (playlist images,
  // shares). The native API is JWT-only; Subsonic-token logins don't get one.
  get canEditServerImages(): boolean {
    return !!this.creds.jwt;
  }

  // Upload a custom cover image for a playlist via Navidrome's native API.
  // The image is stored on the server and syncs to every client. Requires a
  // native (password) login and edit permission on the playlist.
  async uploadPlaylistImage(id: string, file: File): Promise<void> {
    if (!this.creds.jwt) {
      throw new ApiError("Setting a playlist cover needs a password login.");
    }
    const form = new FormData();
    form.append("image", file);

    let res: Response;
    try {
      res = await fetch(`${this.creds.serverUrl}/api/playlist/${id}/image`, {
        method: "POST",
        headers: { "x-nd-authorization": `Bearer ${this.creds.jwt}` },
        body: form,
      });
    } catch {
      throw new ApiError("Network error uploading cover");
    }

    // The native API returns a refreshed JWT on each call.
    const refreshed = res.headers.get("x-nd-authorization");
    if (refreshed) {
      const token = refreshed.replace(/^Bearer\s+/i, "");
      this.creds.jwt = token;
      updateJwt(this.creds.serverUrl, token);
    }

    if (res.status === 401) {
      this.handleAuthError();
      throw new ApiError("Authentication expired", 401, true);
    }
    if (res.status === 403) {
      throw new ApiError("You don't have permission to edit this playlist.", 403);
    }
    if (!res.ok) {
      throw new ApiError(`Cover upload failed (HTTP ${res.status})`, res.status);
    }
  }

  async createShare(ids: string[], description?: string): Promise<string | null> {
    if (!this.creds.jwt) return null;
    const res = await fetch(`${this.creds.serverUrl}/api/share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nd-authorization": `Bearer ${this.creds.jwt}`,
      },
      body: JSON.stringify({ resourceType: "album", resourceIds: ids.join(","), description }),
    }).catch(() => null);
    if (!res) return null;
    // Native API hands back a refreshed JWT on each call.
    const refreshed = res.headers.get("x-nd-authorization");
    if (refreshed) {
      const token = refreshed.replace(/^Bearer\s+/i, "");
      this.creds.jwt = token;
      updateJwt(this.creds.serverUrl, token);
    }
    if (!res.ok) return null;
    const data = await res.json();
    return data?.id ? `${this.creds.serverUrl}/share/${data.id}` : null;
  }
}
