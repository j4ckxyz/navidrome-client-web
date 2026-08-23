// Multi-select for track lists.
//
// Before this, building a playlist by hand meant one right-click per track. The
// interaction is the one everybody already knows from file managers: click to
// select, shift-click for a range, ctrl/cmd-click to add or remove one.
//
// Selection belongs to exactly one list at a time. A list identity (the album
// id, playlist id, search term…) is carried with it, so navigating to another
// page — or the same component rendering different songs — drops the selection
// rather than leaving invisible rows selected somewhere off screen.

import { createMemo, createSignal } from "solid-js";
import type { Song } from "~/api/types";

interface SelectionState {
  listId: string;
  // Insertion-ordered so actions apply in the order shown on screen.
  ids: string[];
  // Where a shift-click range measures from.
  anchor: number;
}

const [state, setState] = createSignal<SelectionState | null>(null);

export const selectionCount = createMemo(() => state()?.ids.length ?? 0);
export const selectionListId = createMemo(() => state()?.listId ?? null);

export function isSelected(listId: string, id: string): boolean {
  const s = state();
  return !!s && s.listId === listId && s.ids.includes(id);
}

export function clearSelection(): void {
  setState(null);
}

// Resolve the selection back to songs, in the order they appear in the list.
export function selectedSongs(songs: Song[]): Song[] {
  const s = state();
  if (!s) return [];
  const chosen = new Set(s.ids);
  return songs.filter((song) => chosen.has(song.id));
}

// Handle a click on a row. Returns true when the click was a selection gesture
// and the row should not do its normal thing.
export function handleRowClick(
  listId: string,
  index: number,
  songs: Song[],
  event: MouseEvent,
): boolean {
  const additive = event.ctrlKey || event.metaKey;
  const ranged = event.shiftKey;
  if (!additive && !ranged) return false;

  const song = songs[index];
  if (!song) return false;

  const current = state();
  const active = current && current.listId === listId ? current : null;

  if (ranged && active) {
    // Shift extends from the anchor, replacing whatever the range last covered.
    const from = Math.min(active.anchor, index);
    const to = Math.max(active.anchor, index);
    const ids = songs.slice(from, to + 1).map((s) => s.id);
    setState({ listId, ids, anchor: active.anchor });
    return true;
  }

  if (additive && active) {
    const has = active.ids.includes(song.id);
    const ids = has ? active.ids.filter((id) => id !== song.id) : [...active.ids, song.id];
    if (ids.length === 0) {
      setState(null);
      return true;
    }
    setState({ listId, ids, anchor: index });
    return true;
  }

  // First gesture in this list — both modifiers start a one-track selection.
  setState({ listId, ids: [song.id], anchor: index });
  return true;
}

// Select every track in the list (Ctrl/Cmd+A while a list has focus).
export function selectAll(listId: string, songs: Song[]): void {
  if (songs.length === 0) return;
  setState({ listId, ids: songs.map((s) => s.id), anchor: 0 });
}
