// Album detail: big cover, metadata, transport actions, and the track list
// grouped by disc when multi-disc.

import { createQuery } from "@tanstack/solid-query";
import { A, useParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { client } from "~/auth/session";
import type { Song } from "~/api/types";
import { qk } from "~/lib/query";
import { player } from "~/player/store";
import { isStarred, toggleStar } from "~/features/stars";
import { openAddToPlaylist } from "~/features/playlists/addToPlaylist";
import { updateSettings } from "~/settings/store";
import { derivePalette } from "~/theme/colors";
import { extractColors, distinctColours } from "~/lib/colorExtract";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { MenuButton } from "~/ui/Menu";
import { SongList } from "~/ui/SongList";
import { AsyncState } from "~/ui/AsyncState";
import { formatCount, formatLongDuration } from "~/lib/format";
import "./album.css";

export default function AlbumDetail() {
  const params = useParams<{ id: string }>();

  const q = createQuery(() => ({
    queryKey: qk.album(params.id),
    queryFn: () => client()!.getAlbum(params.id),
    enabled: !!client(),
  }));

  const songs = createMemo(() => q.data?.song ?? []);
  const discs = createMemo(() => {
    const byDisc = new Map<number, Song[]>();
    for (const s of songs()) {
      const d = s.discNumber ?? 1;
      if (!byDisc.has(d)) byDisc.set(d, []);
      byDisc.get(d)!.push(s);
    }
    return [...byDisc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([disc, list]) => ({ disc, songs: list }));
  });
  const multiDisc = createMemo(() => discs().length > 1);

  // Build a soft gradient backdrop from the cover's dominant colours. Best-effort:
  // requires a CORS-clean cover (same-origin/proxy, or a server that sends CORS).
  const [gradient, setGradient] = createSignal<string | null>(null);
  createEffect(() => {
    const art = q.data?.coverArt;
    const c = client();
    setGradient(null);
    if (!art || !c) return;
    extractColors(c.coverArtUrl(art, 256))
      .then(({ palette }) => {
        const cols = distinctColours(palette, 3);
        if (cols.length >= 2) setGradient(`linear-gradient(135deg, ${cols.join(", ")})`);
        else if (cols.length === 1) setGradient(`linear-gradient(135deg, ${cols[0]}, ${cols[0]})`);
      })
      .catch(() => setGradient(null));
  });

  // Generate an accessible custom theme from the cover. derivePalette keeps
  // contrast readable; the user picks the light/dark base.
  async function themeFromCover(base: "dark" | "light") {
    const art = q.data?.coverArt;
    const c = client();
    if (!art || !c) return;
    try {
      const { accent } = await extractColors(c.coverArtUrl(art, 256));
      updateSettings((s) => {
        s.theme.preset = "custom";
        s.theme.customizationMode = "simple";
        s.theme.base = base;
        s.theme.colors = derivePalette(base, accent);
      });
    } catch {
      // extraction failed (e.g. cover not CORS-clean) — leave the theme as-is
    }
  }

  return (
    <div class="page album-page">
      <Show when={gradient()}>
        <div class="album-backdrop" style={{ "background-image": gradient()! }} aria-hidden="true" />
      </Show>
      <AsyncState loading={q.isLoading} error={q.error}>
        <Show when={q.data}>
          {(album) => (
            <>
              <header class="detail-head">
                <div class="detail-art">
                  <CoverArt coverArt={album().coverArt} alt={album().name} />
                </div>
                <div class="detail-info">
                  <span class="detail-kind">Album</span>
                  <h1 class="detail-title">{album().name}</h1>
                  <div class="detail-sub">
                    <Show when={album().artistId} fallback={<span>{album().artist}</span>}>
                      <A href={`/artist/${album().artistId}`}>{album().artist}</A>
                    </Show>
                    <Show when={album().year}>
                      <span class="detail-dot">{album().year}</span>
                    </Show>
                    <span class="detail-dot">{formatCount(songs().length, "track")}</span>
                    <span class="detail-dot">{formatLongDuration(album().duration)}</span>
                  </div>
                </div>
              </header>

              <div class="detail-actions">
                <button class="play-big" onClick={() => {
                  const isCurrentAlbum = songs().some(s => s.id === player.current()?.id);
                  if (isCurrentAlbum) {
                    player.togglePlay();
                  } else {
                    player.playNow(songs(), 0);
                  }
                }}>
                  <Icon name={player.state.isPlaying && songs().some(s => s.id === player.current()?.id) ? "pause" : "play"} size={20} class="play-big-icon" />
                  {player.state.isPlaying && songs().some(s => s.id === player.current()?.id) ? "Pause" : "Play"}
                </button>
                <button
                  class="icon-btn"
                  classList={{ active: isStarred(album().id, album().starred) }}
                  onClick={() => toggleStar(album().id, album().starred, "album")}
                  aria-label="Favourite album"
                >
                  <Icon name={isStarred(album().id, album().starred) ? "heart-filled" : "heart"} size={22} />
                </button>
                <MenuButton
                  items={[
                    { label: "Shuffle", icon: "shuffle", onSelect: () => player.playNow([...songs()].sort(() => Math.random() - 0.5), 0) },
                    { label: "Play next", icon: "next", onSelect: () => player.playNext(songs()) },
                    { label: "Add to queue", icon: "queue", onSelect: () => player.addToQueue(songs()) },
                    { label: "Add to playlist…", icon: "plus", onSelect: () => openAddToPlaylist(songs().map((s) => s.id)), separatorBefore: true },
                    { label: "Theme from cover · Dark", icon: "settings", onSelect: () => themeFromCover("dark"), separatorBefore: true },
                    { label: "Theme from cover · Light", icon: "settings", onSelect: () => themeFromCover("light") },
                  ]}
                />
              </div>

              <Show
                when={multiDisc()}
                fallback={<SongList songs={songs()} showHeader numbering="track" />}
              >
                <For each={discs()}>
                  {(group) => (
                    <>
                      <div class="disc-divider">
                        <Icon name="disc" size={14} /> Disc {group.disc}
                      </div>
                      <SongList songs={group.songs} numbering="track" />
                    </>
                  )}
                </For>
              </Show>
            </>
          )}
        </Show>
      </AsyncState>
    </div>
  );
}
