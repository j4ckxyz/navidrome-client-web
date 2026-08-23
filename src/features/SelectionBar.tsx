// Action bar for a multi-track selection. Appears above the now-playing bar
// while rows are selected, and applies the same actions a single row's menu
// offers — to all of them at once, in list order.

import { Show, createMemo } from "solid-js";
import type { Song } from "~/api/types";
import { player } from "~/player/store";
import { clearSelection, selectedSongs, selectionCount, selectionListId } from "./selection";
import { openAddToPlaylist } from "./playlists/addToPlaylist";
import { Icon } from "~/ui/Icon";
import "./selectionbar.css";

export function SelectionBar(props: { listId: string; songs: Song[] }) {
  // Only render for the list that actually owns the selection: several lists can
  // be mounted at once (an artist page's top tracks and its albums, say).
  const active = createMemo(() => selectionListId() === props.listId && selectionCount() > 0);
  const chosen = createMemo(() => selectedSongs(props.songs));

  function run(action: (songs: Song[]) => void): void {
    const songs = chosen();
    if (songs.length === 0) return;
    action(songs);
    clearSelection();
  }

  return (
    <Show when={active()}>
      <div class="selection-bar" role="toolbar" aria-label="Selected tracks">
        <span class="selection-count">
          {selectionCount()} selected
        </span>
        <div class="selection-actions">
          <button class="btn btn-primary" onClick={() => run((s) => player.playNow(s, 0))}>
            <Icon name="play" size={15} /> Play
          </button>
          <button class="btn" onClick={() => run((s) => player.playNext(s))}>
            <Icon name="next" size={15} /> Play next
          </button>
          <button class="btn" onClick={() => run((s) => player.addToQueue(s))}>
            <Icon name="queue" size={15} /> Add to queue
          </button>
          <button
            class="btn"
            onClick={() => run((s) => openAddToPlaylist(s.map((song) => song.id)))}
          >
            <Icon name="plus" size={15} /> Add to playlist…
          </button>
        </div>
        <button
          class="icon-btn selection-clear"
          onClick={() => clearSelection()}
          aria-label="Clear selection"
          title="Clear selection (Esc)"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </Show>
  );
}
