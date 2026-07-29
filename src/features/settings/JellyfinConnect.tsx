// Jellyfin connection card in Settings → Connections. Linking an account
// unlocks live radio (from Live TV m3u tuners) and music-video matching.

import { createSignal, Show } from "solid-js";
import { jellyfin, jellyfinIsPrimary, jellyfinLogin, jellyfinLogout } from "~/api/jellyfinExtras";
import { queryClient } from "~/lib/query";
import { Icon } from "~/ui/Icon";

export function JellyfinConnect() {
  const [serverUrl, setServerUrl] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function connect(e: Event) {
    e.preventDefault();
    if (!serverUrl().trim() || !username().trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jellyfinLogin(serverUrl(), username().trim(), password());
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["jellyfin"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    jellyfinLogout();
    queryClient.removeQueries({ queryKey: ["jellyfin"] });
  }

  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Jellyfin</h3>
      <p class="muted settings-hint">
        <Show
          when={jellyfinIsPrimary()}
          fallback={
            <>
              Link a Jellyfin server to unlock two extras: live radio from its Live TV
              channels (m3u tuners) on the Radio page, and music videos for the song you're
              playing. Your Navidrome library is unaffected.
            </>
          }
        >
          You're signed in to Jellyfin, so live radio (Live TV channels) and music videos
          already work — no separate connection needed.
        </Show>
      </p>

      <Show
        when={jellyfin()}
        fallback={
          <form class="jf-form" onSubmit={connect}>
            <input
              class="input"
              type="url"
              placeholder="https://jellyfin.example.com"
              value={serverUrl()}
              onInput={(e) => setServerUrl(e.currentTarget.value)}
              autocomplete="url"
              required
            />
            <input
              class="input"
              placeholder="Username"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              autocomplete="username"
              required
            />
            <input
              class="input"
              type="password"
              placeholder="Password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              autocomplete="current-password"
            />
            <button class="btn btn-primary" type="submit" disabled={busy()}>
              <Icon name="link" size={16} />
              {busy() ? "Connecting…" : "Connect"}
            </button>
            <Show when={error()}>
              <p class="jf-error">{error()}</p>
            </Show>
            <p class="muted settings-hint">
              If connecting fails from the browser, make sure your Jellyfin server allows
              requests from this app's address (Jellyfin → Networking → CORS / known proxies).
            </p>
          </form>
        }
      >
        {(s) => (
          <div class="jf-connected">
            <div class="jf-connected-info">
              <Icon name="check" size={18} class="jf-check" />
              <div>
                <span class="jf-connected-user">{s().username}</span>
                <span class="jf-connected-server muted">
                  {s().serverUrl.replace(/^https?:\/\//, "")}
                </span>
              </div>
            </div>
            {/* Nothing to disconnect when this is just the primary login —
                signing out of the app is how you'd end that session. */}
            <Show when={!jellyfinIsPrimary()}>
              <button class="btn" onClick={disconnect}>
                <Icon name="logout" size={16} /> Disconnect
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
