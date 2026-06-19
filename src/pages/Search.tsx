// Search results. The query comes from the URL (?q=), set by the debounced top
// bar input. Server-side search via search3.

import { createQuery } from "@tanstack/solid-query";
import { useSearchParams } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { AlbumCard } from "~/ui/AlbumCard";
import { ArtistCard } from "~/ui/ArtistCard";
import { SongList } from "~/ui/SongList";
import { AsyncState } from "~/ui/AsyncState";
import { Icon } from "~/ui/Icon";

export default function Search() {
  const [params] = useSearchParams();
  const query = createMemo(() => String(params.q ?? "").trim());

  const q = createQuery(() => ({
    queryKey: qk.search(query()),
    queryFn: () => client()!.search(query()),
    enabled: !!client() && query().length > 0,
  }));

  const empty = createMemo(
    () =>
      (q.data?.artist.length ?? 0) === 0 &&
      (q.data?.album.length ?? 0) === 0 &&
      (q.data?.song.length ?? 0) === 0,
  );

  return (
    <div class="page">
      <Show
        when={query().length > 0}
        fallback={
          <div class="center-state">
            <Icon name="search" size={30} />
            <p>Search for artists, albums, and tracks.</p>
          </div>
        }
      >
        <h1 class="page-title" style={{ "margin-bottom": "24px" }}>
          Results for “{query()}”
        </h1>
        <AsyncState
          loading={q.isLoading}
          error={q.error}
          isEmpty={empty()}
          emptyMessage={`Nothing found for “${query()}”.`}
        >
          <Show when={(q.data?.artist.length ?? 0) > 0}>
            <h2 class="section-title">Artists</h2>
            <div class="grid" style={{ "margin-bottom": "32px" }}>
              <For each={q.data!.artist.slice(0, 12)}>{(a) => <ArtistCard artist={a} />}</For>
            </div>
          </Show>

          <Show when={(q.data?.album.length ?? 0) > 0}>
            <h2 class="section-title">Albums</h2>
            <div class="grid" style={{ "margin-bottom": "32px" }}>
              <For each={q.data!.album.slice(0, 12)}>{(a) => <AlbumCard album={a} />}</For>
            </div>
          </Show>

          <Show when={(q.data?.song.length ?? 0) > 0}>
            <h2 class="section-title">Tracks</h2>
            <SongList songs={q.data!.song} showCover showAlbum showHeader numbering="index" />
          </Show>
        </AsyncState>
      </Show>
    </div>
  );
}
