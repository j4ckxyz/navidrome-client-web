// Albums: a paginated, sortable grid of the whole library.

import { createInfiniteQuery } from "@tanstack/solid-query";
import { useSearchParams } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import type { AlbumListType } from "~/api/client";
import { AlbumCard } from "~/ui/AlbumCard";
import { AsyncState } from "~/ui/AsyncState";

const PAGE = 50;

const SORTS: { value: AlbumListType; label: string }[] = [
  { value: "newest", label: "Recently added" },
  { value: "recent", label: "Recently played" },
  { value: "frequent", label: "Most played" },
  { value: "alphabeticalByName", label: "Name" },
  { value: "alphabeticalByArtist", label: "Artist" },
  { value: "starred", label: "Favourites" },
  { value: "random", label: "Random" },
];

export default function Albums() {
  const [params, setParams] = useSearchParams();
  const sort = createMemo<AlbumListType>(() => (params.sort as AlbumListType) ?? "newest");

  const q = createInfiniteQuery(() => ({
    queryKey: ["albumList", sort(), "page"],
    queryFn: ({ pageParam }) => client()!.getAlbumList(sort(), { size: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: unknown[], allPages: unknown[][]) =>
      lastPage.length === PAGE ? allPages.length * PAGE : undefined,
    enabled: !!client(),
  }));

  const albums = createMemo(() => q.data?.pages.flat() ?? []);

  return (
    <div class="page">
      <div class="list-header">
        <h1 class="page-title">Albums</h1>
        <select
          class="input list-sort"
          value={sort()}
          onChange={(e) => setParams({ sort: e.currentTarget.value })}
        >
          <For each={SORTS}>{(s) => <option value={s.value}>{s.label}</option>}</For>
        </select>
      </div>

      <AsyncState
        loading={q.isLoading}
        error={q.error}
        isEmpty={albums().length === 0}
        emptyMessage="No albums in this view."
      >
        <div class="grid">
          <For each={albums()}>{(album) => <AlbumCard album={album} />}</For>
        </div>
        <Show when={q.hasNextPage}>
          <div class="load-more">
            <button class="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          </div>
        </Show>
      </AsyncState>
    </div>
  );
}
