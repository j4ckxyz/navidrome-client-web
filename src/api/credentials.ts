// Per-server credential storage. Credentials are namespaced by server URL so a
// user can switch between servers without losing prior logins. The raw password
// is never persisted — only the Subsonic salt+token (a hash of the password)
// and, for native-API features, a refreshable JWT.

import { md5, randomSalt } from "./md5";
import { ApiError, type NativeLoginResponse } from "./types";

const STORAGE_PREFIX = "nd:auth:";
const ACTIVE_KEY = "nd:auth:active";

export interface ServerCredentials {
  serverUrl: string; // normalized, no trailing slash
  username: string;
  authMethod: "native" | "subsonic";
  subsonicSalt: string;
  subsonicToken: string;
  jwt?: string; // native JWT, refreshed from response headers
  savedAt: number;
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
    return JSON.parse(raw) as ServerCredentials;
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
    serverUrl,
    username: data.username,
    authMethod: "native",
    subsonicSalt: data.subsonicSalt,
    subsonicToken: data.subsonicToken,
    jwt: data.token,
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
    c: "navidrome-web",
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
    c: "navidrome-web",
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
    serverUrl,
    username,
    authMethod: "subsonic",
    subsonicSalt: salt,
    subsonicToken: token,
    savedAt: Date.now(),
  };
}
