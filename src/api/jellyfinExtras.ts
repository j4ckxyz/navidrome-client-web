// Optional Jellyfin *companion* connection — distinct from api/jellyfin.ts,
// which lets Jellyfin be the main music backend. Whatever the primary library
// is, a companion Jellyfin server contributes two extras:
//   - Live TV channels (m3u tuners) played as internet radio
//   - Music videos matched to the currently playing song
//
// The session (server URL + access token) lives in localStorage under
// `nd:jellyfin-extras`, separate from primary credentials, and is exposed as a
// signal so UI can react to connect/disconnect.

import { createSignal } from "solid-js";

const STORAGE_KEY = "nd:jellyfin-extras";
const CLIENT_NAME = "Navidrome Web";
const CLIENT_VERSION = "0.1.0";

export interface JellyfinSession {
  serverUrl: string; // normalized, no trailing slash
  username: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type?: string;
  ChannelType?: "TV" | "Radio";
  Number?: string;
  ImageTags?: Record<string, string>;
  AlbumArtist?: string;
  Artists?: string[];
  ProductionYear?: number;
  RunTimeTicks?: number;
  Container?: string;
  CurrentProgram?: { Name?: string };
}

export interface JellyfinMediaSource {
  Id?: string;
  Path?: string;
  Protocol?: string;
  Container?: string;
  SupportsDirectPlay?: boolean;
  IsInfiniteStream?: boolean;
  TranscodingUrl?: string;
}

const [session, setSession] = createSignal<JellyfinSession | null>(loadSession());

export { session as jellyfin };

function loadSession(): JellyfinSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as JellyfinSession;
    if (s.serverUrl && s.userId && s.accessToken) return s;
  } catch {
    // corrupt or unavailable storage — treat as signed out
  }
  return null;
}

function persistSession(s: JellyfinSession | null): void {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore quota errors
  }
}

export function normalizeJellyfinUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function deviceId(): string {
  const existing = session()?.deviceId;
  if (existing) return existing;
  try {
    const cached = localStorage.getItem("nd:jellyfin-device");
    if (cached) return cached;
    const id = crypto.randomUUID();
    localStorage.setItem("nd:jellyfin-device", id);
    return id;
  } catch {
    return "navidrome-web";
  }
}

function authHeader(token?: string): string {
  const parts = [
    `MediaBrowser Client="${CLIENT_NAME}"`,
    `Device="Browser"`,
    `DeviceId="${deviceId()}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

export async function jellyfinLogin(
  serverUrl: string,
  username: string,
  password: string,
): Promise<void> {
  const base = normalizeJellyfinUrl(serverUrl);
  const res = await fetch(`${base}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "Wrong username or password"
        : `Jellyfin returned ${res.status}`,
    );
  }
  const data = (await res.json()) as {
    AccessToken: string;
    User: { Id: string; Name: string };
  };
  const s: JellyfinSession = {
    serverUrl: base,
    username: data.User.Name,
    userId: data.User.Id,
    accessToken: data.AccessToken,
    deviceId: deviceId(),
  };
  persistSession(s);
  setSession(s);
}

export function jellyfinLogout(): void {
  persistSession(null);
  setSession(null);
}

// Authenticated GET against the Jellyfin API. Throws on non-2xx; a 401 clears
// the stored session so the UI falls back to the connect form.
async function jfGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const s = session();
  if (!s) throw new Error("Not connected to Jellyfin");
  const url = new URL(`${s.serverUrl}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(s.accessToken) },
  });
  if (res.status === 401) {
    jellyfinLogout();
    throw new Error("Jellyfin session expired — please reconnect");
  }
  if (!res.ok) throw new Error(`Jellyfin returned ${res.status}`);
  return (await res.json()) as T;
}

// --- Live TV / radio ---------------------------------------------------------

// All Live TV channels the user can see. m3u radio stations usually come
// through the Live TV tuner; ChannelType distinguishes "Radio" from "TV" when
// the tuner labels them, but plenty of m3u playlists mark everything "TV".
export async function getLiveTvChannels(): Promise<JellyfinItem[]> {
  const s = session();
  if (!s) return [];
  const data = await jfGet<{ Items: JellyfinItem[] }>("/LiveTv/Channels", {
    userId: s.userId,
    addCurrentProgram: "true",
    enableImageTypes: "Primary",
  });
  return data.Items ?? [];
}

// Resolve a playable stream URL for a channel. m3u tuner channels carry the
// original stream URL in their media source Path — playing that directly is
// gapless and puts zero transcode load on Jellyfin. Fall back to Jellyfin's
// stream endpoint when the source isn't a plain HTTP stream.
export async function getChannelStreamUrl(channelId: string): Promise<string> {
  const s = session();
  if (!s) throw new Error("Not connected to Jellyfin");
  try {
    const info = await jfGet<{ MediaSources?: JellyfinMediaSource[] }>(
      `/Items/${channelId}/PlaybackInfo`,
      { userId: s.userId },
    );
    const src = (info.MediaSources ?? []).find(
      (m) => m.Path && /^https?:\/\//i.test(m.Path) && m.Protocol !== "File",
    );
    if (src?.Path) return src.Path;
  } catch {
    // fall through to the server-side stream endpoint
  }
  const q = new URLSearchParams({
    static: "true",
    api_key: s.accessToken,
    deviceId: s.deviceId,
  });
  return `${s.serverUrl}/Videos/${channelId}/stream?${q}`;
}

// --- Music videos ------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\(.*?\)|\[.*?\]/g, "") // drop "(Official Video)" etc.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Raw music-video search against the Jellyfin library.
export async function searchMusicVideos(term: string, limit = 24): Promise<JellyfinItem[]> {
  const s = session();
  if (!s) return [];
  const data = await jfGet<{ Items: JellyfinItem[] }>("/Items", {
    userId: s.userId,
    searchTerm: term,
    includeItemTypes: "MusicVideo",
    recursive: "true",
    limit: String(limit),
    fields: "Artists",
    enableImages: "true",
  });
  return data.Items ?? [];
}

// Find the best music-video match for a song. Search Jellyfin by title, then
// require the title to match and prefer results whose artist lines up.
export async function findMusicVideo(
  title: string,
  artist?: string,
): Promise<JellyfinItem | null> {
  const s = session();
  if (!s) return null;
  const items = await searchMusicVideos(title);
  const wantTitle = normalize(title);
  const wantArtist = normalize(artist ?? "");
  let best: JellyfinItem | null = null;
  let bestScore = 0;
  for (const item of items) {
    const gotTitle = normalize(item.Name ?? "");
    if (!gotTitle) continue;
    let score = 0;
    if (gotTitle === wantTitle) score += 4;
    else if (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)) score += 2;
    else continue;
    // Artist can live in the Artists tags — or, for "Artist - Title (Official
    // Video)"-style filenames, only in the item name itself.
    const artists = [...(item.Artists ?? []), item.AlbumArtist ?? ""].map(normalize);
    const artistMatch =
      wantArtist &&
      (artists.some((a) => a && (a === wantArtist || a.includes(wantArtist) || wantArtist.includes(a))) ||
        gotTitle.includes(wantArtist));
    if (artistMatch) score += 3;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  // Without an artist match we still accept an exact title hit — small libraries
  // often have sparse artist tags on videos.
  return bestScore >= 4 || (bestScore >= 2 && !wantArtist) ? best : null;
}

// --- URLs --------------------------------------------------------------------

export function jellyfinImageUrl(item: JellyfinItem, maxWidth = 400): string | null {
  const s = session();
  if (!s || !item.ImageTags?.Primary) return null;
  const q = new URLSearchParams({
    maxWidth: String(maxWidth),
    tag: item.ImageTags.Primary,
    quality: "90",
  });
  return `${s.serverUrl}/Items/${item.Id}/Images/Primary?${q}`;
}

// Direct-play video stream. Browsers handle mp4/webm containers natively;
// static=true asks Jellyfin for the untouched file.
export function jellyfinVideoUrl(itemId: string): string {
  const s = session();
  if (!s) return "";
  const q = new URLSearchParams({
    static: "true",
    api_key: s.accessToken,
    deviceId: s.deviceId,
  });
  return `${s.serverUrl}/Videos/${itemId}/stream?${q}`;
}
