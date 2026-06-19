// Genre detail: tracks tagged with a genre, with play/shuffle.

import { createQuery } from "@tanstack/solid-query";
import { useParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { player } from "~/player/store";
import { AsyncState } from "~/ui/AsyncState";
import { SongList } from "~/ui/SongList";
import { Icon } from "~/ui/Icon";
import { formatCount } from "~/lib/format";

export default function GenreDetail() {
  const params = useParams<{ name: string }>();
  const genre = createMemo(() => decodeURIComponent(params.name));

  const q = createQuery(() => ({
    queryKey: qk.songsByGenre(genre()),
    queryFn: () => client()!.getSongsByGenre(genre(), 250),
    enabled: !!client(),
  }));

  const songs = createMemo(() => q.data ?? []);

  return (
    <div class="page">
      <div class="list-header">
        <div>
          <span class="detail-kind">Genre</span>
          <h1 class="page-title">{genre()}</h1>
        </div>
      </div>
      <AsyncState loading={q.isLoading} error={q.error} isEmpty={songs().length === 0}>
        <div class="detail-actions">
          <button class="play-big" onClick={() => player.playNow(songs(), 0)}>
            <Icon name="play" size={20} class="play-big-icon" /> Play
          </button>
          <button class="btn" onClick={() => player.playNow([...songs()].sort(() => Math.random() - 0.5), 0)}>
            <Icon name="shuffle" size={17} /> Shuffle
          </button>
          <span class="muted">{formatCount(songs().length, "track")}</span>
        </div>
        <SongList songs={songs()} showCover showAlbum showHeader numbering="index" />
      </AsyncState>
    </div>
  );
}
