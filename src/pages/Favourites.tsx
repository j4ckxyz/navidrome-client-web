// Favourites: starred songs, albums, and artists, pulled from the server so they
// match every other client.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { player } from "~/player/store";
import { AlbumCard } from "~/ui/AlbumCard";
import { ArtistCard } from "~/ui/ArtistCard";
import { SongList } from "~/ui/SongList";
import { AsyncState } from "~/ui/AsyncState";
import { Icon } from "~/ui/Icon";

export default function Favourites() {
  const q = createQuery(() => ({
    queryKey: qk.starred(),
    queryFn: () => client()!.getStarred(),
    enabled: !!client(),
  }));

  const empty = createMemo(
    () =>
      (q.data?.song.length ?? 0) === 0 &&
      (q.data?.album.length ?? 0) === 0 &&
      (q.data?.artist.length ?? 0) === 0,
  );

  return (
    <div class="page">
      <div class="list-header">
        <h1 class="page-title">Favourites</h1>
      </div>
      <AsyncState
        loading={q.isLoading}
        error={q.error}
        isEmpty={empty()}
        emptyMessage="Star tracks, albums, and artists to find them here."
      >
        <Show when={(q.data?.artist.length ?? 0) > 0}>
          <h2 class="section-title">Artists</h2>
          <div class="grid" style={{ "margin-bottom": "32px" }}>
            <For each={q.data!.artist}>{(a) => <ArtistCard artist={a} />}</For>
          </div>
        </Show>

        <Show when={(q.data?.album.length ?? 0) > 0}>
          <h2 class="section-title">Albums</h2>
          <div class="grid" style={{ "margin-bottom": "32px" }}>
            <For each={q.data!.album}>{(a) => <AlbumCard album={a} />}</For>
          </div>
        </Show>

        <Show when={(q.data?.song.length ?? 0) > 0}>
          <div class="list-header" style={{ "margin-top": "8px" }}>
            <h2 class="section-title" style={{ "margin-bottom": "0" }}>
              Tracks
            </h2>
            <button class="btn" onClick={() => player.playNow(q.data!.song, 0)}>
              <Icon name="play" size={16} /> Play all
            </button>
          </div>
          <SongList songs={q.data!.song} showCover showAlbum showHeader numbering="index" />
        </Show>
      </AsyncState>
    </div>
  );
}
