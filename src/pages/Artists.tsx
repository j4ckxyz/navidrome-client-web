// Artists: the full artist list as a grid of round tiles.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, For } from "solid-js";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { ArtistCard } from "~/ui/ArtistCard";
import { AsyncState } from "~/ui/AsyncState";

export default function Artists() {
  const q = createQuery(() => ({
    queryKey: qk.artists(),
    queryFn: () => client()!.getArtists(),
    enabled: !!client(),
  }));

  const artists = createMemo(() =>
    [...(q.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  );

  return (
    <div class="page">
      <div class="list-header">
        <h1 class="page-title">Artists</h1>
      </div>
      <AsyncState loading={q.isLoading} error={q.error} isEmpty={artists().length === 0}>
        <div class="grid">
          <For each={artists()}>{(artist) => <ArtistCard artist={artist} />}</For>
        </div>
      </AsyncState>
    </div>
  );
}
