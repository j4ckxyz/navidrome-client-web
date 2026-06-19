// Side panel showing the play queue. Supports drag-to-reorder (HTML5 DnD) and
// per-item removal. Queue order is client session state; it persists locally so
// playback can resume, but durable library state stays on the server.

import { createSignal, For, Show } from "solid-js";
import { player } from "~/player/store";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { formatDuration } from "~/lib/format";
import "./queuepanel.css";

export function QueuePanel() {
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [overIndex, setOverIndex] = createSignal<number | null>(null);

  function onDrop(target: number) {
    const from = dragIndex();
    if (from !== null && from !== target) {
      player.moveInQueue(from, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  }

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
        when={player.state.queue.length > 0}
        fallback={
          <div class="center-state">
            <Icon name="queue" size={30} />
            <p>The queue is empty.</p>
          </div>
        }
      >
        <div class="queue-list">
          <For each={player.state.queue}>
            {(song, i) => (
              <div
                class="queue-item"
                classList={{
                  "queue-item-current": i() === player.state.index,
                  "queue-item-over": overIndex() === i(),
                }}
                draggable={true}
                onDragStart={(e) => {
                  setDragIndex(i());
                  e.dataTransfer!.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverIndex(i());
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(i());
                }}
                onDblClick={() => player.playNow(player.state.queue, i())}
              >
                <span class="queue-grip" aria-hidden="true">
                  <Icon name="grip" size={16} />
                </span>
                <CoverArt coverArt={song.coverArt} size={38} alt="" class="queue-cover" />
                <div class="queue-meta">
                  <span class="queue-title" classList={{ "accent-text": i() === player.state.index }}>
                    {song.title}
                  </span>
                  <span class="queue-artist muted">{song.artist}</span>
                </div>
                <span class="queue-dur muted">{formatDuration(song.duration)}</span>
                <button
                  class="icon-btn queue-remove"
                  onClick={() => player.removeAt(i())}
                  aria-label="Remove from queue"
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
}
