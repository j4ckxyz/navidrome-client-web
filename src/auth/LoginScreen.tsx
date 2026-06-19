// First-run setup / login. Talks directly to the user's Navidrome server from
// the browser. Supports password auth (native or Subsonic) and direct token
// auth. Shows previously-used servers for quick switching.

import { createSignal, For, Show } from "solid-js";
import { login, switchServer } from "./session";
import { listKnownServers, loadCredentials } from "~/api/credentials";
import { ApiError } from "~/api/types";
import { Icon } from "~/ui/Icon";
import { proxyMode } from "~/lib/serverConfig";
import "./login.css";

export function LoginScreen(props: { reauth?: boolean; prefillServer?: string; prefillUser?: string }) {
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

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({
        serverUrl: proxyMode() ? window.location.origin : serverUrl(),
        username: username(),
        password: useToken() ? undefined : password(),
        salt: useToken() ? salt() : undefined,
        token: useToken() ? token() : undefined,
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

  return (
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          <div class="login-logo">
            <Icon name="disc" size={28} />
          </div>
          <div>
            <h1>{props.reauth ? "Session expired" : "Connect to Navidrome"}</h1>
            <p class="muted">
              {props.reauth
                ? "Your login expired. Re-enter your password to continue."
                : proxyMode()
                  ? "Enter your Navidrome username and password."
                  : "Enter your server details. Everything runs in your browser."}
            </p>
          </div>
        </div>

        <form onSubmit={submit} class="login-form">
          <Show when={!proxyMode()}>
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
                required={!proxyMode()}
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
            when={!useToken()}
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
        </form>

        <Show when={knownServers.length > 0 && !props.reauth && !proxyMode()}>
          <div class="login-known">
            <span class="muted login-known-label">Recent servers</span>
            <For each={knownServers}>
              {(url) => (
                <button class="login-known-item" onClick={() => quickSwitch(url)}>
                  <Icon name="server" size={16} />
                  <span>{url.replace(/^https?:\/\//, "")}</span>
                  <Icon name="chevron-right" size={14} class="muted" />
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={!proxyMode()}>
          <p class="login-cors muted">
            If connection fails, your Navidrome server must allow this app's origin (CORS). See the
            README.
          </p>
        </Show>
      </div>
    </div>
  );
}
