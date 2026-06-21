// Full-screen "now playing" view, à la Apple Music. Opened by clicking the
// artwork in the now-playing bar. Album art is the hero; transport, seek, and
// volume live below it, over an ambient blurred-art backdrop. Closes on the
// collapse chevron or Escape, with a brief slide-out so it doesn't just vanish.

import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { qk } from "~/lib/query";
import { settings, updateSettings } from "~/settings/store";
import { isStarred, toggleStar } from "~/features/stars";
import { extractColors, distinctColours } from "~/lib/colorExtract";
import { hexToRgb, rgbToOklch, oklch } from "~/theme/colors";
import { closeFullScreen } from "./fullscreen";
import { Visualizer } from "./Visualizer";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { ToggleMenuButton } from "~/ui/Menu";
import { Slider } from "~/ui/Slider";
import { formatDuration } from "~/lib/format";
import "./fullscreen.css";

// Build a two-stop "along the bottom" gradient from the cover's two most
// distinct colours. Each stop's hue (and a little of its chroma) is kept, but its
// lightness is forced into the active theme's background band, so the gradient is
// always recognisably the album's colours yet stays in the same tonal range as
// --content-bg. That guarantees the white-on-dark (or dark-on-light) player text
// keeps its contrast on every album, not just lucky ones.
function coverGradient(cols: string[], dark: boolean): string {
  if (!cols.length) return "";
  const stop = (hex: string, l: number, cMax: number) => {
    const { c, h } = rgbToOklch(hexToRgb(hex));
    return oklch(l, Math.min(c, cMax), h);
  };
  const a = cols[0];
  const b = cols[1] ?? cols[0];
  // Lightest stop stays dark enough (dark theme) / light enough (light theme)
  // that content-text clears WCAG AA against it by a wide margin.
  const bottom = dark ? stop(a, 0.3, 0.11) : stop(a, 0.9, 0.05);
  const mid = dark ? stop(b, 0.17, 0.08) : stop(b, 0.97, 0.03);
  return `linear-gradient(to top, ${bottom} 0%, ${mid} 45%, transparent 85%)`;
}

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

  // Cover-derived palette for the visualizer and the bottom gradient. Best-effort:
  // needs a CORS-clean cover (proxy mode / CORS-enabled server); falls back to
  // defaults otherwise.
  const [vizColors, setVizColors] = createSignal<string[]>([]);
  const [gradient, setGradient] = createSignal("");
  createEffect(() => {
    const c = client();
    const art = song()?.coverArt;
    if (!c || !art) {
      setVizColors([]);
      setGradient("");
      return;
    }
    extractColors(c.coverArtUrl(art, 256))
      .then(({ palette, accent }) => {
        const cols = distinctColours([accent, ...palette], 4);
        setVizColors(cols.length ? cols : []);
        const dark = document.documentElement.dataset.base !== "light";
        setGradient(coverGradient(cols.length ? cols : [accent], dark));
      })
      .catch(() => {
        setVizColors([]);
        setGradient("");
      });
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

  // Lyrics, loaded quietly in the background. We only ever surface them here if a
  // *synced* set with real timestamps comes back; anything else (failure, none,
  // or plain unsynced text) shows nothing, so the layout never shifts for it.
  const lyricsQ = createQuery(() => ({
    queryKey: qk.lyrics(song()?.id ?? ""),
    queryFn: () => client()!.getLyrics(song()!.id),
    enabled: !!client() && !!song(),
    staleTime: 5 * 60 * 1000,
  }));
  const syncedLyric = createMemo(() => {
    const l = (lyricsQ.data ?? []).find((x) => x.synced && x.line.length > 0);
    return l && l.line.some((ln) => ln.start !== undefined) ? l : undefined;
  });
  const activeIdx = createMemo(() => {
    const l = syncedLyric();
    if (!l) return -1;
    const ms = player.state.currentTime * 1000;
    let idx = -1;
    for (let i = 0; i < l.line.length; i++) {
      if ((l.line[i].start ?? 0) <= ms) idx = i;
      else break;
    }
    return idx;
  });
  const currentLine = createMemo(() => syncedLyric()?.line[activeIdx()]?.value.trim() ?? "");
  const nextLine = createMemo(() => syncedLyric()?.line[activeIdx() + 1]?.value.trim() ?? "");

  return (
    <div
      class="fs-player"
      classList={{
        "fs-leaving": leaving(),
        "fs-static": !settings.layout.fullScreenVisualizer,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
    >
      <Show when={settings.layout.fullScreenBackdrop}>
        <div class="fs-backdrop" style={{ "background-image": backdrop() }} aria-hidden="true" />
      </Show>
      <div class="fs-scrim" aria-hidden="true" />
      <Show when={settings.layout.fullScreenBackdrop && gradient()}>
        <div class="fs-gradient" style={{ "background-image": gradient() }} aria-hidden="true" />
      </Show>
      <Show when={song() && settings.layout.fullScreenVisualizer}>
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
          <ToggleMenuButton
            class="fs-display-menu"
            icon="sliders"
            iconSize={20}
            label="Display options"
            heading="Display"
            items={[
              {
                label: "Waveform",
                icon: "waves",
                checked: settings.layout.fullScreenVisualizer,
                onChange: (v) => updateSettings((s) => (s.layout.fullScreenVisualizer = v)),
              },
              {
                label: "Ambient backdrop",
                icon: "image",
                checked: settings.layout.fullScreenBackdrop,
                onChange: (v) => updateSettings((s) => (s.layout.fullScreenBackdrop = v)),
              },
            ]}
          />
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

          <Show when={syncedLyric()}>
            <div class="fs-lyric" aria-hidden="true">
              <Show when={currentLine()} keyed>
                <p class="fs-lyric-current">{currentLine()}</p>
              </Show>
              <Show when={nextLine()}>
                <p class="fs-lyric-next">{nextLine()}</p>
              </Show>
            </div>
          </Show>

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
