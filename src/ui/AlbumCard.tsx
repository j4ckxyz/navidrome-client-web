// Album tile for grids and carousels. Hover reveals a play button; right-click
// opens the same actions as the "..." affordance elsewhere.

import { A, useNavigate } from "@solidjs/router";
import { Show } from "solid-js";
import type { Album } from "~/api/types";
import { playAlbum, queueAlbum } from "~/features/playback-helpers";
import { toggleStar, isStarred } from "~/features/stars";
import { CoverArt } from "./CoverArt";
import { Icon } from "./Icon";
import { RowContextMenu, type ActionItem } from "./Menu";
import "./cards.css";

export function AlbumCard(props: { album: Album }) {
  const navigate = useNavigate();

  const actions = (): ActionItem[] => [
    { label: "Play", icon: "play", onSelect: () => playAlbum(props.album.id) },
    { label: "Shuffle", icon: "shuffle", onSelect: () => playAlbum(props.album.id, true) },
    { label: "Play next", icon: "next", onSelect: () => queueAlbum(props.album.id, "next") },
    { label: "Add to queue", icon: "queue", onSelect: () => queueAlbum(props.album.id, "end") },
    {
      label: isStarred(props.album.id, props.album.starred) ? "Remove favourite" : "Favourite",
      icon: isStarred(props.album.id, props.album.starred) ? "heart-filled" : "heart",
      onSelect: () => toggleStar(props.album.id, props.album.starred, "album"),
      separatorBefore: true,
    },
    {
      label: "Go to artist",
      icon: "mic",
      onSelect: () => props.album.artistId && navigate(`/artist/${props.album.artistId}`),
      disabled: !props.album.artistId,
    },
  ];

  return (
    <RowContextMenu items={actions()}>
      <A href={`/album/${props.album.id}`} class="card">
        <div class="card-art">
          <CoverArt coverArt={props.album.coverArt} alt="" />
          <button
            class="card-play"
            aria-label={`Play ${props.album.name}`}
            onClick={(e) => {
              e.preventDefault();
              playAlbum(props.album.id);
            }}
          >
            <Icon name="play" size={20} />
          </button>
        </div>
        <div class="card-meta">
          <span class="card-title">{props.album.name}</span>
          <Show when={props.album.artist}>
            <span class="card-sub muted">{props.album.artist}</span>
          </Show>
        </div>
      </A>
    </RowContextMenu>
  );
}
