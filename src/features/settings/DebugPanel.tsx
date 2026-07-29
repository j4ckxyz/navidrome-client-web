// Developer tool: inspect raw Subsonic API responses. Not something the official
// web UI exposes — handy for power users debugging their server.

import { createSignal, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { Icon } from "~/ui/Icon";
import "./debug-panel.css";

const SUBSONIC_ENDPOINTS = [
  { endpoint: "ping.view", label: "ping" },
  { endpoint: "getArtists.view", label: "getArtists" },
  { endpoint: "getAlbumList2.view", label: "getAlbumList2 (newest)", params: { type: "newest", size: 5 } },
  { endpoint: "getGenres.view", label: "getGenres" },
  { endpoint: "getPlaylists.view", label: "getPlaylists" },
  { endpoint: "getStarred2.view", label: "getStarred2" },
  { endpoint: "getScanStatus.view", label: "getScanStatus" },
];

const JELLYFIN_ENDPOINTS = [
  { endpoint: "System/Info/Public", label: "System/Info" },
  { endpoint: "UserViews", label: "UserViews (libraries)" },
  { endpoint: "Artists/AlbumArtists", label: "AlbumArtists" },
  { endpoint: "Items", label: "Albums (newest)", params: { IncludeItemTypes: "MusicAlbum", Recursive: "true", SortBy: "DateCreated", SortOrder: "Descending", Limit: 5 } },
  { endpoint: "MusicGenres", label: "MusicGenres" },
  // The playback negotiation that decides direct-play vs transcode. POST-only,
  // so this GET just confirms the route exists — the useful part is Sessions.
  { endpoint: "Sessions", label: "Sessions (this device)" },
];

export function DebugPanel() {
  const [output, setOutput] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);
  const [activeUrl, setActiveUrl] = createSignal("");

  const endpoints = () =>
    client()?.serverType === "jellyfin" ? JELLYFIN_ENDPOINTS : SUBSONIC_ENDPOINTS;

  async function run(endpoint: string, params?: Record<string, string | number>) {
    const c = client();
    if (!c) return;
    setLoading(true);
    const url = c.buildUrl(endpoint, params ?? {});
    // Mask secrets: Subsonic token/salt and Jellyfin api_key.
    setActiveUrl(url.replace(/([?&](t|s|api_key)=)[^&]*/g, "$1•••"));
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
        <For each={endpoints()}>
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
