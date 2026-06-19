// Developer tool: inspect raw Subsonic API responses. Not something the official
// web UI exposes — handy for power users debugging their server.

import { createSignal, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { Icon } from "~/ui/Icon";
import "./debug-panel.css";

const ENDPOINTS = [
  { endpoint: "ping.view", label: "ping" },
  { endpoint: "getArtists.view", label: "getArtists" },
  { endpoint: "getAlbumList2.view", label: "getAlbumList2 (newest)", params: { type: "newest", size: 5 } },
  { endpoint: "getGenres.view", label: "getGenres" },
  { endpoint: "getPlaylists.view", label: "getPlaylists" },
  { endpoint: "getStarred2.view", label: "getStarred2" },
  { endpoint: "getScanStatus.view", label: "getScanStatus" },
];

export function DebugPanel() {
  const [output, setOutput] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);
  const [activeUrl, setActiveUrl] = createSignal("");

  async function run(endpoint: string, params?: Record<string, string | number>) {
    const c = client();
    if (!c) return;
    setLoading(true);
    const url = c.buildUrl(endpoint, params ?? {});
    setActiveUrl(url.replace(/([?&](t|s)=)[^&]*/g, "$1•••")); // mask token/salt
    try {
      const res = await fetch(url);
      const json = await res.json();
      setOutput(JSON.stringify(json, null, 2));
    } catch (e) {
      setOutput(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="debug-panel">
      <div class="debug-endpoints">
        <For each={ENDPOINTS}>
          {(ep) => (
            <button class="btn debug-ep" onClick={() => run(ep.endpoint, ep.params)}>
              {ep.label}
            </button>
          )}
        </For>
      </div>
      <Show when={activeUrl()}>
        <div class="debug-url">
          <Icon name="server" size={13} /> <code>{activeUrl()}</code>
        </div>
      </Show>
      <Show when={loading()}>
        <div class="center-state"><span class="spinner" /></div>
      </Show>
      <Show when={output() && !loading()}>
        <pre class="debug-output">{output()}</pre>
      </Show>
    </div>
  );
}
