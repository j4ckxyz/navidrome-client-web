// Per-server credential storage. Credentials are namespaced by server URL so a
// user can switch between servers without losing prior logins. The raw password
// is never persisted — only the Subsonic salt+token (a hash of the password)
// and, for native-API features, a refreshable JWT.

import { md5, randomSalt } from "./md5";
import { ApiError, type NativeLoginResponse } from "./types";
import type { ServerType } from "./MusicClient";
import {
  APP_VERSION,
  JELLYFIN_CLIENT,
  JELLYFIN_DEVICE_NAME,
  SUBSONIC_CLIENT,
} from "~/lib/branding";

const STORAGE_PREFIX = "nd:auth:";
const ACTIVE_KEY = "nd:auth:active";
const DEVICE_ID_KEY = "nd:device-id";

export interface ServerCredentials {
  // Which backend this login targets. Absent in records saved before Jellyfin
  // support existed — loadCredentials() defaults those to "navidrome" so users
  // stay logged in across an update.
  serverType: ServerType;
  serverUrl: string; // normalized, no trailing slash
  username: string;
  authMethod: "native" | "subsonic" | "jellyfin";
  // Subsonic / Navidrome auth. Empty strings for Jellyfin logins.
  subsonicSalt: string;
  subsonicToken: string;
  jwt?: string; // native JWT, refreshed from response headers
  // Jellyfin auth.
  accessToken?: string;
  userId?: string;
  deviceId?: string;
  isAdmin?: boolean;
  savedAt: number;
}

// A stable per-browser device id, required by Jellyfin's auth + session APIs.
// Persisted so the same browser keeps one identity across logins.
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new ApiError("Server URL is required");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  // Drop trailing slashes so endpoint joins are predictable.
  url = url.replace(/\/+$/, "");
  try {
    // Validate; throws on malformed input.
    new URL(url);
  } catch {
    throw new ApiError(`Invalid server URL: ${raw}`);
  }
  return url;
}

function storageKey(serverUrl: string): string {
  return `${STORAGE_PREFIX}${serverUrl}`;
}

export function saveCredentials(creds: ServerCredentials): void {
  localStorage.setItem(storageKey(creds.serverUrl), JSON.stringify(creds));
  localStorage.setItem(ACTIVE_KEY, creds.serverUrl);
}

export function loadCredentials(serverUrl: string): ServerCredentials | null {
  const raw = localStorage.getItem(storageKey(serverUrl));
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw) as ServerCredentials;
    // Backwards compat: records saved before Jellyfin support have no
    // serverType. They were all Navidrome, so default them to keep the user
    // logged in seamlessly after an update.
    if (!creds.serverType) creds.serverType = "navidrome";
    return creds;
  } catch {
    return null;
  }
}

export function loadActiveCredentials(): ServerCredentials | null {
  const active = localStorage.getItem(ACTIVE_KEY);
  if (!active) return null;
  return loadCredentials(active);
}

export function listKnownServers(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX) && key !== ACTIVE_KEY) {
      out.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return out;
}

export function clearCredentials(serverUrl: string): void {
  localStorage.removeItem(storageKey(serverUrl));
  if (localStorage.getItem(ACTIVE_KEY) === serverUrl) {
    localStorage.removeItem(ACTIVE_KEY);
  }
}

export function setActiveServer(serverUrl: string): void {
  localStorage.setItem(ACTIVE_KEY, serverUrl);
}

// Persist a refreshed JWT without touching the rest of the record.
export function updateJwt(serverUrl: string, jwt: string): void {
  const creds = loadCredentials(serverUrl);
  if (!creds) return;
  creds.jwt = jwt;
  localStorage.setItem(storageKey(serverUrl), JSON.stringify(creds));
}

// Primary login path: Navidrome's native endpoint. Returns a JWT *and* the
// Subsonic salt/token, so a single login serves both API surfaces.
export async function loginNative(
  serverUrl: string,
  username: string,
  password: string,
): Promise<ServerCredentials> {
  const url = `${serverUrl}/auth/login`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    throw new ApiError(
      `Could not reach ${serverUrl}. Check the URL and that the server allows this origin (CORS).`,
    );
  }
  if (res.status === 401) {
    throw new ApiError("Invalid username or password", 401, true);
  }
  if (!res.ok) {
    throw new ApiError(`Login failed (HTTP ${res.status})`, res.status);
  }
  const data = (await res.json()) as NativeLoginResponse;
  if (!data.subsonicSalt || !data.subsonicToken) {
    throw new ApiError("Server response missing Subsonic credentials");
  }
  return {
    serverType: "navidrome",
    serverUrl,
    username: data.username,
    authMethod: "native",
    subsonicSalt: data.subsonicSalt,
    subsonicToken: data.subsonicToken,
    jwt: data.token,
    isAdmin: data.isAdmin,
    savedAt: Date.now(),
  };
}

// Fallback path: pure Subsonic token auth. We generate a salt, derive the token
// locally, and verify with ping. Works against any Subsonic server and still
// avoids persisting the password.
export async function loginSubsonic(
  serverUrl: string,
  username: string,
  password: string,
): Promise<ServerCredentials> {
  const salt = randomSalt();
  const token = md5(password + salt);
  const params = new URLSearchParams({
    u: username,
    t: token,
    s: salt,
    v: "1.16.1",
    c: SUBSONIC_CLIENT,
    f: "json",
  });
  const url = `${serverUrl}/rest/ping.view?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError(
      `Could not reach ${serverUrl}. Check the URL and that the server allows this origin (CORS).`,
    );
  }
  if (!res.ok) throw new ApiError(`Login failed (HTTP ${res.status})`, res.status);
  const body = await res.json();
  const sub = body["subsonic-response"];
  if (!sub || sub.status !== "ok") {
    const msg = sub?.error?.message ?? "Invalid username or password";
    throw new ApiError(msg, sub?.error?.code, true);
  }
  return {
    serverType: "navidrome",
    serverUrl,
    username,
    authMethod: "subsonic",
    subsonicSalt: salt,
    subsonicToken: token,
    savedAt: Date.now(),
  };
}

// Token-direct path: the user already holds a Subsonic salt+token pair.
export async function loginWithToken(
  serverUrl: string,
  username: string,
  salt: string,
  token: string,
): Promise<ServerCredentials> {
  const params = new URLSearchParams({
    u: username,
    t: token,
    s: salt,
    v: "1.16.1",
    c: SUBSONIC_CLIENT,
    f: "json",
  });
  const res = await fetch(`${serverUrl}/rest/ping.view?${params.toString()}`).catch(() => {
    throw new ApiError(`Could not reach ${serverUrl}.`);
  });
  const body = await res.json();
  const sub = body["subsonic-response"];
  if (!sub || sub.status !== "ok") {
    throw new ApiError(sub?.error?.message ?? "Token rejected", sub?.error?.code, true);
  }
  return {
    serverType: "navidrome",
    serverUrl,
    username,
    authMethod: "subsonic",
    subsonicSalt: salt,
    subsonicToken: token,
    savedAt: Date.now(),
  };
}

// --- Jellyfin ---------------------------------------------------------------

// The X-Emby-Authorization header Jellyfin expects on auth (and accepts on every
// request). Carries the client identity + this browser's device id.
export function jellyfinAuthHeader(deviceId: string, token?: string): string {
  const parts = [
    `MediaBrowser Client="${JELLYFIN_CLIENT}"`,
    `Device="${JELLYFIN_DEVICE_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${APP_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

// Password login against a Jellyfin server. Returns an access token + the user
// id everything else is scoped to.
export async function loginJellyfin(
  serverUrl: string,
  username: string,
  password: string,
): Promise<ServerCredentials> {
  const deviceId = getDeviceId();
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Emby-Authorization": jellyfinAuthHeader(deviceId),
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
  } catch {
    throw new ApiError(
      `Could not reach ${serverUrl}. Check the URL and that the server allows this origin (CORS).`,
    );
  }
  if (res.status === 401) {
    throw new ApiError("Invalid username or password", 401, true);
  }
  if (!res.ok) {
    throw new ApiError(`Login failed (HTTP ${res.status})`, res.status);
  }
  const data = (await res.json()) as {
    AccessToken?: string;
    User?: { Id?: string; Name?: string; Policy?: { IsAdministrator?: boolean } };
  };
  if (!data.AccessToken || !data.User?.Id) {
    throw new ApiError("Server response missing access token");
  }
  return jellyfinCreds(serverUrl, deviceId, data, username);
}

interface JellyfinAuthResult {
  AccessToken?: string;
  User?: { Id?: string; Name?: string; Policy?: { IsAdministrator?: boolean } };
}

function jellyfinCreds(
  serverUrl: string,
  deviceId: string,
  data: JellyfinAuthResult,
  fallbackName = "",
): ServerCredentials {
  if (!data.AccessToken || !data.User?.Id) {
    throw new ApiError("Server response missing access token");
  }
  return {
    serverType: "jellyfin",
    serverUrl,
    username: data.User.Name ?? fallbackName,
    authMethod: "jellyfin",
    subsonicSalt: "",
    subsonicToken: "",
    accessToken: data.AccessToken,
    userId: data.User.Id,
    deviceId,
    isAdmin: data.User.Policy?.IsAdministrator ?? false,
    savedAt: Date.now(),
  };
}

// --- Jellyfin Quick Connect --------------------------------------------------
//
// Sign in without typing a password: the server issues a short code, the user
// approves it from an already-signed-in Jellyfin client, and this device gets
// its own access token. Every mainstream Jellyfin client offers this, and it's
// the only comfortable way to sign in on a TV or a shared machine.

export interface QuickConnectRequest {
  secret: string;
  code: string;
}

export async function quickConnectAvailable(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/QuickConnect/Enabled`);
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

export async function quickConnectInitiate(serverUrl: string): Promise<QuickConnectRequest> {
  const deviceId = getDeviceId();
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/QuickConnect/Initiate`, {
      method: "POST",
      headers: {
        Authorization: jellyfinAuthHeader(deviceId),
        "X-Emby-Authorization": jellyfinAuthHeader(deviceId),
      },
    });
  } catch {
    throw new ApiError(`Could not reach ${serverUrl}.`);
  }
  if (res.status === 401) {
    throw new ApiError("Quick Connect is disabled on this server.", 401);
  }
  if (!res.ok) throw new ApiError(`Quick Connect failed (HTTP ${res.status})`, res.status);
  const data = (await res.json()) as { Secret?: string; Code?: string };
  if (!data.Secret || !data.Code) throw new ApiError("Quick Connect returned no code");
  return { secret: data.Secret, code: data.Code };
}

// Has the user approved the code yet? Returns null while still pending.
export async function quickConnectPoll(
  serverUrl: string,
  secret: string,
): Promise<ServerCredentials | null> {
  const deviceId = getDeviceId();
  const state = await fetch(
    `${serverUrl}/QuickConnect/Connect?secret=${encodeURIComponent(secret)}`,
  ).catch(() => null);
  if (!state) throw new ApiError(`Could not reach ${serverUrl}.`);
  if (state.status === 404) throw new ApiError("This Quick Connect code expired. Start again.");
  if (!state.ok) throw new ApiError(`Quick Connect failed (HTTP ${state.status})`, state.status);
  const result = (await state.json()) as { Authenticated?: boolean };
  if (!result.Authenticated) return null;

  const res = await fetch(`${serverUrl}/Users/AuthenticateWithQuickConnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: jellyfinAuthHeader(deviceId),
      "X-Emby-Authorization": jellyfinAuthHeader(deviceId),
    },
    body: JSON.stringify({ Secret: secret }),
  }).catch(() => null);
  if (!res?.ok) throw new ApiError("Quick Connect approval could not be exchanged for a token");
  return jellyfinCreds(serverUrl, deviceId, (await res.json()) as JellyfinAuthResult);
}
