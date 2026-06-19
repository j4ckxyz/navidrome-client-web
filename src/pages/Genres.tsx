// Genres: a tag cloud sized by album count, linking to a genre's songs.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, For } from "solid-js";
import { A } from "@solidjs/router";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { AsyncState } from "~/ui/AsyncState";
import { formatCount } from "~/lib/format";
import "./genres.css";

export default function Genres() {
  const q = createQuery(() => ({
    queryKey: qk.genres(),
    queryFn: () => client()!.getGenres(),
    enabled: !!client(),
  }));

  const genres = createMemo(() =>
    [...(q.data ?? [])]
      .filter((g) => g.value)
      .sort((a, b) => b.albumCount - a.albumCount),
  );

  return (
    <div class="page">
      <div class="list-header">
        <h1 class="page-title">Genres</h1>
      </div>
      <AsyncState loading={q.isLoading} error={q.error} isEmpty={genres().length === 0}>
        <div class="genre-grid">
          <For each={genres()}>
            {(g) => (
              <A href={`/genre/${encodeURIComponent(g.value)}`} class="genre-tile">
                <span class="genre-name">{g.value}</span>
                <span class="genre-count muted">{formatCount(g.albumCount, "album")}</span>
              </A>
            )}
          </For>
        </div>
      </AsyncState>
    </div>
  );
}
