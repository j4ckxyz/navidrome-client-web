// Global auth/session state. Holds the active API client and drives the
// login/re-login flow. On an auth error from any request, `reauthRequired` flips
// so the UI can prompt for the password again instead of failing silently.

import { createSignal } from "solid-js";
import { SubsonicClient } from "~/api/client";
import {
  clearCredentials,
  loadActiveCredentials,
  loginNative,
  loginSubsonic,
  loginWithToken,
  normalizeServerUrl,
  saveCredentials,
  setActiveServer,
  type ServerCredentials,
} from "~/api/credentials";

const [client, setClient] = createSignal<SubsonicClient | null>(null);
const [reauthRequired, setReauthRequired] = createSignal(false);
const [activeServerUrl, setActiveServerUrl] = createSignal<string | null>(null);
const [activeUsername, setActiveUsername] = createSignal<string | null>(null);
const [isAdmin, setIsAdmin] = createSignal(false);

export { client, reauthRequired, activeServerUrl, activeUsername, isAdmin };

function buildClient(creds: ServerCredentials): SubsonicClient {
  return new SubsonicClient(creds, {
    onAuthError: () => setReauthRequired(true),
  });
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
  serverUrl: string;
  username: string;
  password?: string;
  // Direct token auth: provide both.
  salt?: string;
  token?: string;
  method?: LoginMethod;
}

export async function login(params: LoginParams): Promise<void> {
  const serverUrl = normalizeServerUrl(params.serverUrl);
  let creds: ServerCredentials;

  if (params.salt && params.token) {
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
export function requireClient(): SubsonicClient {
  const c = client();
  if (!c) throw new Error("No active session");
  return c;
}
