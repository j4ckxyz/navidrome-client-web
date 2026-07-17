// Search results. The query comes from the URL (?q=), set by the debounced top
// bar input. Server-side search3 is fanned out into fuzzy variants and re-ranked
// locally (see lib/smartSearch), so typos and partial titles still land. When a
// Jellyfin server is linked, matching music videos get their own section.

import { createQuery } from "@tanstack/solid-query";
import { useSearchParams } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { jellyfin, jellyfinImageUrl, searchMusicVideos, type JellyfinItem } from "~/api/jellyfin";
import { openMusicVideo } from "~/features/player/musicVideo";
import { smartSearch } from "~/lib/smartSearch";
import { fuzzyScore } from "~/lib/fuzzy";
import { qk } from "~/lib/query";
import { AlbumCard } from "~/ui/AlbumCard";
import { ArtistCard } from "~/ui/ArtistCard";
import { SongList } from "~/ui/SongList";
import { AsyncState } from "~/ui/AsyncState";
import { Icon } from "~/ui/Icon";
import "./search.css";

export default function Search() {
  const [params] = useSearchParams();
  const query = createMemo(() => String(params.q ?? "").trim());

  // Full artist list — already cached for the Artists page — doubles as a
  // typo-tolerant artist index the server search can't provide.
  const artistsQ = createQuery(() => ({
    queryKey: qk.artists(),
    queryFn: () => client()!.getArtists(),
    enabled: !!client() && query().length > 0,
  }));

  const q = createQuery(() => ({
    queryKey: [...qk.search(query()), "smart"],
    queryFn: () => smartSearch(client()!, query(), artistsQ.data),
    // Wait for the artist list (cached after the first search) so fuzzy artist
    // matches are included in the first render of results.
    enabled: !!client() && query().length > 0 && !artistsQ.isPending,
  }));

  // Music videos from Jellyfin, fuzzily re-ranked against the query.
  const videosQ = createQuery(() => ({
    queryKey: qk.jellyfinMusicVideo(query(), "search"),
    queryFn: async () => {
      const items = await searchMusicVideos(query(), 30);
      return items
        .map((item) => ({
          item,
          s: Math.max(
            fuzzyScore(query(), item.Name),
            0.9 * fuzzyScore(query(), `${(item.Artists ?? []).join(" ")} ${item.Name}`),
            0.8 * fuzzyScore(query(), (item.Artists ?? []).join(" ")),
          ),
        }))
        .filter((x) => x.s >= 0.5)
        .sort((a, b) => b.s - a.s)
        .slice(0, 12)
        .map((x) => x.item);
    },
    enabled: !!jellyfin() && query().length > 0,
  }));

  const empty = createMemo(
    () =>
      (q.data?.artist.length ?? 0) === 0 &&
      (q.data?.album.length ?? 0) === 0 &&
      (q.data?.song.length ?? 0) === 0 &&
      (videosQ.data?.length ?? 0) === 0,
  );

  return (
    <div class="page">
      <Show
        when={query().length > 0}
        fallback={
          <div class="center-state">
            <Icon name="search" size={30} />
            <p>Search for artists, albums, tracks — and music videos.</p>
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

          <Show when={(videosQ.data?.length ?? 0) > 0}>
            <h2 class="section-title">Music Videos</h2>
            <div class="mv-grid" style={{ "margin-bottom": "32px" }}>
              <For each={videosQ.data}>{(v) => <MusicVideoCard video={v} />}</For>
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

function MusicVideoCard(props: { video: JellyfinItem }) {
  const thumb = () => jellyfinImageUrl(props.video, 480);
  return (
    <button
      class="mv-card"
      onClick={() => openMusicVideo(props.video)}
      aria-label={`Play music video: ${props.video.Name}`}
    >
      <div class="mv-thumb">
        <Show when={thumb()} fallback={<Icon name="video" size={28} />}>
          <img src={thumb()!} alt="" loading="lazy" draggable={false} />
        </Show>
        <span class="mv-card-play">
          <Icon name="play" size={20} />
        </span>
      </div>
      <span class="mv-card-title">{props.video.Name}</span>
      <span class="mv-card-artist muted">{(props.video.Artists ?? []).join(", ")}</span>
    </button>
  );
}
