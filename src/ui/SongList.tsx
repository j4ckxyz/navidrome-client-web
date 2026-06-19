// Renders a list of tracks as TrackRows with an optional header row. The list is
// passed as playback context so any row plays within it.

import { For, Show } from "solid-js";
import type { Song } from "~/api/types";
import { settings } from "~/settings/store";
import { TrackRow } from "./TrackRow";

export function SongList(props: {
  songs: Song[];
  showCover?: boolean;
  showAlbum?: boolean;
  showHeader?: boolean;
  // Numbering: "track" uses each song's track number, "index" uses position.
  numbering?: "track" | "index" | "none";
  onRemoveFromPlaylist?: (index: number) => void;
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
            onRemoveFromPlaylist={
              props.onRemoveFromPlaylist ? () => props.onRemoveFromPlaylist!(i()) : undefined
            }
          />
        )}
      </For>
    </div>
  );
}
