// The immersive, full-screen visualiser overlay. Taps the player's master
// AnalyserNode (same signal you hear), runs the shared render loop in the chosen
// mode, and layers a light, auto-hiding control bar on top. Opens from the
// now-playing bar; exits on Escape, the close button, or a click on the field.
//
// When the analyser is unavailable (direct mode with a non-CORS stream — the tap
// would taint and blank), the loop still animates from a synthesized signal and
// we say so plainly rather than pretending it's reacting to the music.

import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { player } from "~/player/store";
import { client } from "~/auth/session";
import { extractColors, distinctColours } from "~/lib/colorExtract";
import { Icon } from "~/ui/Icon";
import { createVizLoop } from "./loop";
import { buildPalette, DEFAULT_PALETTE, type RGB } from "./renderer";
import { closeVisualizer, setVizMode, vizMode, type VizMode } from "./state";
import "./visualizer.css";

const MODES: { id: VizMode; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "magnetosphere", label: "Magnetosphere" },
];

export function VisualizerStage() {
  let stage: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;

  const song = createMemo(() => player.current());
  const [palette, setPalette] = createSignal<RGB[]>(DEFAULT_PALETTE);
  const [controlsVisible, setControlsVisible] = createSignal(true);
  const [isNativeFs, setIsNativeFs] = createSignal(false);

  // Was the analyser actually available? If not, we're on the synth fallback.
  const analyser = player.enableVisualizer();
  const synthesized = !analyser;

  // Derive a vivid palette from the cover art (best-effort; needs a CORS-clean
  // cover, same constraint as the rest of the app). Falls back to defaults.
  createEffect(() => {
    const c = client();
    const art = song()?.coverArt;
    if (!c || !art) {
      setPalette(DEFAULT_PALETTE);
      return;
    }
    extractColors(c.coverArtUrl(art, 256))
      .then(({ palette: pal, accent }) => {
        const cols = distinctColours([accent, ...pal], 4);
        setPalette(cols.length ? buildPalette(cols) : DEFAULT_PALETTE);
      })
      .catch(() => setPalette(DEFAULT_PALETTE));
  });

  // Auto-hide the controls after a moment of mouse stillness for immersion.
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function nudgeControls() {
    setControlsVisible(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => setControlsVisible(false), 2600);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // Exit native fullscreen first if we're in it, else close the stage.
      if (document.fullscreenElement) void document.exitFullscreen();
      else closeVisualizer();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      cycleMode();
      nudgeControls();
    }
  }

  function cycleMode() {
    const i = MODES.findIndex((m) => m.id === vizMode());
    setVizMode(MODES[(i + 1) % MODES.length].id);
  }

  async function toggleNativeFullscreen() {
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      // Fullscreen API can reject (permissions / unsupported) — ignore quietly.
    }
  }

  function onFsChange() {
    setIsNativeFs(!!document.fullscreenElement);
  }

  onMount(() => {
    if (!canvas) return;
    const loop = createVizLoop({
      canvas,
      analyser,
      isPlaying: () => player.state.isPlaying,
      mode: () => vizMode(),
      palette: () => palette(),
    });
    document.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFsChange);
    nudgeControls();
    onCleanup(() => {
      loop.stop();
      clearTimeout(hideTimer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
      if (document.fullscreenElement) void document.exitFullscreen();
    });
  });

  return (
    <div
      class="viz-stage"
      classList={{ "viz-controls-hidden": !controlsVisible() }}
      ref={stage}
      role="dialog"
      aria-modal="true"
      aria-label="Music visualiser"
      onMouseMove={nudgeControls}
      // Click the field to exit (controls stop propagation below).
      onClick={() => closeVisualizer()}
    >
      <canvas ref={canvas} class="viz-canvas" aria-hidden="true" />

      <div class="viz-controls" onClick={(e) => e.stopPropagation()}>
        <div class="viz-top">
          <div class="viz-modes" role="tablist" aria-label="Visualiser mode">
            {MODES.map((m) => (
              <button
                class="viz-mode-btn"
                classList={{ active: vizMode() === m.id }}
                role="tab"
                aria-selected={vizMode() === m.id}
                onClick={() => setVizMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div class="viz-actions">
            <button
              class="viz-icon-btn"
              onClick={toggleNativeFullscreen}
              aria-label={isNativeFs() ? "Exit fullscreen" : "Enter fullscreen"}
              title={isNativeFs() ? "Exit fullscreen" : "Fullscreen"}
            >
              <Icon name={isNativeFs() ? "close" : "image"} size={18} />
            </button>
            <button
              class="viz-icon-btn"
              onClick={() => closeVisualizer()}
              aria-label="Close visualiser"
              title="Close (Esc)"
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>

        <div class="viz-bottom">
          <Show when={song()} fallback={<span class="viz-hint">Play something to bring it to life</span>}>
            <div class="viz-nowplaying">
              <span class="viz-track">{song()!.title}</span>
              <span class="viz-artist">{song()!.artist}</span>
            </div>
          </Show>
          <Show when={synthesized}>
            <span class="viz-note" title="The audio stream isn't reachable for analysis (CORS); showing a synthesized animation.">
              Synthesized — stream not analysable
            </span>
          </Show>
        </div>
      </div>
    </div>
  );
}
