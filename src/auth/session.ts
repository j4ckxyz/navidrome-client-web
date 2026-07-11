// Global auth/session state. Holds the active API client and drives the
// login/re-login flow. On an auth error from any request, `reauthRequired` flips
// so the UI can prompt for the password again instead of failing silently.

import { createSignal } from "solid-js";
import { SubsonicClient } from "~/api/client";
import { JellyfinClient } from "~/api/jellyfin";
import type { MusicClient, ServerType } from "~/api/MusicClient";
import {
  clearCredentials,
  loadActiveCredentials,
  loginJellyfin,
  loginNative,
  loginSubsonic,
  loginWithToken,
  normalizeServerUrl,
  saveCredentials,
  setActiveServer,
  type ServerCredentials,
} from "~/api/credentials";

const [client, setClient] = createSignal<MusicClient | null>(null);
const [reauthRequired, setReauthRequired] = createSignal(false);
const [activeServerUrl, setActiveServerUrl] = createSignal<string | null>(null);
const [activeUsername, setActiveUsername] = createSignal<string | null>(null);
const [isAdmin, setIsAdmin] = createSignal(false);

export { client, reauthRequired, activeServerUrl, activeUsername, isAdmin };

function buildClient(creds: ServerCredentials): MusicClient {
  const opts = { onAuthError: () => setReauthRequired(true) };
  return creds.serverType === "jellyfin"
    ? new JellyfinClient(creds, opts)
    : new SubsonicClient(creds, opts);
}

// Restore a previous session on boot, if any.
export function initSession(): void {
  const creds = loadActiveCredentials();
  if (creds) {
    setClient(buildClient(creds));
    setActiveServerUrl(creds.serverUrl);
    setActiveUsername(creds.username);
    setIsAdmin(creds.isAdmin ?? false);
  }
}

export type LoginMethod = "auto" | "native" | "subsonic";

export interface LoginParams {
  serverType?: ServerType;
  serverUrl: string;
  username: string;
  password?: string;
  // Direct token auth (Navidrome/Subsonic only): provide both.
  salt?: string;
  token?: string;
  method?: LoginMethod;
}

export async function login(params: LoginParams): Promise<void> {
  const serverUrl = normalizeServerUrl(params.serverUrl);
  let creds: ServerCredentials;

  if (params.serverType === "jellyfin") {
    if (!params.password) throw new Error("Provide a password");
    creds = await loginJellyfin(serverUrl, params.username, params.password);
  } else if (params.salt && params.token) {
    creds = await loginWithToken(serverUrl, params.username, params.salt, params.token);
  } else if (params.password) {
    const method = params.method ?? "auto";
    if (method === "subsonic") {
      creds = await loginSubsonic(serverUrl, params.username, params.password);
    } else {
      // Auto: try native first (gives us JWT + subsonic creds), fall back to
      // pure Subsonic for non-Navidrome or differently-configured servers.
      try {
        creds = await loginNative(serverUrl, params.username, params.password);
      } catch (e) {
        if (method === "native") throw e;
        creds = await loginSubsonic(serverUrl, params.username, params.password);
      }
    }
  } else {
    throw new Error("Provide a password or a salt+token pair");
  }

  saveCredentials(creds);
  setActiveServer(creds.serverUrl);
  setClient(buildClient(creds));
  setActiveServerUrl(creds.serverUrl);
  setActiveUsername(creds.username);
  setIsAdmin(creds.isAdmin ?? false);
  setReauthRequired(false);
}

// Switch to a previously-saved server without re-entering the password.
export function switchServer(creds: ServerCredentials): void {
  setActiveServer(creds.serverUrl);
  setClient(buildClient(creds));
  setActiveServerUrl(creds.serverUrl);
  setActiveUsername(creds.username);
  setIsAdmin(creds.isAdmin ?? false);
  setReauthRequired(false);
}

export function logout(): void {
  const url = activeServerUrl();
  if (url) clearCredentials(url);
  setClient(null);
  setActiveServerUrl(null);
  setActiveUsername(null);
  setIsAdmin(false);
  setReauthRequired(false);
}

// Require a non-null client. Components under the authed shell can rely on this.
export function requireClient(): MusicClient {
  const c = client();
  if (!c) throw new Error("No active session");
  return c;
}
