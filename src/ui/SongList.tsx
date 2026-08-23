// Renders a list of tracks as TrackRows with an optional header row. The list is
// passed as playback context so any row plays within it.

import { For, Show } from "solid-js";
import type { Song } from "~/api/types";
import { settings } from "~/settings/store";
import { handleRowClick, isSelected } from "~/features/selection";
import { dragPayloadFor } from "~/features/playlists/dragToPlaylist";
import { TrackRow } from "./TrackRow";

export function SongList(props: {
  songs: Song[];
  showCover?: boolean;
  showAlbum?: boolean;
  showHeader?: boolean;
  // Numbering: "track" uses each song's track number, "index" uses position.
  numbering?: "track" | "index" | "none";
  onRemoveFromPlaylist?: (index: number) => void;
  // Song id to visually highlight (deep-linked track from /song/:id).
  highlightId?: string;
  // Identity of this list, enabling multi-select. Selection is scoped to one
  // list at a time, so this must be stable for the list and distinct from other
  // lists (an album id, playlist id, search term…). Omit to disable selection.
  selectionId?: string;
  // When one logical list is rendered as several SongLists (an album split by
  // disc), pass the whole list and this chunk's offset into it. Without them a
  // shift-click range would be measured against disc-local indices and select
  // the wrong tracks.
  selectionContext?: Song[];
  selectionOffset?: number;
}) {
  const numberFor = (song: Song, i: number) => {
    if (props.numbering === "none") return undefined;
    if (props.numbering === "index") return i + 1;
    return song.track ?? i + 1;
  };

  return (
    <div class="tracklist">
      <Show when={props.showHeader}>
        {/* Spacer columns mirror the row layout so labels line up with values. */}
        <div class="tracklist-head">
          <span class="tracklist-head-num">#</span>
          <Show when={props.showCover}>
            <span class="tracklist-head-cover" />
          </Show>
          <span class="tracklist-head-title">Title</span>
          <Show when={props.showAlbum}>
            <span class="tracklist-head-album">Album</span>
          </Show>
          <Show when={settings.layout.showPlayCounts}>
            <span class="tracklist-head-plays" />
          </Show>
          <span class="tracklist-head-star" />
          <span class="tracklist-head-dur">Time</span>
          <span class="tracklist-head-spacer" />
        </div>
      </Show>
      <For each={props.songs}>
        {(song, i) => (
          <TrackRow
            song={song}
            number={numberFor(song, i())}
            context={props.songs}
            contextIndex={i()}
            showCover={props.showCover}
            showAlbum={props.showAlbum}
            highlighted={props.highlightId === song.id}
            selected={!!props.selectionId && isSelected(props.selectionId, song.id)}
            dragSongIds={() =>
              dragPayloadFor(song, props.selectionId, props.selectionContext ?? props.songs)
            }
            onRowClick={
              props.selectionId
                ? (e) =>
                    handleRowClick(
                      props.selectionId!,
                      (props.selectionOffset ?? 0) + i(),
                      props.selectionContext ?? props.songs,
                      e,
                    )
                : undefined
            }
            onRemoveFromPlaylist={
              props.onRemoveFromPlaylist ? () => props.onRemoveFromPlaylist!(i()) : undefined
            }
          />
        )}
      </For>
    </div>
  );
}
