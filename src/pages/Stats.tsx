// Stats — two questions on one page: what's in the library, and what you've
// actually listened to.
//
// The listening half is per-user server state (client.getUserStats), and the two
// backends expose different amounts of it: Jellyfin tracks play counts and dates
// per user on every item, Navidrome only through its native password-login API.
// Every figure is therefore optional and every card is conditional — a stat the
// server can't answer is left out and explained, never rendered as a zero.
//
// The last section is deliberately different: it's the local play log this
// browser keeps (features/history), which works on every backend and every login
// type, and is the only thing on the page that is still true when the server
// tells us nothing.

import { createQuery } from "@tanstack/solid-query";
import { A } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { Album, ArtistSummary, Song } from "~/api/types";
import { client } from "~/auth/session";
import { qk } from "~/lib/query";
import { player } from "~/player/store";
import { historyEntries } from "~/features/history/history";
import { AsyncState } from "~/ui/AsyncState";
import { CoverArt } from "~/ui/CoverArt";
import { Icon, type IconName } from "~/ui/Icon";
import { formatBytes, formatListeningTime, formatRelativeDate } from "~/lib/format";
import "./stats.css";

interface StatCard {
  icon: IconName;
  label: string;
  value: string;
  hint?: string;
}

// One entry in a "most played" column.
interface TopRow {
  title: string;
  subtitle?: string;
  coverArt?: string;
  plays?: number;
  href?: string;
  onClick?: () => void;
  round?: boolean;
}

function TopList(props: { icon: IconName; title: string; rows: TopRow[] }) {
  return (
    <div class="top-list">
      <h3 class="top-list-title">
        <Icon name={props.icon} size={15} />
        {props.title}
      </h3>
      <ol class="top-rows">
        <For each={props.rows}>
          {(row, i) => {
            const body = (
              <>
                <span class="top-rank">{i() + 1}</span>
                <CoverArt
                  coverArt={row.coverArt}
                  size={40}
                  reqSize={96}
                  rounded={row.round}
                  alt=""
                />
                <span class="top-text">
                  <span class="top-name">{row.title}</span>
                  <Show when={row.subtitle}>
                    <span class="top-sub muted">{row.subtitle}</span>
                  </Show>
                </span>
                <Show when={row.plays !== undefined}>
                  <span class="top-plays muted">{row.plays!.toLocaleString()}</span>
                </Show>
              </>
            );
            return (
              <li>
                <Show
                  when={row.href}
                  fallback={
                    <button type="button" class="top-row" onClick={() => row.onClick?.()}>
                      {body}
                    </button>
                  }
                >
                  <A href={row.href!} class="top-row">
                    {body}
                  </A>
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
    </div>
  );
}

export default function Stats() {
  const library = createQuery(() => ({
    queryKey: qk.libraryStats(),
    queryFn: () => client()!.getLibraryStats(),
    enabled: !!client(),
  }));

  // Counting plays means walking the played tracks, so this is the slow half of
  // the page. It gets its own query so the library totals paint immediately
  // instead of waiting behind it.
  const listening = createQuery(() => ({
    queryKey: qk.userStats(),
    queryFn: () => client()!.getUserStats(),
    enabled: !!client(),
  }));

  const libraryCards = (): StatCard[] => {
    const s = library.data;
    if (!s) return [];
    const list: StatCard[] = [
      { icon: "mic", label: "Artists", value: s.artistCount.toLocaleString() },
      { icon: "disc", label: "Albums", value: s.albumCount.toLocaleString() },
      { icon: "list", label: "Songs", value: s.songCount.toLocaleString() },
    ];
    if (s.totalSize !== undefined) {
      list.push({ icon: "server", label: "Total size", value: formatBytes(s.totalSize) });
    }
    return list;
  };

  const listeningCards = (): StatCard[] => {
    const s = listening.data;
    if (!s) return [];
    const cards: StatCard[] = [];
    const approx = s.approximate ? "at least " : "";

    if (s.totalPlays !== undefined) {
      cards.push({
        icon: "play",
        label: "Songs played",
        value: s.totalPlays.toLocaleString(),
        hint: s.approximate ? "Counted from your most-played tracks" : undefined,
      });
    }
    if (s.listeningSeconds !== undefined) {
      cards.push({
        icon: "clock",
        label: "Time listened",
        value: formatListeningTime(s.listeningSeconds),
        hint: s.approximate ? `${approx}this much` : undefined,
      });
    }
    if (s.tracksPlayed !== undefined) {
      // How much of the library has actually been reached — the figure that
      // makes "songs played" mean something.
      const total = library.data?.songCount;
      const share =
        total && total > 0 ? `${Math.round((s.tracksPlayed / total) * 100)}% of the library` : undefined;
      cards.push({
        icon: "check",
        label: "Different songs",
        value: s.tracksPlayed.toLocaleString(),
        hint: share,
      });
    }
    if (s.albumsPlayed !== undefined) {
      cards.push({ icon: "disc", label: "Albums played", value: s.albumsPlayed.toLocaleString() });
    }
    if (s.artistsPlayed !== undefined) {
      cards.push({ icon: "mic", label: "Artists played", value: s.artistsPlayed.toLocaleString() });
    }
    if (s.favoriteSongs !== undefined) {
      cards.push({
        icon: "heart",
        label: "Favourites",
        value: s.favoriteSongs.toLocaleString(),
        hint: [
          s.favoriteAlbums !== undefined ? `${s.favoriteAlbums.toLocaleString()} albums` : null,
          s.favoriteArtists !== undefined ? `${s.favoriteArtists.toLocaleString()} artists` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (s.lastPlayed) {
      const when = formatRelativeDate(s.lastPlayed);
      if (when) cards.push({ icon: "calendar", label: "Last played", value: when });
    }
    return cards;
  };

  const topSongRows = (): TopRow[] =>
    (listening.data?.topSongs ?? []).map((song: Song) => ({
      title: song.title,
      subtitle: song.artist,
      coverArt: song.coverArt,
      plays: song.playCount,
      onClick: () => player.playNow([song]),
    }));

  const topAlbumRows = (): TopRow[] =>
    (listening.data?.topAlbums ?? []).map((album: Album) => ({
      title: album.name,
      subtitle: album.artist,
      coverArt: album.coverArt,
      plays: album.playCount,
      href: `/album/${album.id}`,
    }));

  const topArtistRows = (): TopRow[] =>
    (listening.data?.topArtists ?? []).map((artist: ArtistSummary) => ({
      title: artist.name,
      coverArt: artist.coverArt,
      plays: artist.playCount,
      href: `/artist/${artist.id}`,
      round: true,
    }));

  const hasTopLists = () =>
    topSongRows().length > 0 || topAlbumRows().length > 0 || topArtistRows().length > 0;

  // The local log. Bounded (the newest few hundred plays), so it's described as
  // a recent window rather than an all-time total.
  const local = createMemo(() => {
    const entries = historyEntries();
    if (entries.length === 0) return null;
    const seconds = entries.reduce((sum, e) => sum + (e.duration ?? 0), 0);
    const artists = new Set(entries.map((e) => e.artist).filter(Boolean));
    const oldest = entries[entries.length - 1]?.playedAt;
    return {
      plays: entries.length,
      tracks: new Set(entries.map((e) => e.id)).size,
      artists: artists.size,
      seconds,
      since: oldest ? new Date(oldest).toISOString() : undefined,
    };
  });

  return (
    <div class="page">
      <div class="list-header">
        <h1 class="page-title">Stats</h1>
      </div>

      <section class="stats-section">
        <h2 class="stats-heading">Your listening</h2>
        <AsyncState loading={listening.isLoading} error={listening.error}>
          <Show
            when={listeningCards().length > 0}
            fallback={
              <p class="stats-note muted">
                {listening.data?.unavailableReason ??
                  "This server doesn't report per-user listening figures."}
              </p>
            }
          >
            <div class="stats-grid">
              <For each={listeningCards()}>
                {(c) => (
                  <div class="stat-card">
                    <span class="stat-icon">
                      <Icon name={c.icon} size={22} />
                    </span>
                    <span class="stat-value">{c.value}</span>
                    <span class="stat-label muted">{c.label}</span>
                    <Show when={c.hint}>
                      <span class="stat-hint muted">{c.hint}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={listening.data?.approximate}>
            <p class="stats-note muted">
              Your library is large enough that counting every play would mean reading
              every track, so these totals come from your most-played tracks and are a
              floor, not an exact figure.
            </p>
          </Show>
          <Show when={listeningCards().length > 0 && listening.data?.unavailableReason}>
            <p class="stats-note muted">{listening.data!.unavailableReason}</p>
          </Show>
        </AsyncState>
      </section>

      <Show when={hasTopLists()}>
        <section class="stats-section">
          <h2 class="stats-heading">Most played</h2>
          <div class="top-lists">
            <Show when={topSongRows().length > 0}>
              <TopList icon="play" title="Songs" rows={topSongRows()} />
            </Show>
            <Show when={topAlbumRows().length > 0}>
              <TopList icon="disc" title="Albums" rows={topAlbumRows()} />
            </Show>
            <Show when={topArtistRows().length > 0}>
              <TopList icon="mic" title="Artists" rows={topArtistRows()} />
            </Show>
          </div>
        </section>
      </Show>

      <section class="stats-section">
        <h2 class="stats-heading">Library</h2>
        <AsyncState loading={library.isLoading} error={library.error}>
          <div class="stats-grid">
            <For each={libraryCards()}>
              {(c) => (
                <div class="stat-card">
                  <span class="stat-icon">
                    <Icon name={c.icon} size={22} />
                  </span>
                  <span class="stat-value">{c.value}</span>
                  <span class="stat-label muted">{c.label}</span>
                </div>
              )}
            </For>
          </div>

          <Show when={library.data && library.data.totalSize === undefined}>
            <p class="stats-note muted">
              Total size needs a password (native) login — it isn't exposed to
              Subsonic-token sessions.
            </p>
          </Show>
        </AsyncState>
      </section>

      <Show when={local()}>
        {(l) => (
          <section class="stats-section">
            <h2 class="stats-heading">In this browser</h2>
            <div class="stats-grid">
              <div class="stat-card">
                <span class="stat-icon">
                  <Icon name="waves" size={22} />
                </span>
                <span class="stat-value">{l().plays.toLocaleString()}</span>
                <span class="stat-label muted">Plays logged</span>
              </div>
              <div class="stat-card">
                <span class="stat-icon">
                  <Icon name="list" size={22} />
                </span>
                <span class="stat-value">{l().tracks.toLocaleString()}</span>
                <span class="stat-label muted">Different songs</span>
              </div>
              <div class="stat-card">
                <span class="stat-icon">
                  <Icon name="mic" size={22} />
                </span>
                <span class="stat-value">{l().artists.toLocaleString()}</span>
                <span class="stat-label muted">Artists</span>
              </div>
              <div class="stat-card">
                <span class="stat-icon">
                  <Icon name="clock" size={22} />
                </span>
                <span class="stat-value">{formatListeningTime(l().seconds)}</span>
                <span class="stat-label muted">Time listened</span>
              </div>
            </div>
            <p class="stats-note muted">
              Kept locally by this browser, newest few hundred plays
              <Show when={formatRelativeDate(l().since)}>
                {(since) => <> — back to {since()}</>}
              </Show>
              . It's the only figure here that doesn't depend on what the server
              records. <A href="/history">See the full log</A>.
            </p>
          </section>
        )}
      </Show>
    </div>
  );
}
