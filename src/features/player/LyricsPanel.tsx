// Lyrics side panel. Fetches structured lyrics for the current track; if synced,
// highlights and auto-scrolls the active line against playback position.
//
// Your server is always asked first. Most self-hosted libraries have no lyrics
// tags at all, so when it comes back empty and you've opted in, LRCLIB is asked
// as a fallback — see features/lyrics/lrclib for what that sends.

import { createQuery } from "@tanstack/solid-query";
import { createEffect, createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { settings } from "~/settings/store";
import {
  fetchLyrics,
  lyricsKey,
  prefetchLyrics,
  LYRICS_STALE_MS,
} from "~/features/lyrics/lyricsQuery";
import { Icon } from "~/ui/Icon";
import "./lyricspanel.css";

export function LyricsPanel() {
  const song = createMemo(() => player.current());

  const lyrics = createQuery(() => ({
    queryKey: lyricsKey(song()?.id ?? ""),
    queryFn: () => fetchLyrics(song()!),
    enabled:
      !!client() &&
      !!song() &&
      settings.layout.showLyricsPanel &&
      !settings.layout.showQueuePanel,
    staleTime: LYRICS_STALE_MS,
  }));

  // With the panel open, fetch the next track's lyrics before it starts. The
  // words are then already there when it does, instead of the panel dropping
  // back to a spinner between songs.
  createEffect(() => {
    if (!song()) return;
    prefetchLyrics(player.state.queue[player.state.index + 1]);
  });

  const best = createMemo(() => {
    const list = lyrics.data?.list ?? [];
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
                <Show when={!settings.playback.onlineLyrics}>
                  <p class="muted lyrics-hint">
                    Most self-hosted libraries have no lyrics tags. Turn on{" "}
                    <b>Look up lyrics online</b> in Settings → Playback to fetch them from
                    LRCLIB.
                  </p>
                </Show>
              </div>
            }
          >
            <div class="lyrics-body" ref={listRef} classList={{ "lyrics-synced": best()!.synced }}>
              <Show when={lyrics.data?.source === "lrclib"}>
                {/* These didn't come from your library, so say so — and make
                    the mismatch checkable when the timings are off. */}
                <p class="lyrics-credit muted">
                  From LRCLIB · matched to{" "}
                  <em>
                    {best()!.displayArtist} — {best()!.displayTitle}
                  </em>
                </p>
              </Show>
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
