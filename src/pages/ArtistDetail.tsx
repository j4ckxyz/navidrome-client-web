// Artist detail: header with art and bio, play/shuffle the discography, then the
// albums grid and similar artists.

import { createQuery } from "@tanstack/solid-query";
import { useParams } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { playArtist } from "~/features/playback-helpers";
import { isStarred, toggleStar } from "~/features/stars";
import { shareLink } from "~/features/share/share";
import { downloadCollectionOriginal } from "~/features/download/download";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { MenuButton } from "~/ui/Menu";
import { AlbumCard } from "~/ui/AlbumCard";
import { ArtistCard } from "~/ui/ArtistCard";
import { AsyncState } from "~/ui/AsyncState";
import { formatCount } from "~/lib/format";

export default function ArtistDetail() {
  const params = useParams<{ id: string }>();

  const q = createQuery(() => ({
    queryKey: qk.artist(params.id),
    queryFn: () => client()!.getArtist(params.id),
    enabled: !!client(),
  }));

  const info = createQuery(() => ({
    queryKey: qk.artistInfo(params.id),
    queryFn: () => client()!.getArtistInfo(params.id),
    enabled: !!client(),
  }));

  const albums = createMemo(() =>
    [...(q.data?.albums ?? [])].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
  );

  // Strip the trailing "Read more on Last.fm" link some sources append.
  const bio = createMemo(() => info.data?.biography?.replace(/<a[^>]*>.*?<\/a>/g, "").trim());

  return (
    <div class="page">
      <AsyncState loading={q.isLoading} error={q.error}>
        <Show when={q.data}>
          {(artist) => (
            <>
              <header class="detail-head">
                <div class="detail-art" style={{ width: "200px" }}>
                  <CoverArt coverArt={artist().coverArt} rounded alt={artist().name} />
                </div>
                <div class="detail-info">
                  <span class="detail-kind">Artist</span>
                  <h1 class="detail-title">{artist().name}</h1>
                  <div class="detail-sub">
                    <span>{formatCount(albums().length, "album")}</span>
                  </div>
                </div>
              </header>

              <div class="detail-actions">
                <button class="play-big" onClick={() => playArtist(artist().id)}>
                  <Icon name="play" size={20} class="play-big-icon" /> Play
                </button>
                <button class="btn" onClick={() => playArtist(artist().id, true)}>
                  <Icon name="shuffle" size={17} /> Shuffle
                </button>
                <button
                  class="icon-btn"
                  classList={{ active: isStarred(artist().id, artist().starred) }}
                  onClick={() => toggleStar(artist().id, artist().starred, "artist")}
                  aria-label="Favourite artist"
                >
                  <Icon name={isStarred(artist().id, artist().starred) ? "heart-filled" : "heart"} size={22} />
                </button>
                <MenuButton
                  items={[
                    { label: "Share", icon: "share", onSelect: () => shareLink(`/artist/${artist().id}`, artist().name) },
                    { label: "Download all (original)", icon: "download", onSelect: () => downloadCollectionOriginal(artist().id), separatorBefore: true },
                  ]}
                />
              </div>

              <Show when={bio()}>
                <p class="bio">{bio()}</p>
              </Show>

              <h2 class="section-title">Albums</h2>
              <div class="grid">
                <For each={albums()}>{(album) => <AlbumCard album={album} />}</For>
              </div>

              <Show when={(info.data?.similarArtist?.length ?? 0) > 0}>
                <h2 class="section-title" style={{ "margin-top": "34px" }}>
                  Similar artists
                </h2>
                <div class="grid">
                  <For each={info.data!.similarArtist!.slice(0, 12)}>
                    {(a) => <ArtistCard artist={a} />}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </AsyncState>
    </div>
  );
}
