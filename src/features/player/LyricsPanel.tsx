// Lyrics side panel. Fetches structured lyrics for the current track; if synced,
// highlights and auto-scrolls the active line against playback position.

import { createQuery } from "@tanstack/solid-query";
import { createEffect, createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { qk } from "~/lib/query";
import { Icon } from "~/ui/Icon";
import "./lyricspanel.css";

export function LyricsPanel() {
  const song = createMemo(() => player.current());

  const lyrics = createQuery(() => ({
    queryKey: qk.lyrics(song()?.id ?? ""),
    queryFn: () => client()!.getLyrics(song()!.id),
    enabled: !!client() && !!song(),
  }));

  const best = createMemo(() => {
    const list = lyrics.data ?? [];
    return list.find((l) => l.synced) ?? list[0];
  });

  // Index of the active synced line based on current playback time.
  const activeLine = createMemo(() => {
    const l = best();
    if (!l?.synced) return -1;
    const ms = player.state.currentTime * 1000;
    let idx = -1;
    for (let i = 0; i < l.line.length; i++) {
      if ((l.line[i].start ?? 0) <= ms) idx = i;
      else break;
    }
    return idx;
  });

  let listRef: HTMLDivElement | undefined;
  createEffect(() => {
    const idx = activeLine();
    if (idx < 0 || !listRef) return;
    const el = listRef.querySelector<HTMLElement>(`[data-line="${idx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  return (
    <aside class="side-panel lyrics-panel">
      <div class="side-panel-head">
        <h2 class="side-panel-title">Lyrics</h2>
      </div>

      <Show
        when={song()}
        fallback={
          <div class="center-state">
            <Icon name="lyrics" size={30} />
            <p>Play a track to see lyrics.</p>
          </div>
        }
      >
        <Show when={!lyrics.isLoading} fallback={<div class="center-state"><span class="spinner" /></div>}>
          <Show
            when={best() && best()!.line.length > 0}
            fallback={
              <div class="center-state">
                <Icon name="lyrics" size={30} />
                <p>No lyrics found for this track.</p>
              </div>
            }
          >
            <div class="lyrics-body" ref={listRef} classList={{ "lyrics-synced": best()!.synced }}>
              <For each={best()!.line}>
                {(line, i) => (
                  <p
                    class="lyrics-line"
                    data-line={i()}
                    classList={{
                      "lyrics-line-active": best()!.synced && i() === activeLine(),
                      "lyrics-line-past": best()!.synced && i() < activeLine(),
                    }}
                    onClick={() => {
                      if (best()!.synced && line.start !== undefined) {
                        player.seek(line.start / 1000);
                      }
                    }}
                  >
                    {line.value || " "}
                  </p>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </aside>
  );
}
