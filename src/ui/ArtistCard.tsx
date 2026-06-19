// Artist tile: round art, name, album count. Plays the artist's full discography
// on the play affordance.

import { A } from "@solidjs/router";
import type { ArtistSummary } from "~/api/types";
import { playArtist } from "~/features/playback-helpers";
import { formatCount } from "~/lib/format";
import { CoverArt } from "./CoverArt";
import { Icon } from "./Icon";
import { RowContextMenu, type ActionItem } from "./Menu";
import "./cards.css";

export function ArtistCard(props: { artist: ArtistSummary }) {
  const actions = (): ActionItem[] => [
    { label: "Play", icon: "play", onSelect: () => playArtist(props.artist.id) },
    { label: "Shuffle", icon: "shuffle", onSelect: () => playArtist(props.artist.id, true) },
  ];

  return (
    <RowContextMenu items={actions()}>
      <A href={`/artist/${props.artist.id}`} class="card card-artist">
        <div class="card-art">
          <CoverArt coverArt={props.artist.coverArt} rounded alt="" />
          <button
            class="card-play"
            aria-label={`Play ${props.artist.name}`}
            onClick={(e) => {
              e.preventDefault();
              playArtist(props.artist.id);
            }}
          >
            <Icon name="play" size={20} />
          </button>
        </div>
        <div class="card-meta card-meta-center">
          <span class="card-title">{props.artist.name}</span>
          <span class="card-sub muted">
            {formatCount(props.artist.albumCount ?? 0, "album")}
          </span>
        </div>
      </A>
    </RowContextMenu>
  );
}
