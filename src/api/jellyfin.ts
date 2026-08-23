// Jellyfin backend. Implements the same MusicClient interface as SubsonicClient
// so the rest of the app is unaware which server it's talking to. Only Jellyfin's
// *music* surface is used (Audio / MusicAlbum / MusicArtist / Playlist item
// types) — films and TV are intentionally never requested.
//
// Jellyfin models everything as a BaseItemDto; the mapping helpers below narrow
// those to the app's domain types (Song, Album, Artist…). A single client is
// bound to one set of credentials; on a 401 it calls onAuthError so the UI can
// prompt re-login.
//
// Playback is the part that has to be done Jellyfin's way rather than
// Subsonic's. Two rules drive the code below:
//
//   1. Never guess a stream URL. POST /Items/{id}/PlaybackInfo with a real
//      DeviceProfile and use what comes back. The response decides direct play
//      vs transcode and issues the PlaySessionId that Jellyfin uses to key the
//      ffmpeg job. Without one, the server can't recognise a follow-up range
//      request as the *same* playback and spins up a second encode against the
//      same output path — which is what makes a track warble, jump, or drift.
//
//   2. /Sessions/Playing/Stopped means "playback ended". It tears down the
//      now-playing session, banks the play count, and writes the resume
//      position. It is not a scrobble and must not be sent mid-track.

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
import { buildDeviceProfile } from "./jellyfinProfile";
import { canPlayContainer } from "~/lib/codecs";
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

// Jellyfin's BaseItemDto, narrowed to the fields we read.
export interface JfItem {
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
  PremiereDate?: string;
  Genres?: string[];
  RunTimeTicks?: number;
  DateCreated?: string;
  ChildCount?: number;
  AlbumCount?: number;
  SongCount?: number;
  Container?: string;
  Path?: string;
  PlaylistItemId?: string;
  CollectionType?: string;
  ImageTags?: { Primary?: string };
  AlbumPrimaryImageTag?: string;
  MediaSources?: JfMediaSource[];
  MediaStreams?: JfMediaStream[];
  UserData?: {
    IsFavorite?: boolean;
    PlayCount?: number;
    LastPlayedDate?: string;
    Played?: boolean;
    Rating?: number;
    Likes?: boolean;
  };
}

interface JfMediaStream {
  Type?: string;
  Codec?: string;
  BitRate?: number;
  SampleRate?: number;
  BitDepth?: number;
  Channels?: number;
}

interface JfMediaSource {
  Id?: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  Path?: string;
  Protocol?: string;
  RunTimeTicks?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  TranscodingContainer?: string;
  TranscodingSubProtocol?: string;
  MediaStreams?: JfMediaStream[];
  IsInfiniteStream?: boolean;
}

interface JfPlaybackInfo {
  MediaSources?: JfMediaSource[];
  PlaySessionId?: string;
  ErrorCode?: string;
}

// A device with a live session on the server. Only the fields this app reads
// are declared; Jellyfin sends a great deal more.
export interface JfSessionInfo {
  Id?: string;
  DeviceId?: string;
  DeviceName?: string;
  Client?: string;
  ApplicationVersion?: string;
  UserId?: string;
  UserName?: string;
  SupportsRemoteControl?: boolean;
  SupportedCommands?: string[];
  PlayableMediaTypes?: string[];
  LastActivityDate?: string;
  NowPlayingItem?: JfItem;
  PlayState?: JfPlayState;
  NowPlayingQueue?: { Id?: string; PlaylistItemId?: string }[];
}

export interface JfPlayState {
  PositionTicks?: number;
  CanSeek?: boolean;
  IsPaused?: boolean;
  IsMuted?: boolean;
  VolumeLevel?: number;
  RepeatMode?: string;
  PlaybackOrder?: string;
}

interface JfList {
  Items?: JfItem[];
  TotalRecordCount?: number;
}

const TICKS_PER_SECOND = 10_000_000;

// 1 tick = 100ns → seconds.
function ticksToSeconds(ticks?: number): number | undefined {
  return ticks != null ? Math.round(ticks / TICKS_PER_SECOND) : undefined;
}

function secondsToTicks(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

// The item id whose Primary image should represent this item, or undefined when
// there is no art (so CoverArt shows its placeholder instead of a broken image).
function imageItemId(item: JfItem): string | undefined {
  if (item.ImageTags?.Primary) return item.Id;
  if (item.AlbumId && item.AlbumPrimaryImageTag) return item.AlbumId;
  return undefined;
}

// Image URLs get the image's content tag appended so they're immutable: the
// browser (and our service worker) can cache them hard, and a re-tagged cover
// busts the cache on its own. Without it every render re-hits Jellyfin's
// resizer. Encoded into the id we hand the UI and split back out in
// coverArtUrl, since the UI only carries a single string.
function imageRef(item: JfItem): string | undefined {
  const id = imageItemId(item);
  if (!id) return undefined;
  const tag = id === item.Id ? item.ImageTags?.Primary : item.AlbumPrimaryImageTag;
  return tag ? `${id}|${tag}` : id;
}

function favMarker(item: JfItem): string | undefined {
  // The app treats `starred` as a truthy "is favourited" flag; Jellyfin has no
  // per-favourite timestamp, so use the last-played date if present else a
  // sentinel that is simply truthy.
  if (!item.UserData?.IsFavorite) return undefined;
  return item.UserData.LastPlayedDate ?? "favorite";
}

const SONG_FIELDS = "Genres,MediaSources,MediaStreams,Path,ParentIndexNumber,DateCreated";
const ALBUM_FIELDS = "Genres,DateCreated,ChildCount,PremiereDate";

// Read a query parameter without caring about case. Jellyfin emits PascalCase
// names and binds them case-insensitively, so a case-sensitive lookup would
// miss them and a case-sensitive *write* would silently duplicate them.
function getParam(url: URL, lowerName: string): string | null {
  for (const [k, v] of url.searchParams) {
    if (k.toLowerCase() === lowerName) return v;
  }
  return null;
}

function repeatModeFor(repeat?: "off" | "all" | "one"): string {
  return repeat === "all" ? "RepeatAll" : repeat === "one" ? "RepeatOne" : "RepeatNone";
}

export class JellyfinClient implements MusicClient {
  constructor(
    private creds: ServerCredentials,
    private opts: ClientOptions = {},
  ) {}

  readonly serverType: ServerType = "jellyfin";
  // Jellyfin has no server-side zip endpoint, so collection downloads are
  // assembled in the browser instead (features/download).
  readonly canDownloadCollections = false;
  readonly canEditServerImages = true;
  // Jellyfin playlists have no Subsonic-style public/private flag; sharing is
  // done by granting other users access to the playlist item.
  readonly canSetPlaylistVisibility = false;
  // Jellyfin stores a like/dislike, not a 0–5 scale.
  readonly hasFiveStarRatings = false;
  // Jellyfin can transcode on demand, so lossy downloads work per track.
  readonly canTranscodeDownloads = true;
  readonly playbackReporting: PlaybackReportingStyle = "session";

  // Restricts library reads to one Jellyfin music library. "" = every library.
  private libraryId = "";

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

  // Synchronous best-effort URL. Used for downloads and as the last-resort
  // fallback if negotiation fails — real playback goes through resolveStream.
  streamUrl(id: string, maxBitRate?: number, format?: string): string {
    if (!format && !maxBitRate) {
      return this.url(`/Audio/${id}/stream`, {
        static: "true",
        deviceId: this.deviceId,
        mediaSourceId: id,
      });
    }
    return this.url(`/Audio/${id}/stream.${format ?? "mp3"}`, {
      deviceId: this.deviceId,
      audioCodec: format ?? "mp3",
      audioBitRate: maxBitRate ? maxBitRate * 1000 : undefined,
      mediaSourceId: id,
    });
  }

  coverArtUrl(ref: string | undefined, size?: number): string {
    if (!ref) return "";
    // `ref` may carry the image tag (see imageRef) so the URL is immutable.
    const [id, tag] = ref.split("|");
    return this.url(`/Items/${id}/Images/Primary`, {
      fillWidth: size || undefined,
      fillHeight: size || undefined,
      quality: 90,
      tag,
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
    opts: {
      params?: Record<string, string | number | undefined>;
      body?: unknown;
      // Let the request outlive the page (used for the final stop report so
      // closing the tab still ends the Jellyfin session).
      keepalive?: boolean;
    } = {},
  ): Promise<T> {
    const u = new URL(`${this.creds.serverUrl}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      "X-Emby-Token": this.token,
      Authorization: jellyfinAuthHeader(this.deviceId, this.token),
      "X-Emby-Authorization": jellyfinAuthHeader(this.deviceId, this.token),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(u.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        keepalive: opts.keepalive,
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

  // Every /Items query is scoped to the selected music library (when one is
  // chosen) and to this user.
  private itemParams(
    extra: Record<string, string | number | undefined> = {},
  ): Record<string, string | number | undefined> {
    return {
      userId: this.userId,
      ...(this.libraryId ? { ParentId: this.libraryId } : {}),
      ...extra,
    };
  }

  // --- Mappers ----------------------------------------------------------------

  private toSong(item: JfItem): Song {
    const source = item.MediaSources?.[0];
    const audio =
      (item.MediaStreams ?? source?.MediaStreams ?? []).find((s) => s.Type === "Audio") ?? undefined;
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
      coverArt: imageRef(item),
      size: source?.Size,
      contentType: undefined,
      suffix: (item.Container ?? source?.Container)?.split(",")[0],
      codec: audio?.Codec,
      sampleRate: audio?.SampleRate,
      bitDepth: audio?.BitDepth,
      channels: audio?.Channels,
      duration: ticksToSeconds(item.RunTimeTicks),
      bitRate: source?.Bitrate
        ? Math.round(source.Bitrate / 1000)
        : audio?.BitRate
          ? Math.round(audio.BitRate / 1000)
          : undefined,
      path: item.Path,
      starred: favMarker(item),
      playCount: item.UserData?.PlayCount,
      played: item.UserData?.LastPlayedDate,
      created: item.DateCreated,
    };
  }

  private toAlbum(item: JfItem): Album {
    return {
      id: item.Id,
      name: item.Name,
      artist: item.AlbumArtist ?? item.AlbumArtists?.[0]?.Name,
      artistId: item.AlbumArtists?.[0]?.Id,
      coverArt: imageRef(item),
      songCount: item.ChildCount,
      duration: ticksToSeconds(item.RunTimeTicks),
      year: item.ProductionYear ?? (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : undefined),
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
      coverArt: imageRef(item),
      albumCount: item.AlbumCount,
      starred: favMarker(item),
    };
  }

  // --- Connectivity -----------------------------------------------------------

  async ping(): Promise<boolean> {
    await this.get("/System/Info/Public");
    return true;
  }

  async getServerInfo(): Promise<{ name?: string; version?: string } | null> {
    try {
      const info = await this.get<{ ServerName?: string; Version?: string }>("/System/Info/Public");
      return { name: info.ServerName, version: info.Version };
    } catch {
      return null;
    }
  }

  // Invalidate the access token server-side so signing out actually removes the
  // device from Jellyfin's Dashboard → Devices rather than leaving a live token.
  async revokeSession(): Promise<void> {
    try {
      await this.request("POST", "/Sessions/Logout");
    } catch {
      // Best effort — the local credentials are cleared regardless.
    }
  }

  // --- Libraries --------------------------------------------------------------

  // Music libraries this user can see. Jellyfin users often have several; the
  // Subsonic API has no equivalent so the UI only surfaces this for Jellyfin.
  async getLibraries(): Promise<LibraryView[]> {
    try {
      const data = await this.get<JfList>("/UserViews", { userId: this.userId });
      return (data.Items ?? [])
        .filter((v) => v.CollectionType === "music")
        .map((v) => ({ id: v.Id, name: v.Name }));
    } catch {
      return [];
    }
  }

  setLibrary(id: string): void {
    this.libraryId = id;
  }

  // --- Playback: stream negotiation -------------------------------------------

  // Ask Jellyfin how this track should be delivered, and to whom.
  //
  // The response tells us three things we can't safely guess: whether the
  // browser can take the file untouched, the exact transcode URL to use if not,
  // and the PlaySessionId that keys the server-side job. Reporting that id on
  // every subsequent call is what lets Jellyfin reuse one encode for the whole
  // track instead of starting a fresh one per HTTP range request.
  async resolveStream(id: string, opts: StreamOptions = {}): Promise<StreamHandle> {
    const startSeconds = Math.max(0, opts.startSeconds ?? 0);
    const startTicks = secondsToTicks(startSeconds);
    const profile = buildDeviceProfile({
      maxBitRateKbps: opts.maxBitRateKbps,
      forceTranscode: opts.forceTranscode,
    });

    let info: JfPlaybackInfo | null = null;
    try {
      info = await this.request<JfPlaybackInfo>("POST", `/Items/${id}/PlaybackInfo`, {
        params: { userId: this.userId },
        body: {
          UserId: this.userId,
          DeviceProfile: profile,
          MaxStreamingBitrate: profile.MaxStreamingBitrate,
          StartTimeTicks: startTicks,
          EnableDirectPlay: !opts.forceTranscode,
          EnableDirectStream: !opts.forceTranscode,
          EnableTranscoding: true,
          AllowAudioStreamCopy: true,
          AllowVideoStreamCopy: false,
          AutoOpenLiveStream: false,
        },
      });
    } catch {
      // Server too old, or the endpoint refused: fall through to /universal,
      // which performs the same negotiation server-side in a single GET.
    }

    const source = info?.MediaSources?.[0];
    const playSessionId = info?.PlaySessionId;

    if (source) {
      const duration = ticksToSeconds(source.RunTimeTicks);
      const directPlay = source.SupportsDirectPlay || source.SupportsDirectStream;

      // Direct play only if the browser genuinely handles the container. The
      // server matched our profile, but a source with an odd codec inside a
      // familiar container can still slip through.
      const audio = (source.MediaStreams ?? []).find((s) => s.Type === "Audio");
      if (directPlay && canPlayContainer(source.Container, audio?.Codec)) {
        return {
          url: this.url(`/Audio/${id}/stream`, {
            static: "true",
            mediaSourceId: source.Id ?? id,
            playSessionId,
            deviceId: this.deviceId,
            // A static response is a plain file: byte ranges land exactly where
            // the browser expects, so the element can seek by itself and we
            // never need a server-side offset.
          }),
          playSessionId,
          mediaSourceId: source.Id ?? id,
          playMethod: source.SupportsDirectPlay ? "DirectPlay" : "DirectStream",
          canSeek: true,
          startOffset: 0,
          duration,
        };
      }

      if (source.TranscodingUrl) {
        // Jellyfin hands back a fully-formed relative URL that already carries
        // its own PlaySessionId, ApiKey and encoder settings. Use it verbatim
        // rather than rebuilding it — that URL *is* the negotiated result.
        // Jellyfin spells its parameters in PascalCase and binds them
        // case-insensitively, so match that way or we'd add duplicates that bind
        // as arrays and break the request.
        const url = new URL(`${this.creds.serverUrl}${source.TranscodingUrl}`);
        if (!getParam(url, "apikey") && !getParam(url, "api_key")) {
          url.searchParams.set("api_key", this.token);
        }
        // The offset is already baked in — we asked for it in PlaybackInfo.
        if (startTicks > 0 && !getParam(url, "starttimeticks")) {
          url.searchParams.set("StartTimeTicks", String(startTicks));
        }
        return {
          url: url.toString(),
          playSessionId: getParam(url, "playsessionid") ?? playSessionId,
          mediaSourceId: source.Id ?? id,
          playMethod: "Transcode",
          // A live encode has no stable byte↔time mapping. Seeking is done by
          // re-requesting from a new startTimeTicks, not by moving currentTime.
          canSeek: false,
          startOffset: startSeconds,
          duration,
        };
      }
    }

    // Fallback: the universal endpoint runs the same profile matching on the
    // server and returns either the original file or a transcode.
    return {
      url: this.universalUrl(id, opts, startTicks),
      playSessionId,
      mediaSourceId: id,
      playMethod: undefined,
      // Unknown delivery method — assume the pessimistic case so seeking uses
      // the server-side offset path rather than producing garbage.
      canSeek: false,
      startOffset: startSeconds,
      duration: undefined,
    };
  }

  private universalUrl(id: string, opts: StreamOptions, startTicks: number): string {
    const profile = buildDeviceProfile({
      maxBitRateKbps: opts.maxBitRateKbps,
      forceTranscode: opts.forceTranscode,
    });
    const transcode = profile.TranscodingProfiles[0];
    return this.url(`/Audio/${id}/universal`, {
      userId: this.userId,
      deviceId: this.deviceId,
      container: profile.DirectPlayProfiles.map((p) =>
        p.AudioCodec ? `${p.Container}|${p.AudioCodec}` : p.Container,
      ).join(","),
      audioCodec: transcode.AudioCodec,
      transcodingContainer: transcode.Container,
      transcodingProtocol: "http",
      maxStreamingBitrate: profile.MaxStreamingBitrate,
      startTimeTicks: startTicks || undefined,
      enableRedirection: "true",
      enableRemoteMedia: "false",
    });
  }

  // --- Playback: session reporting --------------------------------------------

  // Jellyfin's playback lifecycle. Getting this right is what makes play counts
  // increment, "Now Playing" appear on the dashboard, resume positions stick,
  // and the server release its encoder when we're done with a track.
  async reportPlayback(event: PlaybackEvent, report: PlaybackReport): Promise<void> {
    const body: Record<string, unknown> = {
      ItemId: report.songId,
      MediaSourceId: report.stream?.mediaSourceId ?? report.songId,
      PlaySessionId: report.stream?.playSessionId,
      PositionTicks: secondsToTicks(report.positionSeconds),
      PlayMethod: report.stream?.playMethod ?? "DirectPlay",
      // A transcode can't be scrubbed in place, but we *can* restart it at a new
      // offset — from a remote's point of view the track is still seekable.
      CanSeek: true,
      IsPaused: event === "pause" ? true : (report.isPaused ?? false),
      IsMuted: report.isMuted ?? false,
      VolumeLevel: Math.round((report.volume ?? 1) * 100),
      RepeatMode: repeatModeFor(report.repeat),
      PlaybackOrder: report.shuffle ? "Shuffle" : "Default",
    };
    if (report.queue?.length) {
      body.NowPlayingQueue = report.queue.map((q, i) => ({
        Id: q.id,
        PlaylistItemId: q.playlistItemId ?? `playlistItem${i}`,
      }));
    }

    const path =
      event === "start"
        ? "/Sessions/Playing"
        : event === "stop"
          ? "/Sessions/Playing/Stopped"
          : "/Sessions/Playing/Progress";

    try {
      await this.request("POST", path, { body, keepalive: event === "stop" });
    } catch {
      // Reporting is telemetry, never a reason to interrupt playback.
    }
  }

  // Register what this client can do, so Jellyfin lists it as a controllable
  // device ("Play On" / remote control from the Jellyfin app or dashboard).
  async registerCapabilities(): Promise<void> {
    try {
      await this.request("POST", "/Sessions/Capabilities/Full", {
        body: {
          PlayableMediaTypes: ["Audio"],
          SupportedCommands: [
            "PlayState",
            "Play",
            "PlayNext",
            "VolumeUp",
            "VolumeDown",
            "SetVolume",
            "Mute",
            "Unmute",
            "ToggleMute",
            "SetRepeatMode",
            "SetShuffleQueue",
            // Only list what jellyfinRemote actually acts on — advertising a
            // command we ignore makes a remote's request vanish silently.
          ],
          SupportsMediaControl: true,
          SupportsPersistentIdentifier: true,
          DeviceProfile: buildDeviceProfile(),
        },
      });
    } catch {
      // Older server or restricted user — remote control simply won't appear.
    }
  }

  // This device's id, so the session list can tell "us" apart from the other
  // devices on the account (we always appear in our own /Sessions response).
  get myDeviceId(): string {
    return this.deviceId;
  }

  // --- Remote control: driving *other* sessions --------------------------------
  //
  // The mirror image of jellyfinRemote. Jellyfin's session API is a relay: this
  // app posts a command against another session's id and the server pushes it
  // down that device's own socket. Nothing is sent peer-to-peer, so a device is
  // controllable from here exactly when the server can still reach it.

  // Sessions on this account that this user is allowed to drive. The server
  // applies the permission check; the caller still filters out our own device
  // and anything that didn't advertise media control.
  async getSessions(): Promise<JfSessionInfo[]> {
    const list = await this.get<JfSessionInfo[]>("/Sessions", {
      ControllableByUserId: this.userId,
    });
    return Array.isArray(list) ? list : [];
  }

  // Transport commands: PlayPause, Pause, Unpause, Stop, NextTrack,
  // PreviousTrack, Seek, Rewind, FastForward.
  async sessionPlaystate(
    sessionId: string,
    command: string,
    seekPositionTicks?: number,
  ): Promise<void> {
    await this.request("POST", `/Sessions/${sessionId}/Playing/${command}`, {
      params: { seekPositionTicks },
    });
  }

  // Everything that isn't transport: SetVolume, Mute, SetRepeatMode, and so on.
  // Sent as a body rather than in the path so the arguments ride along.
  async sessionCommand(
    sessionId: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<void> {
    await this.request("POST", `/Sessions/${sessionId}/Command`, {
      body: { Name: name, Arguments: args ?? {} },
    });
  }

  // Push items to a session. PlayNow replaces its queue, PlayNext/PlayLast
  // splice into it. This is the same call the Jellyfin app's "Play On" makes.
  async sessionPlay(
    sessionId: string,
    itemIds: string[],
    playCommand: "PlayNow" | "PlayNext" | "PlayLast" = "PlayNow",
    opts: { startIndex?: number; startPositionTicks?: number } = {},
  ): Promise<void> {
    if (itemIds.length === 0) return;
    await this.request("POST", `/Sessions/${sessionId}/Playing`, {
      params: {
        playCommand,
        itemIds: itemIds.join(","),
        startIndex: opts.startIndex,
        startPositionTicks: opts.startPositionTicks,
      },
    });
  }

  // Resolve many track ids in one request, in the order asked for. Jellyfin
  // returns /Items in its own sort order and silently drops ids the user can't
  // see, so the result is re-keyed rather than trusted positionally.
  async getSongsByIds(ids: string[]): Promise<Song[]> {
    if (ids.length === 0) return [];
    const data = await this.get<JfList>("/Items", {
      userId: this.userId,
      ids: ids.join(","),
      Fields: SONG_FIELDS,
    });
    const byId = new Map<string, Song>();
    for (const item of data.Items ?? []) {
      const song = this.toSong(item);
      byId.set(song.id, song);
    }
    return ids.map((id) => byId.get(id)).filter((s): s is Song => s !== undefined);
  }

  // Map a NowPlayingItem straight from a session payload, so the UI can show
  // what a device is playing without a second round-trip for metadata.
  songFromItem(item: JfItem): Song {
    return this.toSong(item);
  }

  // WebSocket URL for the remote-control channel (see player/jellyfinRemote).
  remoteControlUrl(): string {
    const base = this.creds.serverUrl.replace(/^http/i, "ws");
    const u = new URL(`${base}/socket`);
    u.searchParams.set("api_key", this.token);
    u.searchParams.set("deviceId", this.deviceId);
    return u.toString();
  }

  // --- Library: artists -------------------------------------------------------

  async getArtists(): Promise<ArtistSummary[]> {
    const data = await this.get<JfList>("/Artists/AlbumArtists", {
      userId: this.userId,
      ...(this.libraryId ? { ParentId: this.libraryId } : {}),
      SortBy: "SortName",
      SortOrder: "Ascending",
    });
    return (data.Items ?? []).map((i) => this.toArtist(i));
  }

  async getArtist(id: string): Promise<Artist> {
    const item = await this.get<JfItem>(`/Items/${id}`, { userId: this.userId });
    const albumsData = await this.get<JfList>(
      "/Items",
      this.itemParams({
        AlbumArtistIds: id,
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        SortBy: "ProductionYear,PremiereDate,SortName",
        SortOrder: "Descending",
        Fields: ALBUM_FIELDS,
      }),
    );
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
    const params = this.itemParams({
      IncludeItemTypes: "MusicAlbum",
      Recursive: "true",
      Limit: opts.size ?? 50,
      StartIndex: opts.offset ?? 0,
      Fields: ALBUM_FIELDS,
    });

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
        params.Filters = "IsPlayed";
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
    const data = await this.get<JfList>(
      "/Items",
      this.itemParams({
        IncludeItemTypes: "Audio",
        Recursive: "true",
        SortBy: "Random",
        Limit: size,
        Genres: genre,
        Fields: SONG_FIELDS,
      }),
    );
    return (data.Items ?? []).map((s) => this.toSong(s));
  }

  async getTopSongs(artist: string, count = 50): Promise<Song[]> {
    // Subsonic keys this on the artist *name*; Jellyfin's Artists filter does too.
    const data = await this.get<JfList>(
      "/Items",
      this.itemParams({
        IncludeItemTypes: "Audio",
        Recursive: "true",
        Artists: artist,
        SortBy: "PlayCount,SortName",
        SortOrder: "Descending",
        Limit: count,
        Fields: SONG_FIELDS,
      }),
    );
    return (data.Items ?? []).map((s) => this.toSong(s));
  }

  async getSimilarSongs(id: string, count = 50): Promise<Song[]> {
    return this.getInstantMix(id, "song", count);
  }

  // Jellyfin's InstantMix is its radio generator, and it takes a seed of any
  // kind. Genres are seeded by name rather than id.
  async getInstantMix(
    id: string,
    kind: "song" | "album" | "artist" | "genre" = "song",
    count = 50,
  ): Promise<Song[]> {
    const path =
      kind === "genre"
        ? `/MusicGenres/${encodeURIComponent(id)}/InstantMix`
        : kind === "artist"
          ? `/Artists/${id}/InstantMix`
          : kind === "album"
            ? `/Albums/${id}/InstantMix`
            : `/Items/${id}/InstantMix`;
    try {
      const data = await this.get<JfList>(path, {
        userId: this.userId,
        Limit: count,
        Fields: SONG_FIELDS,
      });
      const songs = (data.Items ?? []).map((s) => this.toSong(s));
      if (songs.length > 0) return songs;
    } catch {
      // fall through
    }
    if (kind !== "song") return [];
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
      ...(this.libraryId ? { ParentId: this.libraryId } : {}),
      SortBy: "SortName",
      Fields: "ItemCounts",
    });
    // ItemCounts fills SongCount/AlbumCount where the server supports it; older
    // servers omit them and the UI falls back to hiding the count.
    return (data.Items ?? []).map((g) => ({
      value: g.Name,
      songCount: g.SongCount ?? 0,
      albumCount: g.AlbumCount ?? g.ChildCount ?? 0,
    }));
  }

  async getSongsByGenre(genre: string, count = 100, offset = 0): Promise<Song[]> {
    const data = await this.get<JfList>(
      "/Items",
      this.itemParams({
        IncludeItemTypes: "Audio",
        Recursive: "true",
        Genres: genre,
        SortBy: "Album,ParentIndexNumber,IndexNumber",
        Limit: count,
        StartIndex: offset,
        Fields: SONG_FIELDS,
      }),
    );
    return (data.Items ?? []).map((s) => this.toSong(s));
  }

  // --- Library stats ----------------------------------------------------------

  async getLibraryStats(): Promise<LibraryStats> {
    const count = async (params: Record<string, string | number>) => {
      const data = await this.get<JfList>(
        "/Items",
        this.itemParams({
          Recursive: "true",
          Limit: 0,
          EnableTotalRecordCount: "true",
          ...params,
        }),
      );
      return data.TotalRecordCount ?? 0;
    };
    const [albumCount, songCount, artistsData] = await Promise.all([
      count({ IncludeItemTypes: "MusicAlbum" }),
      count({ IncludeItemTypes: "Audio" }),
      this.get<JfList>("/Artists/AlbumArtists", {
        userId: this.userId,
        ...(this.libraryId ? { ParentId: this.libraryId } : {}),
        Limit: 0,
        EnableTotalRecordCount: "true",
      }),
    ]);
    return {
      artistCount: artistsData.TotalRecordCount ?? 0,
      albumCount,
      songCount,
      // Summing every track's file size would mean pulling MediaSources for the
      // whole library; not worth the request storm for one stat.
      totalSize: undefined,
    };
  }

  // Listening figures for the current user.
  //
  // Jellyfin keeps play counts and dates per user on every item, so most of this
  // is a matter of asking the right /Items question and reading
  // TotalRecordCount — no item bodies come back at all for the counts.
  //
  // The one figure that genuinely needs the rows is the *total* play count
  // (and the listening time derived from it), because that is a sum over
  // per-item PlayCount values with no server-side aggregate behind it. That walk
  // is sorted by play count descending and capped, so a library too big to count
  // in full still yields a number dominated by the tracks that actually matter,
  // flagged as approximate rather than presented as exact.
  //
  // Sub-queries are settled independently: an older server that rejects one sort
  // or filter leaves that field undefined instead of emptying the page.
  async getUserStats(): Promise<UserStats> {
    const PAGE = 500;
    const MAX_PAGES = 40; // 20k played tracks before we call it approximate
    const TOP = 8;

    // A count-only query: Limit 0 means Jellyfin returns the total and no items.
    const countOf = async (
      path: string,
      params: Record<string, string | number | undefined>,
    ): Promise<number> => {
      const data = await this.get<JfList>(path, params);
      return data.TotalRecordCount ?? 0;
    };
    const countItems = (params: Record<string, string | number | undefined>) =>
      countOf(
        "/Items",
        this.itemParams({ Recursive: "true", Limit: 0, EnableTotalRecordCount: "true", ...params }),
      );
    const artistParams = (extra: Record<string, string | number | undefined>) => ({
      userId: this.userId,
      ...(this.libraryId ? { ParentId: this.libraryId } : {}),
      ...extra,
    });

    // Sum PlayCount (and playtime) over every played track, biggest first.
    const walkPlays = async (): Promise<{
      totalPlays: number;
      listeningSeconds: number;
      topSongs: Song[];
      approximate: boolean;
    }> => {
      let totalPlays = 0;
      let listeningSeconds = 0;
      let topSongs: Song[] = [];
      let approximate = false;

      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) {
          approximate = true;
          break;
        }
        const data = await this.get<JfList>(
          "/Items",
          this.itemParams({
            IncludeItemTypes: "Audio",
            Recursive: "true",
            Filters: "IsPlayed",
            SortBy: "PlayCount",
            SortOrder: "Descending",
            EnableUserData: "true",
            StartIndex: page * PAGE,
            Limit: PAGE,
            ...(page === 0 ? { Fields: SONG_FIELDS } : {}),
          }),
        );
        const items = data.Items ?? [];
        if (page === 0) topSongs = items.slice(0, TOP).map((i) => this.toSong(i));
        for (const item of items) {
          const plays = item.UserData?.PlayCount ?? 0;
          totalPlays += plays;
          listeningSeconds += plays * (ticksToSeconds(item.RunTimeTicks) ?? 0);
        }
        // Descending by play count: once a page opens on zero, the rest are zero
        // too, so there is nothing left to add.
        if (items.length < PAGE) break;
        if ((items[items.length - 1]?.UserData?.PlayCount ?? 0) === 0) break;
      }
      return { totalPlays, listeningSeconds, topSongs, approximate };
    };

    const results = await Promise.allSettled([
      countItems({ IncludeItemTypes: "Audio", Filters: "IsPlayed" }),
      countItems({ IncludeItemTypes: "MusicAlbum", Filters: "IsPlayed" }),
      countItems({ IncludeItemTypes: "Audio", Filters: "IsFavorite" }),
      countItems({ IncludeItemTypes: "MusicAlbum", Filters: "IsFavorite" }),
      countOf(
        "/Artists/AlbumArtists",
        artistParams({ Filters: "IsPlayed", Limit: 0, EnableTotalRecordCount: "true" }),
      ),
      countOf(
        "/Artists/AlbumArtists",
        artistParams({ Filters: "IsFavorite", Limit: 0, EnableTotalRecordCount: "true" }),
      ),
      this.get<JfList>(
        "/Items",
        this.itemParams({
          IncludeItemTypes: "MusicAlbum",
          Recursive: "true",
          Filters: "IsPlayed",
          SortBy: "PlayCount",
          SortOrder: "Descending",
          EnableUserData: "true",
          Limit: TOP,
          Fields: ALBUM_FIELDS,
        }),
      ),
      this.get<JfList>(
        "/Artists/AlbumArtists",
        artistParams({
          SortBy: "PlayCount",
          SortOrder: "Descending",
          EnableUserData: "true",
          Limit: TOP,
        }),
      ),
      this.get<JfList>(
        "/Items",
        this.itemParams({
          IncludeItemTypes: "Audio",
          Recursive: "true",
          Filters: "IsPlayed",
          SortBy: "DatePlayed",
          SortOrder: "Descending",
          EnableUserData: "true",
          Limit: 1,
        }),
      ),
      walkPlays(),
    ] as const);

    const val = <T>(i: number): T | undefined =>
      results[i].status === "fulfilled"
        ? ((results[i] as PromiseFulfilledResult<T>).value)
        : undefined;

    const topAlbumList = val<JfList>(6);
    const topArtistList = val<JfList>(7);
    const lastPlayedList = val<JfList>(8);
    const walk = val<{
      totalPlays: number;
      listeningSeconds: number;
      topSongs: Song[];
      approximate: boolean;
    }>(9);

    return {
      tracksPlayed: val<number>(0),
      albumsPlayed: val<number>(1),
      favoriteSongs: val<number>(2),
      favoriteAlbums: val<number>(3),
      artistsPlayed: val<number>(4),
      favoriteArtists: val<number>(5),
      topAlbums: topAlbumList?.Items?.map((a) => this.toAlbum(a)),
      // Some servers ignore a PlayCount sort on the Artists endpoint and answer
      // in name order; dropping the never-played ones keeps a "most played" list
      // from being a plain alphabetical list in disguise.
      topArtists: topArtistList?.Items?.filter((a) => (a.UserData?.PlayCount ?? 0) > 0).map((a) => ({
        ...this.toArtist(a),
        playCount: a.UserData?.PlayCount,
      })),
      lastPlayed: lastPlayedList?.Items?.[0]?.UserData?.LastPlayedDate,
      totalPlays: walk?.totalPlays,
      listeningSeconds: walk?.listeningSeconds,
      topSongs: walk?.topSongs,
      approximate: walk?.approximate,
    };
  }

  // --- Starred / ratings ------------------------------------------------------

  async getStarred(): Promise<{ artist: ArtistSummary[]; album: Album[]; song: Song[] }> {
    const [songs, albums, artists] = await Promise.all([
      this.get<JfList>(
        "/Items",
        this.itemParams({
          IncludeItemTypes: "Audio",
          Recursive: "true",
          Filters: "IsFavorite",
          SortBy: "SortName",
          Fields: SONG_FIELDS,
        }),
      ),
      this.get<JfList>(
        "/Items",
        this.itemParams({
          IncludeItemTypes: "MusicAlbum",
          Recursive: "true",
          Filters: "IsFavorite",
          SortBy: "SortName",
          Fields: ALBUM_FIELDS,
        }),
      ),
      this.get<JfList>("/Artists/AlbumArtists", {
        userId: this.userId,
        ...(this.libraryId ? { ParentId: this.libraryId } : {}),
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

  // Jellyfin 10.10 moved the per-user write endpoints off the /Users/{id}
  // prefix. Try the current route, fall back to the legacy one so 10.8/10.9
  // servers keep working.
  private async userItemWrite(
    method: string,
    modern: string,
    legacy: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<void> {
    try {
      await this.request(method, modern, { params: { userId: this.userId, ...params } });
    } catch (err) {
      if (err instanceof ApiError && err.isAuthError) throw err;
      await this.request(method, legacy, { params });
    }
  }

  async star(id: string): Promise<void> {
    await this.userItemWrite(
      "POST",
      `/UserFavoriteItems/${id}`,
      `/Users/${this.userId}/FavoriteItems/${id}`,
    );
  }

  async unstar(id: string): Promise<void> {
    await this.userItemWrite(
      "DELETE",
      `/UserFavoriteItems/${id}`,
      `/Users/${this.userId}/FavoriteItems/${id}`,
    );
  }

  async setRating(id: string, rating: number): Promise<void> {
    // Jellyfin has a like/dislike, not a 0-5 scale. Map any positive rating to a
    // "like" and 0 to clearing it. Best-effort — never surfaces an error.
    try {
      if (rating > 0) {
        await this.userItemWrite(
          "POST",
          `/UserItems/${id}/Rating`,
          `/Users/${this.userId}/Items/${id}/Rating`,
          { Likes: "true" },
        );
      } else {
        await this.userItemWrite(
          "DELETE",
          `/UserItems/${id}/Rating`,
          `/Users/${this.userId}/Items/${id}/Rating`,
        );
      }
    } catch {
      // ignore
    }
  }

  // --- Scrobbling -------------------------------------------------------------

  // Kept for interface compatibility. Jellyfin's play counts come from the
  // session lifecycle (reportPlayback), so a Subsonic-style mid-track
  // "submission" must not be translated into /Sessions/Playing/Stopped — doing
  // that ends the session, drops Now Playing, and banks a bogus resume point.
  async scrobble(id: string, submission: boolean, time?: number): Promise<void> {
    if (submission) return;
    await this.reportPlayback("start", { songId: id, positionSeconds: time ?? 0 });
  }

  // --- Search -----------------------------------------------------------------

  async search(
    query: string,
    opts: { artistCount?: number; albumCount?: number; songCount?: number } = {},
  ): Promise<SearchResult> {
    const [artists, albums, songs] = await Promise.all([
      this.get<JfList>("/Artists/AlbumArtists", {
        userId: this.userId,
        ...(this.libraryId ? { ParentId: this.libraryId } : {}),
        searchTerm: query,
        Limit: opts.artistCount ?? 20,
      }),
      this.get<JfList>(
        "/Items",
        this.itemParams({
          IncludeItemTypes: "MusicAlbum",
          Recursive: "true",
          searchTerm: query,
          Limit: opts.albumCount ?? 20,
          Fields: ALBUM_FIELDS,
        }),
      ),
      this.get<JfList>(
        "/Items",
        this.itemParams({
          IncludeItemTypes: "Audio",
          Recursive: "true",
          searchTerm: query,
          Limit: opts.songCount ?? 50,
          Fields: SONG_FIELDS,
        }),
      ),
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
      Fields: "ChildCount,DateCreated",
      // Deliberately not filtered by MediaTypes: playlists created without an
      // explicit media type would disappear, and losing a user's playlist is
      // worse than occasionally listing a video one.
    });
    return (data.Items ?? []).map((p) => ({
      id: p.Id,
      name: p.Name,
      owner: this.username,
      public: false,
      songCount: p.ChildCount ?? 0,
      duration: ticksToSeconds(p.RunTimeTicks) ?? 0,
      created: p.DateCreated,
      coverArt: imageRef(p),
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
    const songs = (entries.Items ?? []).map((s) => ({
      ...this.toSong(s),
      playlistItemId: s.PlaylistItemId,
    }));
    return {
      id: item.Id,
      name: item.Name,
      owner: this.username,
      public: false,
      songCount: songs.length,
      duration: ticksToSeconds(item.RunTimeTicks) ?? 0,
      created: item.DateCreated,
      coverArt: imageRef(item),
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

  // Jellyfin has a real atomic move, so a drag-reorder is one request instead of
  // clearing the playlist and rebuilding it (which loses the entries if the
  // re-add half fails).
  async movePlaylistItem(id: string, fromIndex: number, toIndex: number): Promise<boolean> {
    try {
      const entries = await this.playlistEntryIds(id);
      const entryId = entries[fromIndex];
      if (!entryId) return false;
      await this.request("POST", `/Playlists/${id}/Items/${entryId}/Move/${toIndex}`);
      return true;
    } catch {
      return false;
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

  // Jellyfin answers in one request, so the artist/title hints the Subsonic
  // client needs are accepted and ignored.
  async getLyrics(id: string): Promise<StructuredLyrics[]> {
    const parse = (lines: { Text: string; Start?: number }[]): StructuredLyrics[] => {
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
    };

    try {
      const data = await this.get<{ Lyrics?: { Text: string; Start?: number }[] }>(
        `/Audio/${id}/Lyrics`,
      );
      return parse(data.Lyrics ?? []);
    } catch {
      // No lyrics for this track, or a server without the lyrics endpoint.
      return [];
    }
  }

  // --- Images -----------------------------------------------------------------

  // Jellyfin accepts a base64 image body with the image's MIME type as the
  // Content-Type, which is how playlist/album covers get set from a client.
  async uploadPlaylistImage(id: string, file: File): Promise<void> {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        // Strip the "data:image/png;base64," prefix — Jellyfin wants raw base64.
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new ApiError("Could not read the image file"));
      reader.readAsDataURL(file);
    });

    let res: Response;
    try {
      res = await fetch(`${this.creds.serverUrl}/Items/${id}/Images/Primary`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "image/jpeg",
          "X-Emby-Token": this.token,
          Authorization: jellyfinAuthHeader(this.deviceId, this.token),
        },
        body: base64,
      });
    } catch {
      throw new ApiError("Network error uploading cover");
    }
    if (res.status === 401) {
      this.opts.onAuthError?.(this.creds);
      throw new ApiError("Authentication expired", 401, true);
    }
    if (res.status === 403) {
      throw new ApiError("You don't have permission to edit this playlist.", 403);
    }
    if (!res.ok) throw new ApiError(`Cover upload failed (HTTP ${res.status})`, res.status);
  }

  // --- Backend-specific escape hatches ---------------------------------------

  getServerAuthHeaders(): Record<string, string> {
    return { "x-emby-token": this.token };
  }

  get subsonicAuth(): { u: string; t: string; s: string } {
    return { u: "", t: "", s: "" };
  }

  async createShare(): Promise<string | null> {
    return null;
  }
}
