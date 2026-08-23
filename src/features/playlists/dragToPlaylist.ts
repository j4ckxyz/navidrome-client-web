// Dragging tracks onto a playlist in the sidebar.
//
// The drag payload is a custom MIME type so a track dragged over anything else —
// the queue, another app, a text field — is simply not accepted, rather than
// being pasted as stray text.

import { createSignal } from "solid-js";
import type { Song } from "~/api/types";
import { selectedSongs, selectionCount, selectionListId } from "~/features/selection";

export const SONGS_MIME = "application/x-tonearm-songs";

// Which playlist is currently under the pointer, for the drop highlight.
const [dropTarget, setDropTarget] = createSignal<string | null>(null);
export { dropTarget as playlistDropTarget, setDropTarget as setPlaylistDropTarget };

// Ids to drag when a row is picked up. Dragging a row that's part of the current
// selection drags the whole selection — matching what every file manager does,
// and what the selection bar's actions do.
export function dragPayloadFor(song: Song, listId: string | undefined, context: Song[]): string[] {
  if (!listId || selectionListId() !== listId || selectionCount() === 0) return [song.id];
  const chosen = selectedSongs(context);
  return chosen.some((s) => s.id === song.id) ? chosen.map((s) => s.id) : [song.id];
}

export function readSongIds(transfer: DataTransfer | null): string[] {
  if (!transfer) return [];
  try {
    const raw = transfer.getData(SONGS_MIME);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
