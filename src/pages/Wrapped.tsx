// Library Recap — a "Wrapped"-style overview built entirely from data the
// Navidrome/Subsonic API already exposes: most-played albums, top artists
// (derived by summing album play counts), recently played, and library totals.
// No external service, no tracking — just a flattering view of your own listening.

import { createMemo, For, Show } from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { displayName } from "./Home";
import { AlbumCard } from "~/ui/AlbumCard";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import "./wrapped.css";

interface TopArtist {
  id?: string;
  name: string;
  plays: number;
  coverArt?: string;
}

export default function Wrapped() {
  // Most-played albums (server returns them play-sorted). A larger pull also
  // feeds the derived "top artists".
  const frequent = createQuery(() => ({
    queryKey: qk.albumList("frequent", { size: 60 }),
    queryFn: () => client()!.getAlbumList("frequent", { size: 60 }),
    enabled: !!client(),
  }));

  const recent = createQuery(() => ({
    queryKey: qk.albumList("recent", { size: 12 }),
    queryFn: () => client()!.getAlbumList("recent", { size: 12 }),
    enabled: !!client(),
  }));

  const artistsQ = createQuery(() => ({
    queryKey: qk.artists(),
    queryFn: () => client()!.getArtists(),
    enabled: !!client(),
  }));

  const genresQ = createQuery(() => ({
    queryKey: qk.genres(),
    queryFn: () => client()!.getGenres(),
    enabled: !!client(),
  }));

  const starredQ = createQuery(() => ({
    queryKey: qk.starred(),
    queryFn: () => client()!.getStarred(),
    enabled: !!client(),
  }));

  const topAlbums = createMemo(() => (frequent.data ?? []).slice(0, 12));

  // Derive top artists by summing play counts across their albums.
  const topArtists = createMemo<TopArtist[]>(() => {
    const byArtist = new Map<string, TopArtist>();
    for (const a of frequent.data ?? []) {
      const key = a.artistId || a.artist || a.id;
      if (!key) continue;
      const cur = byArtist.get(key);
      const plays = a.playCount ?? 0;
      if (cur) {
        cur.plays += plays;
      } else {
        byArtist.set(key, {
          id: a.artistId,
          name: a.artist ?? "Unknown artist",
          plays,
          coverArt: a.coverArt,
        });
      }
    }
    return [...byArtist.values()].sort((x, y) => y.plays - x.plays).slice(0, 8);
  });

  const totalSongs = createMemo(() =>
    (genresQ.data ?? []).reduce((sum, g) => sum + (g.songCount ?? 0), 0),
  );
  const favourites = createMemo(() => {
    const s = starredQ.data;
    if (!s) return 0;
    return s.song.length + s.album.length + s.artist.length;
  });

  const loading = () => frequent.isLoading || artistsQ.isLoading;
  const hasPlays = createMemo(() => (frequent.data ?? []).some((a) => (a.playCount ?? 0) > 0));

  return (
    <div class="page wrapped-page">
      <header class="wrapped-hero">
        <span class="wrapped-kicker">Library Recap</span>
        <h1 class="wrapped-title">
          <Show when={displayName()} fallback={"Your listening, at a glance"}>
            {displayName()}'s listening, at a glance
          </Show>
        </h1>
      </header>

      <Show when={!loading()} fallback={<div class="center-state"><span class="spinner" /></div>}>
        {/* Stat tiles */}
        <div class="wrapped-stats">
          <StatTile icon="mic" value={(artistsQ.data?.length ?? 0).toLocaleString()} label="Artists" />
          <StatTile icon="disc" value={topAlbums().length ? `${(frequent.data?.length ?? 0).toLocaleString()}+` : "0"} label="Albums played" />
          <StatTile icon="play" value={totalSongs().toLocaleString()} label="Songs in library" />
          <StatTile icon="heart" value={favourites().toLocaleString()} label="Favourites" />
        </div>

        <Show
          when={hasPlays()}
          fallback={
            <div class="wrapped-empty">
              <Icon name="trending" size={32} />
              <p>Play some music and your recap will fill in — most-played albums, top artists, and more.</p>
            </div>
          }
        >
          {/* Top artists */}
          <Show when={topArtists().length > 0}>
            <section class="wrapped-section">
              <h2 class="section-title">Top artists</h2>
              <div class="wrapped-artists">
                <For each={topArtists()}>
                  {(artist, i) => (
                    <a
                      class="wrapped-artist"
                      href={artist.id ? `/artist/${artist.id}` : "#"}
                    >
                      <span class="wrapped-rank">{i() + 1}</span>
                      <CoverArt coverArt={artist.coverArt} size={48} rounded alt="" class="wrapped-artist-art" />
                      <span class="wrapped-artist-meta">
                        <span class="wrapped-artist-name">{artist.name}</span>
                        <span class="wrapped-artist-plays muted">{artist.plays.toLocaleString()} plays</span>
                      </span>
                    </a>
                  )}
                </For>
              </div>
            </section>
          </Show>

          {/* Top albums */}
          <section class="wrapped-section">
            <h2 class="section-title">Most played albums</h2>
            <div class="grid">
              <For each={topAlbums()}>{(album) => <AlbumCard album={album} />}</For>
            </div>
          </section>
        </Show>

        {/* Recently played */}
        <Show when={(recent.data?.length ?? 0) > 0}>
          <section class="wrapped-section">
            <h2 class="section-title">Recently played</h2>
            <div class="carousel">
              <For each={recent.data}>{(album) => <AlbumCard album={album} />}</For>
            </div>
          </section>
        </Show>
      </Show>
    </div>
  );
}

function StatTile(props: { icon: Parameters<typeof Icon>[0]["name"]; value: string; label: string }) {
  return (
    <div class="wrapped-stat">
      <span class="wrapped-stat-icon"><Icon name={props.icon} size={18} /></span>
      <span class="wrapped-stat-value">{props.value}</span>
      <span class="wrapped-stat-label muted">{props.label}</span>
    </div>
  );
}
