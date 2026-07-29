// "What is this client actually doing?" card in Settings → Connections.
//
// Playback problems on a self-hosted server are almost always one of: the server
// is transcoding when you thought it wasn't, or the browser can't decode what
// it's being sent. Both are invisible from the outside, so surface them: the
// connected server, the formats this browser can take untouched, and — on
// Jellyfin — the delivery method the server negotiated for the current track.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, Show } from "solid-js";
import { client, activeServerUrl } from "~/auth/session";
import { player } from "~/player/store";
import { directPlayContainers } from "~/lib/codecs";
import { Icon } from "~/ui/Icon";

export function ServerInfo() {
  const info = createQuery(() => ({
    queryKey: ["serverInfo", activeServerUrl()],
    queryFn: () => client()!.getServerInfo(),
    enabled: !!client(),
    staleTime: 5 * 60_000,
  }));

  // Container names only — the "|codec" suffixes are Jellyfin profile syntax and
  // just noise here.
  const formats = createMemo(() =>
    [...new Set(directPlayContainers().map((c) => c.split("|")[0]))].join(", "),
  );

  const kind = () => (client()?.serverType === "jellyfin" ? "Jellyfin" : "Navidrome");

  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Connection</h3>

      <div class="server-info-rows">
        <div class="server-info-row">
          <span class="muted">Server</span>
          <span>
            {info.data?.name ? `${info.data.name} · ` : ""}
            {kind()}
            {info.data?.version ? ` ${info.data.version}` : ""}
          </span>
        </div>
        <div class="server-info-row">
          <span class="muted">Address</span>
          <span>{(activeServerUrl() ?? "").replace(/^https?:\/\//, "") || "—"}</span>
        </div>
        <div class="server-info-row">
          <span class="muted">Plays without transcoding</span>
          <span class="server-info-formats">{formats()}</span>
        </div>
        <Show when={player.current()}>
          <div class="server-info-row">
            <span class="muted">Now playing</span>
            <span>
              <Show when={player.isSeekable()} fallback={<><Icon name="server" size={13} /> Transcoded by the server</>}>
                <Icon name="check" size={13} /> Direct — original file, untouched
              </Show>
            </span>
          </div>
        </Show>
      </div>

      <p class="muted settings-hint">
        Anything outside that list is converted by the server on the fly. Transcoded
        streams can't be scrubbed in place, so seeking reopens them at the new
        position — that's normal, not a fault.
      </p>
    </div>
  );
}
