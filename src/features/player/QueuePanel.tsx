// Side panel showing the play queue. Shows the current track and everything
// after it (already-played tracks are hidden); supports drag-to-reorder (HTML5
// DnD) and per-item removal. When autoplay is on, a preview of the similar
// tracks that will play after the queue is shown beneath it.
//
// Queue order is client session state; it persists locally so playback can
// resume, but durable library state stays on the server.

import { createMemo, createSignal, For, Show } from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { settings } from "~/settings/store";
import { applyDiscoveryFilters } from "~/lib/recommendations";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { formatDuration } from "~/lib/format";
import "./queuepanel.css";

export function QueuePanel() {
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [overIndex, setOverIndex] = createSignal<number | null>(null);

  // Hide already-played tracks: render from the current track onward.
  const start = createMemo(() => (player.state.index >= 0 ? player.state.index : 0));
  const upcoming = createMemo(() => player.state.queue.slice(start()));

  function onDrop(target: number) {
    const from = dragIndex();
    if (from !== null && from !== target) {
      player.moveInQueue(from, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  }

  // Autoplay preview: tracks similar to the last queued song, which is what
  // autoplay will continue with once the queue ends.
  const lastSong = createMemo(() => {
    const q = player.state.queue;
    return q[q.length - 1];
  });
  const suggestions = createQuery(() => ({
    queryKey: ["autoplay-suggest", lastSong()?.id ?? ""],
    queryFn: () => client()!.getSimilarSongs(lastSong()!.id, 10),
    enabled: !!client() && settings.playback.autoplay && !!lastSong(),
    staleTime: 5 * 60 * 1000,
  }));
  const suggested = createMemo(() => {
    const inQueue = new Set(player.state.queue.map((s) => s.id));
    const fresh = (suggestions.data ?? []).filter((s) => !inQueue.has(s.id));
    return applyDiscoveryFilters(fresh).slice(0, 6);
  });

  return (
    <aside class="side-panel queue-panel">
      <div class="side-panel-head">
        <h2 class="side-panel-title">Queue</h2>
        <Show when={player.state.queue.length > 0}>
          <button class="btn btn-ghost queue-clear" onClick={() => player.clearQueue()}>
            Clear
          </button>
        </Show>
      </div>

      <Show
        when={upcoming().length > 0}
        fallback={
          <div class="center-state">
            <Icon name="queue" size={30} />
            <p>The queue is empty.</p>
          </div>
        }
      >
        <div class="queue-list">
          <For each={upcoming()}>
            {(song, i) => {
              const real = () => start() + i();
              return (
                <div
                  class="queue-item"
                  classList={{
                    "queue-item-current": real() === player.state.index,
                    "queue-item-over": overIndex() === real(),
                  }}
                  draggable={true}
                  onDragStart={(e) => {
                    setDragIndex(real());
                    e.dataTransfer!.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverIndex(real());
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDrop(real());
                  }}
                  onDblClick={() => player.playNow(player.state.queue, real())}
                >
                  <span class="queue-grip" aria-hidden="true">
                    <Icon name="grip" size={16} />
                  </span>
                  <CoverArt coverArt={song.coverArt} size={38} alt="" class="queue-cover" />
                  <div class="queue-meta">
                    <span class="queue-title" classList={{ "accent-text": real() === player.state.index }}>
                      {song.title}
                    </span>
                    <span class="queue-artist muted">{song.artist}</span>
                  </div>
                  <span class="queue-dur muted">{formatDuration(song.duration)}</span>
                  <button
                    class="icon-btn queue-remove"
                    onClick={() => player.removeAt(real())}
                    aria-label="Remove from queue"
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              );
            }}
          </For>

          <Show when={settings.playback.autoplay && suggested().length > 0}>
            <div class="queue-suggest-head">
              <Icon name="trending" size={13} />
              <span>Autoplay next</span>
            </div>
            <For each={suggested()}>
              {(song) => (
                <button
                  class="queue-item queue-suggest"
                  onClick={() => player.addToQueue([song])}
                  title="Add to queue"
                >
                  <span class="queue-grip queue-suggest-add" aria-hidden="true">
                    <Icon name="plus" size={15} />
                  </span>
                  <CoverArt coverArt={song.coverArt} size={38} alt="" class="queue-cover" />
                  <div class="queue-meta">
                    <span class="queue-title">{song.title}</span>
                    <span class="queue-artist muted">{song.artist}</span>
                  </div>
                  <span class="queue-dur muted">{formatDuration(song.duration)}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </aside>
  );
}
