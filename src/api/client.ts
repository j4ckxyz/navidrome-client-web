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
import { SUBSONIC_CLIENT } from "~/lib/branding";
import type {
  AlbumListType,
  ClientOptions,
  LibraryStats,
  LibraryView,
  MusicClient,
  PlaybackEvent,
  PlaybackReport,
  PlaybackReportingStyle,
  ServerType,
  StreamHandle,
  StreamOptions,
  UserStats,
} from "./MusicClient";

// Re-exported for existing importers of these from "~/api/client".
export type { AlbumListType, LibraryStats };

const API_VERSION = "1.16.1";
const CLIENT_NAME = SUBSONIC_CLIENT;

export class SubsonicClient implements MusicClient {
  constructor(
    private creds: ServerCredentials,
    private opts: ClientOptions = {},
  ) {}

  readonly serverType: ServerType = "navidrome";

  get serverUrl(): string {
    return this.creds.serverUrl;
  }

  // Navidrome zips whole albums/playlists server-side (download.view).
  readonly canDownloadCollections = true;
  readonly canSetPlaylistVisibility = true;
  readonly hasFiveStarRatings = true;
  readonly canTranscodeDownloads = true;
  // Subsonic has no session concept: a now-playing ping plus a one-shot
  // submission once the listen threshold is passed is the whole protocol.
  readonly playbackReporting: PlaybackReportingStyle = "scrobble";

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

  // Download the original file/collection. For an album or playlist id Navidrome
  // returns a ZIP of the original (untranscoded) files; for a song id, the file.
  downloadUrl(id: string): string {
    const search = new URLSearchParams({
      u: this.creds.username,
      t: this.creds.subsonicToken,
      s: this.creds.subsonicSalt,
      v: API_VERSION,
      c: CLIENT_NAME,
      id,
    });
    return `${this.creds.serverUrl}/rest/download.view?${search.toString()}`;
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

  // --- Playback ---

  // Subsonic streams are plain HTTP responses the element can seek in, so
  // "negotiation" is just building the URL the caller would have built anyway.
  // The async shape exists for Jellyfin, which genuinely has to ask the server.
  async resolveStream(id: string, opts: StreamOptions = {}): Promise<StreamHandle> {
    return {
      url: this.streamUrl(id, opts.maxBitRateKbps || undefined, opts.forceTranscode ? "mp3" : undefined),
      canSeek: true,
      startOffset: 0,
    };
  }

  async reportPlayback(event: PlaybackEvent, report: PlaybackReport): Promise<void> {
    // Only the now-playing ping maps onto Subsonic. The submission scrobble is
    // driven by the listen threshold in the player, not by the stop event.
    if (event === "start") {
      await this.scrobble(report.songId, false).catch(() => {});
    }
  }

  // --- Connectivity ---

  async ping(): Promise<boolean> {
    await this.get("ping.view");
    return true;
  }

  async getServerInfo(): Promise<{ name?: string; version?: string } | null> {
    try {
      const data = await this.get<{ type?: string; serverVersion?: string; version?: string }>(
        "ping.view",
      );
      return { name: data.type, version: data.serverVersion ?? data.version };
    } catch {
      return null;
    }
  }

  // Subsonic tokens aren't server-side sessions; there's nothing to revoke.
  async revokeSession(): Promise<void> {}

  // --- Libraries ---

  // Subsonic exposes a single library namespace (music folders exist but the
  // API can't scope most reads to one), so there is nothing to choose between.
  async getLibraries(): Promise<LibraryView[]> {
    return [];
  }

  setLibrary(): void {}

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

  // Songs similar to a seed track, for radio/discovery. Prefers the
  // OpenSubsonic v2 endpoint and falls back to the legacy getSimilarSongs.view
  // for servers that predate it (or that return nothing on v2).
  async getSimilarSongs(id: string, count = 50): Promise<Song[]> {
    try {
      const data = await this.get<{ similarSongs2?: { song?: Song[] } }>("getSimilarSongs2.view", {
        id,
        count,
      });
      const songs = data.similarSongs2?.song ?? [];
      if (songs.length > 0) return songs;
    } catch {
      // v2 unsupported on this server — fall through to the legacy endpoint.
    }
    try {
      const legacy = await this.get<{ similarSongs?: { song?: Song[] } }>("getSimilarSongs.view", {
        id,
        count,
      });
      return legacy.similarSongs?.song ?? [];
    } catch {
      return [];
    }
  }

  // Subsonic's radio generator is similar-songs, and it only seeds from a
  // track. Album/artist/genre seeds resolve to a representative song first.
  async getInstantMix(
    id: string,
    kind: "song" | "album" | "artist" | "genre" = "song",
    count = 50,
  ): Promise<Song[]> {
    if (kind === "song") return this.getSimilarSongs(id, count);
    try {
      let seed: Song | undefined;
      if (kind === "album") {
        seed = (await this.getAlbum(id)).song[0];
      } else if (kind === "genre") {
        seed = (await this.getSongsByGenre(id, 1))[0];
      } else {
        const artist = await this.getArtist(id);
        const firstAlbum = artist.albums?.[0];
        seed = firstAlbum ? (await this.getAlbum(firstAlbum.id)).song[0] : undefined;
      }
      return seed ? await this.getSimilarSongs(seed.id, count) : [];
    } catch {
      return [];
    }
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

  // --- Library stats ---

  // Aggregate library totals for the Stats page. Subsonic has no totals
  // endpoint, so we derive them: artist count from getArtists, and — when a
  // native (password) login is available — album/song counts and total size by
  // summing Navidrome's album records, which already carry per-album aggregates.
  // Falls back to a size-less estimate for Subsonic-token logins.
  async getLibraryStats(): Promise<LibraryStats> {
    const artists = await this.getArtists();
    const artistCount = artists.length;

    if (this.creds.jwt) {
      try {
        const totals = await this.nativeAlbumTotals();
        return { artistCount, ...totals };
      } catch {
        // Native API unavailable — fall through to the Subsonic-only estimate.
      }
    }

    const albumCount = artists.reduce((sum, a) => sum + (a.albumCount ?? 0), 0);
    const genres = await this.getGenres();
    const songCount = genres.reduce((sum, g) => sum + (g.songCount ?? 0), 0);
    return { artistCount, albumCount, songCount, totalSize: undefined };
  }

  // One page of Navidrome's native REST API (/api/album, /api/song, …). This is
  // the password-login surface: it needs a JWT, which a Subsonic-token session
  // doesn't have. Every response reissues the token, so it's rolled forward here
  // rather than at each call site.
  private async nativeList<T>(
    resource: string,
    query: Record<string, string | number>,
  ): Promise<T[]> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) search.set(k, String(v));
    const url = `${this.creds.serverUrl}/api/${resource}?${search.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, { headers: { "x-nd-authorization": `Bearer ${this.creds.jwt}` } });
    } catch {
      throw new ApiError(`Network error calling /api/${resource}`);
    }
    if (res.status === 401 || res.status === 403) {
      this.handleAuthError();
      throw new ApiError("Authentication expired", res.status, true);
    }
    if (!res.ok) throw new ApiError(`HTTP ${res.status} calling /api/${resource}`, res.status);

    const refreshed = res.headers.get("x-nd-authorization");
    if (refreshed) {
      const token = refreshed.replace(/^Bearer\s+/i, "");
      this.creds.jwt = token;
      updateJwt(this.creds.serverUrl, token);
    }

    const page = (await res.json()) as T[];
    return Array.isArray(page) ? page : [];
  }

  // Walk Navidrome's native /api/album list, summing songCount and size. Album
  // records are far fewer than tracks, so this is the cheap way to a true total
  // library size. Requires a JWT; each response refreshes it.
  private async nativeAlbumTotals(): Promise<{
    albumCount: number;
    songCount: number;
    totalSize: number;
  }> {
    const pageSize = 500;
    let start = 0;
    let albumCount = 0;
    let songCount = 0;
    let totalSize = 0;

    for (;;) {
      const page = await this.nativeList<{ songCount?: number; size?: number }>("album", {
        _start: start,
        _end: start + pageSize,
        _sort: "name",
      });
      if (page.length === 0) break;
      for (const al of page) {
        albumCount++;
        songCount += al.songCount ?? 0;
        totalSize += al.size ?? 0;
      }
      if (page.length < pageSize) break;
      start += pageSize;
    }

    return { albumCount, songCount, totalSize };
  }

  // Listening figures for the logged-in user.
  //
  // Subsonic has no per-user aggregate at all, so everything below the
  // favourites comes from Navidrome's native API, which does expose per-track
  // playCount and playDate — and which needs the JWT a password login provides.
  // A Subsonic-token session gets favourites and a most-played albums list, and
  // is told plainly why the rest is missing rather than shown zeroes.
  async getUserStats(): Promise<UserStats> {
    const TOP = 8;

    // Favourites and most-played albums work on any login: getStarred2 is one
    // request for all three kinds, and "frequent" is Subsonic's own most-played
    // album list (correctly mapped, cover art included).
    const [starred, frequent] = await Promise.allSettled([
      this.getStarred(),
      this.getAlbumList("frequent", { size: TOP }),
    ]);
    const base: UserStats = {
      favoriteSongs: starred.status === "fulfilled" ? starred.value.song.length : undefined,
      favoriteAlbums: starred.status === "fulfilled" ? starred.value.album.length : undefined,
      favoriteArtists: starred.status === "fulfilled" ? starred.value.artist.length : undefined,
      topAlbums: frequent.status === "fulfilled" ? frequent.value : undefined,
    };

    if (!this.creds.jwt) {
      return {
        ...base,
        unavailableReason:
          "Play counts need a password (native) login — Navidrome doesn't expose them to Subsonic-token sessions.",
      };
    }

    try {
      return { ...base, ...(await this.nativePlayStats(TOP)) };
    } catch {
      // Native API unavailable (older server, or the token was rejected). The
      // favourites above still stand.
      return {
        ...base,
        unavailableReason: "Navidrome's native API didn't answer, so play counts are unavailable.",
      };
    }
  }

  // Walk /api/song sorted by play count, biggest first, and stop at the first
  // never-played track: sorted that way, the walk only touches records that
  // actually contribute, so a large library costs a few pages rather than one
  // page per thousand tracks. Capped regardless, and the result says when the
  // cap was what ended it.
  private async nativePlayStats(top: number): Promise<UserStats> {
    interface NativeSong {
      id: string;
      title?: string;
      artist?: string;
      artistId?: string;
      albumId?: string;
      duration?: number;
      playCount?: number;
      playDate?: string;
    }
    const pageSize = 500;
    const maxPages = 20; // 10k played tracks

    let tracksPlayed = 0;
    let totalPlays = 0;
    let listeningSeconds = 0;
    let approximate = false;
    const albums = new Set<string>();
    const artistPlays = new Map<string, { name: string; plays: number }>();
    let topIds: string[] = [];

    for (let page = 0; ; page++) {
      if (page >= maxPages) {
        approximate = true;
        break;
      }
      const rows = await this.nativeList<NativeSong>("song", {
        _start: page * pageSize,
        _end: (page + 1) * pageSize,
        _sort: "playCount",
        _order: "DESC",
      });
      if (rows.length === 0) break;
      if (page === 0) topIds = rows.filter((r) => (r.playCount ?? 0) > 0).slice(0, top).map((r) => r.id);

      let hitZero = false;
      for (const row of rows) {
        const plays = row.playCount ?? 0;
        if (plays <= 0) {
          hitZero = true;
          break;
        }
        tracksPlayed++;
        totalPlays += plays;
        listeningSeconds += plays * (row.duration ?? 0);
        if (row.albumId) albums.add(row.albumId);
        if (row.artistId) {
          const entry = artistPlays.get(row.artistId) ?? { name: row.artist ?? "", plays: 0 };
          entry.plays += plays;
          if (!entry.name && row.artist) entry.name = row.artist;
          artistPlays.set(row.artistId, entry);
        }
      }
      if (hitZero || rows.length < pageSize) break;
    }

    // The most recent play is a separate one-row question — the walk above is
    // ordered by count, not date.
    let lastPlayed: string | undefined;
    try {
      const [recent] = await this.nativeList<NativeSong>("song", {
        _start: 0,
        _end: 1,
        _sort: "playDate",
        _order: "DESC",
      });
      lastPlayed = recent?.playDate;
    } catch {
      // Non-fatal: the totals are the point of this call.
    }

    // Native records carry no cover art id, so read the top tracks back through
    // the Subsonic API, which returns fully-formed songs. A handful of small
    // requests, only on this page.
    const topSongs = (
      await Promise.all(
        topIds.map((id) =>
          this.getSong(id).catch(() => undefined),
        ),
      )
    ).filter((s): s is Song => !!s);

    const topArtists: ArtistSummary[] = [...artistPlays.entries()]
      .sort((a, b) => b[1].plays - a[1].plays)
      .slice(0, top)
      .map(([id, v]) => ({ id, name: v.name || "Unknown artist", playCount: v.plays }));

    return {
      tracksPlayed,
      totalPlays,
      listeningSeconds,
      albumsPlayed: albums.size,
      artistsPlayed: artistPlays.size,
      lastPlayed,
      topSongs,
      topArtists,
      approximate,
    };
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

  // Create a playlist and return its id. Playlists are made **private** by
  // default — Navidrome's server-side default can be public, so we explicitly
  // set visibility after creation rather than trusting it.
  async createPlaylist(name: string, songIds: string[] = [], isPublic = false): Promise<string | undefined> {
    const search = this.authParams();
    search.set("name", name);
    for (const id of songIds) search.append("songId", id);
    const sub = await this.getRaw("createPlaylist.view", search);
    let id = sub?.playlist?.id as string | undefined;
    if (!id) {
      // Some servers return ok without the playlist body. Find what we just made
      // so privacy can still be enforced (the whole point of this method).
      try {
        const mine = (await this.getPlaylists())
          .filter((p) => p.name === name && (!p.owner || p.owner === this.username))
          .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
        id = mine[0]?.id;
      } catch {
        // ignore — fall through with no id
      }
    }
    if (id) {
      try {
        await this.updatePlaylist(id, { public: isPublic });
      } catch {
        // Non-fatal: the playlist exists; visibility just couldn't be enforced.
      }
    }
    return id;
  }

  // Toggle a playlist's public/private visibility.
  async setPlaylistVisibility(id: string, isPublic: boolean): Promise<void> {
    await this.updatePlaylist(id, { public: isPublic });
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

  // Subsonic has no atomic move; the caller rewrites the playlist instead.
  async movePlaylistItem(): Promise<boolean> {
    return false;
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

  // Headers identifying this session to our own backend (/upload, /download/zip):
  // JWT preferred, Subsonic creds as fallback. The backend re-uses them to call
  // Navidrome on the user's behalf.
  getServerAuthHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "x-nd-subsonic-u": this.creds.username,
      "x-nd-subsonic-t": this.creds.subsonicToken,
      "x-nd-subsonic-s": this.creds.subsonicSalt,
    };
    if (this.creds.jwt) h["x-nd-authorization"] = `Bearer ${this.creds.jwt}`;
    return h;
  }

  // The raw Subsonic auth triplet, for endpoints that take credentials in a
  // request body (e.g. a form-POST streamed download).
  get subsonicAuth(): { u: string; t: string; s: string } {
    return {
      u: this.creds.username,
      t: this.creds.subsonicToken,
      s: this.creds.subsonicSalt,
    };
  }

  // Raw GET for endpoints we build params for manually (multi-value params).
  // Returns the parsed subsonic-response envelope so callers can read results
  // (e.g. the id of a freshly-created playlist).
  private async getRaw(endpoint: string, search: URLSearchParams): Promise<any> {
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
    return sub;
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
