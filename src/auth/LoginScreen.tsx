// First-run setup / login. Talks directly to the user's music server from the
// browser. Supports Navidrome (native or Subsonic / direct token) and Jellyfin
// (username + password, or Quick Connect). The chosen backend is stored with
// the credentials so the app knows which API surface to use. Shows previously-
// used servers for quick switching.

import { createSignal, For, onCleanup, Show } from "solid-js";
import { adoptCredentials, login, switchServer } from "./session";
import {
  listKnownServers,
  loadCredentials,
  normalizeServerUrl,
  quickConnectAvailable,
  quickConnectInitiate,
  quickConnectPoll,
} from "~/api/credentials";
import type { ServerType } from "~/api/MusicClient";
import { ApiError } from "~/api/types";
import { Icon } from "~/ui/Icon";
import { proxyMode } from "~/lib/serverConfig";
import { APP_NAME } from "~/lib/branding";
import "./login.css";

export function LoginScreen(props: { reauth?: boolean; prefillServer?: string; prefillUser?: string }) {
  const prefillCreds = props.prefillServer ? loadCredentials(props.prefillServer) : null;
  const [serverType, setServerType] = createSignal<ServerType>(prefillCreds?.serverType ?? "navidrome");
  const [serverUrl, setServerUrl] = createSignal(props.prefillServer ?? "");
  const [username, setUsername] = createSignal(props.prefillUser ?? "");
  const [password, setPassword] = createSignal("");
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [method, setMethod] = createSignal<"auto" | "native" | "subsonic">("auto");
  const [salt, setSalt] = createSignal("");
  const [token, setToken] = createSignal("");
  const [useToken, setUseToken] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const knownServers = listKnownServers().filter((s) => s !== props.prefillServer);

  const isJellyfin = () => serverType() === "jellyfin";
  // The bundled proxy only fronts Navidrome, so Jellyfin always connects direct
  // to a user-supplied URL even when the app is running in proxy mode.
  const needsServerUrl = () => isJellyfin() || !proxyMode();

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const url =
        !isJellyfin() && proxyMode() ? window.location.origin : serverUrl();
      await login({
        serverType: serverType(),
        serverUrl: url,
        username: username(),
        password: useToken() && !isJellyfin() ? undefined : password(),
        salt: useToken() && !isJellyfin() ? salt() : undefined,
        token: useToken() && !isJellyfin() ? token() : undefined,
        method: method(),
      });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  function quickSwitch(url: string) {
    const creds = loadCredentials(url);
    if (creds) switchServer(creds);
  }

  // --- Quick Connect ---
  //
  // Jellyfin issues a six-character code; the user approves it from a client
  // that's already signed in, and this device gets its own token. No password
  // ever touches this machine, which is the point on a TV or a shared browser.

  const [qcCode, setQcCode] = createSignal<string | null>(null);
  let qcPoll: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => {
    if (qcPoll) clearInterval(qcPoll);
  });

  function stopQuickConnect() {
    if (qcPoll) clearInterval(qcPoll);
    qcPoll = undefined;
    setQcCode(null);
  }

  async function startQuickConnect() {
    setError(null);
    let url: string;
    try {
      url = normalizeServerUrl(serverUrl());
    } catch {
      setError("Enter your Jellyfin server URL first.");
      return;
    }
    setBusy(true);
    try {
      if (!(await quickConnectAvailable(url))) {
        throw new ApiError("Quick Connect isn't enabled on this server.");
      }
      const { secret, code } = await quickConnectInitiate(url);
      setQcCode(code);
      qcPoll = setInterval(async () => {
        try {
          const creds = await quickConnectPoll(url, secret);
          if (creds) {
            stopQuickConnect();
            adoptCredentials(creds);
          }
        } catch (err) {
          stopQuickConnect();
          setError(err instanceof Error ? err.message : "Quick Connect failed");
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quick Connect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          <div class="login-logo">
            <Icon name="disc" size={28} />
          </div>
          <div>
            <h1>
              {props.reauth
                ? "Session expired"
                : `${APP_NAME} · connect to ${isJellyfin() ? "Jellyfin" : "Navidrome"}`}
            </h1>
            <p class="muted">
              {props.reauth
                ? "Your login expired. Re-enter your password to continue."
                : isJellyfin()
                  ? "Enter your Jellyfin server details and account."
                  : proxyMode()
                    ? "Enter your Navidrome username and password."
                    : "Enter your server details. Everything runs in your browser."}
            </p>
          </div>
        </div>

        <Show when={!props.reauth}>
          <div class="login-servertype" role="tablist" aria-label="Server type">
            <button
              type="button"
              role="tab"
              class="login-servertype-btn"
              classList={{ active: !isJellyfin() }}
              aria-selected={!isJellyfin()}
              onClick={() => setServerType("navidrome")}
            >
              <Icon name="disc" size={15} /> Navidrome
            </button>
            <button
              type="button"
              role="tab"
              class="login-servertype-btn"
              classList={{ active: isJellyfin() }}
              aria-selected={isJellyfin()}
              onClick={() => setServerType("jellyfin")}
            >
              <Icon name="server" size={15} /> Jellyfin
            </button>
          </div>
        </Show>

        <form onSubmit={submit} class="login-form">
          <Show when={needsServerUrl()}>
            <div class="field">
              <label for="server">Server URL</label>
              <input
                id="server"
                class="input"
                type="text"
                placeholder="https://music.example.com"
                value={serverUrl()}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
                disabled={props.reauth}
                autocomplete="url"
                required={needsServerUrl()}
              />
            </div>
          </Show>

          <div class="field">
            <label for="username">Username</label>
            <input
              id="username"
              class="input"
              type="text"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              autocomplete="username"
              required
            />
          </div>

          <Show
            when={!useToken() || isJellyfin()}
            fallback={
              <div class="login-row">
                <div class="field">
                  <label for="salt">Salt</label>
                  <input id="salt" class="input" value={salt()} onInput={(e) => setSalt(e.currentTarget.value)} />
                </div>
                <div class="field">
                  <label for="token">Token</label>
                  <input id="token" class="input" value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
                </div>
              </div>
            }
          >
            <div class="field">
              <label for="password">Password</label>
              <input
                id="password"
                class="input"
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                autocomplete="current-password"
                required
              />
            </div>
          </Show>

          <Show when={error()}>
            <div class="login-error" role="alert">
              {error()}
            </div>
          </Show>

          <button class="btn btn-primary login-submit" type="submit" disabled={busy()}>
            <Show when={busy()} fallback={props.reauth ? "Reconnect" : "Connect"}>
              <span class="spinner" style={{ width: "16px", height: "16px" }} /> Connecting…
            </Show>
          </button>

          {/* Quick Connect is Jellyfin's password-free sign-in. */}
          <Show when={isJellyfin() && !props.reauth}>
            <Show
              when={qcCode()}
              fallback={
                <button
                  type="button"
                  class="login-advanced-toggle"
                  onClick={() => void startQuickConnect()}
                  disabled={busy()}
                >
                  <Icon name="link" size={14} />
                  Use Quick Connect instead
                </button>
              }
            >
              <div class="login-quickconnect">
                <p class="muted">
                  In any signed-in Jellyfin app, open the user menu → Quick Connect and enter:
                </p>
                <div class="login-quickconnect-code">{qcCode()}</div>
                <p class="muted">
                  <span class="spinner" style={{ width: "13px", height: "13px" }} /> Waiting for
                  approval…
                </p>
                <button type="button" class="login-advanced-toggle" onClick={stopQuickConnect}>
                  Cancel
                </button>
              </div>
            </Show>
          </Show>

          {/* Advanced auth options are Navidrome/Subsonic-specific. */}
          <Show when={!isJellyfin()}>
            <button
              type="button"
              class="login-advanced-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <Icon name="chevron-right" size={14} class={showAdvanced() ? "rot90" : ""} />
              Advanced options
            </button>

            <Show when={showAdvanced()}>
              <div class="login-advanced">
                <div class="field">
                  <label>Authentication method</label>
                  <select class="input" value={method()} onChange={(e) => setMethod(e.currentTarget.value as any)}>
                    <option value="auto">Auto (native, then Subsonic)</option>
                    <option value="native">Navidrome native only</option>
                    <option value="subsonic">Subsonic token only</option>
                  </select>
                </div>
                <label class="login-check">
                  <input type="checkbox" checked={useToken()} onChange={(e) => setUseToken(e.currentTarget.checked)} />
                  I have a Subsonic salt + token (no password)
                </label>
              </div>
            </Show>
          </Show>
        </form>

        <Show when={knownServers.length > 0 && !props.reauth}>
          <div class="login-known">
            <span class="muted login-known-label">Recent servers</span>
            <For each={knownServers}>
              {(url) => {
                const creds = loadCredentials(url);
                return (
                  <button class="login-known-item" onClick={() => quickSwitch(url)}>
                    <Icon name="server" size={16} />
                    <span>{url.replace(/^https?:\/\//, "")}</span>
                    <Show when={creds?.serverType === "jellyfin"}>
                      <span class="login-known-badge">Jellyfin</span>
                    </Show>
                    <Icon name="chevron-right" size={14} class="muted" />
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={needsServerUrl()}>
          <p class="login-cors muted">
            If connection fails, your server must allow this app's origin (CORS). See the README.
          </p>
        </Show>
      </div>
    </div>
  );
}
