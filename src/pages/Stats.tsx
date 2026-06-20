// Library Stats — a calm overview of how much music lives on the server:
// total artists, albums, songs, and the total size on disk. All figures come
// straight from the Navidrome/Subsonic API (see client.getLibraryStats).

import { createQuery } from "@tanstack/solid-query";
import { For, Show } from "solid-js";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { AsyncState } from "~/ui/AsyncState";
import { Icon, type IconName } from "~/ui/Icon";
import { formatBytes } from "~/lib/format";
import "./stats.css";

export default function Stats() {
  const q = createQuery(() => ({
    queryKey: qk.libraryStats(),
    queryFn: () => client()!.getLibraryStats(),
    enabled: !!client(),
  }));

  const cards = () => {
    const s = q.data;
    if (!s) return [];
    const list: { icon: IconName; label: string; value: string }[] = [
      { icon: "mic", label: "Artists", value: s.artistCount.toLocaleString() },
      { icon: "disc", label: "Albums", value: s.albumCount.toLocaleString() },
      { icon: "list", label: "Songs", value: s.songCount.toLocaleString() },
    ];
    if (s.totalSize !== undefined) {
      list.push({ icon: "server", label: "Total size", value: formatBytes(s.totalSize) });
    }
    return list;
  };

  return (
    <div class="page">
      <div class="list-header">
        <h1 class="page-title">Stats</h1>
      </div>

      <AsyncState loading={q.isLoading} error={q.error}>
        <div class="stats-grid">
          <For each={cards()}>
            {(c) => (
              <div class="stat-card">
                <span class="stat-icon">
                  <Icon name={c.icon} size={22} />
                </span>
                <span class="stat-value">{c.value}</span>
                <span class="stat-label muted">{c.label}</span>
              </div>
            )}
          </For>
        </div>

        <Show when={q.data && q.data.totalSize === undefined}>
          <p class="stats-note muted">
            Total size needs a password (native) login — it isn't exposed to
            Subsonic-token sessions.
          </p>
        </Show>
      </AsyncState>
    </div>
  );
}
