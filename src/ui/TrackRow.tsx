// A single track row: the most-used component in the app. Double-click or the
// play affordance starts playback in the row's list context; right-click and the
// "..." button expose the same actions; the heart toggles the server-side star.

import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, Show } from "solid-js";
import type { Song } from "~/api/types";
import { player } from "~/player/store";
import { settings } from "~/settings/store";
import { isStarred, toggleStar } from "~/features/stars";
import { openAddToPlaylist } from "~/features/playlists/addToPlaylist";
import { formatDuration, formatRelativeDate } from "~/lib/format";
import { CoverArt } from "./CoverArt";
import { Icon } from "./Icon";
import { MenuButton, RowContextMenu, type ActionItem } from "./Menu";
import "./trackrow.css";

export interface TrackRowProps {
  song: Song;
  // Number to show at the left (track number or list position).
  number?: number;
  // The list this row belongs to, so playback gets full context.
  context?: Song[];
  contextIndex?: number;
  showCover?: boolean;
  showAlbum?: boolean;
  // When part of an editable playlist, enables "Remove from playlist".
  onRemoveFromPlaylist?: () => void;
}

export function TrackRow(props: TrackRowProps) {
  const navigate = useNavigate();
  const starred = createMemo(() => isStarred(props.song.id, props.song.starred));
  const isCurrent = createMemo(() => player.current()?.id === props.song.id);
  const [pop, setPop] = createSignal(false);

  // Toggle the star, popping the heart when it becomes a favourite.
  function star() {
    const becoming = !starred();
    toggleStar(props.song.id, props.song.starred, "song");
    if (becoming) {
      setPop(true);
      window.setTimeout(() => setPop(false), 360);
    }
  }

  function play() {
    if (isCurrent()) {
      player.togglePlay();
    } else if (props.context && props.contextIndex !== undefined) {
      player.playNow(props.context, props.contextIndex);
    } else {
      player.playNow([props.song], 0);
    }
  }

  const actions = (): ActionItem[] => {
    const items: ActionItem[] = [
      { label: isCurrent() && player.state.isPlaying ? "Pause" : "Play", icon: isCurrent() && player.state.isPlaying ? "pause" : "play", onSelect: play },
      { label: "Play next", icon: "next", onSelect: () => player.playNext([props.song]) },
      { label: "Add to queue", icon: "queue", onSelect: () => player.addToQueue([props.song]) },
      {
        label: "Add to playlist…",
        icon: "plus",
        onSelect: () => openAddToPlaylist([props.song.id]),
        separatorBefore: true,
      },
      {
        label: starred() ? "Remove favourite" : "Favourite",
        icon: starred() ? "heart-filled" : "heart",
        onSelect: () => toggleStar(props.song.id, props.song.starred, "song"),
      },
    ];
    if (props.song.albumId) {
      items.push({
        label: "Go to album",
        icon: "disc",
        onSelect: () => navigate(`/album/${props.song.albumId}`),
        separatorBefore: true,
      });
    }
    if (props.song.artistId) {
      items.push({
        label: "Go to artist",
        icon: "mic",
        onSelect: () => navigate(`/artist/${props.song.artistId}`),
      });
    }
    if (props.onRemoveFromPlaylist) {
      items.push({
        label: "Remove from playlist",
        icon: "trash",
        onSelect: props.onRemoveFromPlaylist,
        danger: true,
        separatorBefore: true,
      });
    }
    return items;
  };

  return (
    <RowContextMenu items={actions()}>
      <div
        class="track-row"
        classList={{ "track-row-current": isCurrent() }}
        onDblClick={play}
      >
        <div class="track-index">
          <Show when={isCurrent() && player.state.isPlaying} fallback={<span class="track-num">{props.number ?? ""}</span>}>
            <span class="track-playing">
              <i /><i /><i />
            </span>
          </Show>
          <button class="track-play-overlay" onClick={play} aria-label={`${isCurrent() && player.state.isPlaying ? "Pause" : "Play"} ${props.song.title}`}>
            <Icon name={isCurrent() && player.state.isPlaying ? "pause" : "play"} size={15} />
          </button>
        </div>

        <Show when={props.showCover}>
          <CoverArt coverArt={props.song.coverArt} size={38} class="track-cover" alt="" />
        </Show>

        <div class="track-main">
          <span class="track-title" classList={{ "accent-text": isCurrent() }}>
            {props.song.title}
          </span>
          <span class="track-artist muted">{props.song.artist}</span>
        </div>

        <Show when={props.showAlbum}>
          <span class="track-album muted">{props.song.album}</span>
        </Show>

        <Show when={settings.layout.showPlayCounts}>
          <span
            class="track-plays muted"
            title={props.song.played ? `Last played ${formatRelativeDate(props.song.played)}` : undefined}
          >
            <Show when={(props.song.playCount ?? 0) > 0}>
              {props.song.playCount}&nbsp;<Icon name="play" size={11} />
            </Show>
          </span>
        </Show>

        <button
          class="icon-btn track-star"
          classList={{ "track-star-on": starred(), "heart-pop": pop() }}
          onClick={(e) => {
            e.stopPropagation();
            star();
          }}
          aria-label={starred() ? "Remove favourite" : "Favourite"}
        >
          <Icon name={starred() ? "heart-filled" : "heart"} size={16} />
        </button>

        <span class="track-duration muted">{formatDuration(props.song.duration)}</span>

        <MenuButton items={actions()} class="track-more" />
      </div>
    </RowContextMenu>
  );
}
