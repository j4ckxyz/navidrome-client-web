// Full-screen "now playing" view, à la Apple Music. Opened by clicking the
// artwork in the now-playing bar. Album art is the hero; transport, seek, and
// volume live below it, over an ambient blurred-art backdrop. Closes on the
// collapse chevron or Escape, with a brief slide-out so it doesn't just vanish.

import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { isStarred, toggleStar } from "~/features/stars";
import { extractColors, distinctColours } from "~/lib/colorExtract";
import { closeFullScreen } from "./fullscreen";
import { Visualizer } from "./Visualizer";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { Slider } from "~/ui/Slider";
import { formatDuration } from "~/lib/format";
import "./fullscreen.css";

export function FullScreenPlayer() {
  const song = createMemo(() => player.current());
  const [leaving, setLeaving] = createSignal(false);
  let closeBtn: HTMLButtonElement | undefined;

  // Ambient backdrop: a large, blurred copy of the album art.
  const backdrop = createMemo(() => {
    const c = client();
    const art = song()?.coverArt;
    return c && art ? `url("${c.coverArtUrl(art, 600)}")` : "none";
  });

  // Cover-derived palette for the visualizer. Best-effort: needs a CORS-clean
  // cover (proxy mode / CORS-enabled server); falls back to defaults otherwise.
  const [vizColors, setVizColors] = createSignal<string[]>([]);
  createEffect(() => {
    const c = client();
    const art = song()?.coverArt;
    if (!c || !art) {
      setVizColors([]);
      return;
    }
    extractColors(c.coverArtUrl(art, 256))
      .then(({ palette, accent }) => {
        const cols = distinctColours([accent, ...palette], 4);
        setVizColors(cols.length ? cols : []);
      })
      .catch(() => setVizColors([]));
  });

  const volIcon = createMemo(() => {
    if (player.state.muted || player.state.volume === 0) return "volume-mute";
    if (player.state.volume < 0.5) return "volume-low";
    return "volume";
  });

  // Play the exit animation, then actually unmount.
  function close() {
    if (leaving()) return;
    setLeaving(true);
    window.setTimeout(closeFullScreen, 240);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  onMount(() => {
    document.addEventListener("keydown", onKey);
    closeBtn?.focus();
  });
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const subtitle = createMemo(() => {
    const s = song();
    if (!s) return "";
    return [s.album, s.year ? String(s.year) : undefined].filter(Boolean).join(" · ");
  });

  return (
    <div
      class="fs-player"
      classList={{ "fs-leaving": leaving() }}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
    >
      <div class="fs-backdrop" style={{ "background-image": backdrop() }} aria-hidden="true" />
      <div class="fs-scrim" aria-hidden="true" />
      <Show when={song()}>
        <Visualizer colors={vizColors()} />
      </Show>

      <div class="fs-inner">
        <header class="fs-top">
          <button
            class="icon-btn fs-collapse"
            ref={closeBtn}
            onClick={close}
            aria-label="Close full screen"
            title="Close (Esc)"
          >
            <Icon name="chevron-right" size={22} />
          </button>
          <span class="fs-top-label muted">Now Playing</span>
          <span class="fs-top-spacer" />
        </header>

        <Show
          when={song()}
          fallback={<div class="fs-empty muted">Nothing playing</div>}
        >
          <div class="fs-art">
            <CoverArt coverArt={song()!.coverArt} alt={song()!.album ?? ""} class="fs-cover" />
          </div>

          <div class="fs-info">
            <div class="fs-text">
              <A
                href={song()!.albumId ? `/album/${song()!.albumId}` : "#"}
                class="fs-title"
                onClick={close}
              >
                {song()!.title}
              </A>
              <A
                href={song()!.artistId ? `/artist/${song()!.artistId}` : "#"}
                class="fs-artist"
                onClick={close}
              >
                {song()!.artist}
              </A>
              <Show when={subtitle()}>
                <span class="fs-subtitle muted">{subtitle()}</span>
              </Show>
            </div>
            <button
              class="icon-btn fs-star"
              classList={{ active: isStarred(song()!.id, song()!.starred) }}
              onClick={() => toggleStar(song()!.id, song()!.starred, "song")}
              aria-label="Favourite"
            >
              <Icon name={isStarred(song()!.id, song()!.starred) ? "heart-filled" : "heart"} size={24} />
            </button>
          </div>

          <div class="fs-seek">
            <span class="fs-time muted">{formatDuration(player.state.currentTime)}</span>
            <Slider
              value={player.state.currentTime}
              max={player.state.duration || 1}
              onInput={(v) => player.seek(v)}
              ariaLabel="Seek"
            />
            <span class="fs-time muted">{formatDuration(player.state.duration)}</span>
          </div>

          <div class="fs-controls">
            <button
              class="icon-btn fs-ctrl"
              classList={{ active: player.state.shuffle }}
              onClick={() => player.toggleShuffle()}
              aria-label="Shuffle"
              aria-pressed={player.state.shuffle}
            >
              <Icon name="shuffle" size={20} />
            </button>
            <button class="icon-btn fs-ctrl" onClick={() => player.previous()} aria-label="Previous">
              <Icon name="prev" size={26} />
            </button>
            <button
              class="fs-play"
              onClick={() => player.togglePlay()}
              aria-label={player.state.isPlaying ? "Pause" : "Play"}
            >
              <Icon name={player.state.isPlaying ? "pause" : "play"} size={30} />
            </button>
            <button class="icon-btn fs-ctrl" onClick={() => player.next()} aria-label="Next">
              <Icon name="next" size={26} />
            </button>
            <button
              class="icon-btn fs-ctrl"
              classList={{ active: player.state.repeat !== "off" }}
              onClick={() => player.cycleRepeat()}
              aria-label={`Repeat: ${player.state.repeat}`}
            >
              <Icon name={player.state.repeat === "one" ? "repeat-one" : "repeat"} size={20} />
            </button>
          </div>

          <div class="fs-volume">
            <button class="icon-btn" onClick={() => player.toggleMute()} aria-label="Mute">
              <Icon name={volIcon()} size={18} />
            </button>
            <Slider
              value={player.state.muted ? 0 : player.state.volume * 100}
              max={100}
              onInput={(v) => player.setVolume(v / 100)}
              ariaLabel="Volume"
            />
          </div>
        </Show>
      </div>
    </div>
  );
}
