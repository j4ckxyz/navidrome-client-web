// The visualiser render loop: owns the canvas sizing, the rAF tick, the active
// renderer, and the adaptive-quality governor. Deliberately framework-free so the
// SolidJS stage and the Playwright test harness drive the *same* code — the test
// therefore exercises the real analysis + render path, not a stand-in.

import { createAnalysis } from "./analysis";
import { ClassicRenderer } from "./ClassicMode";
import { MagnetosphereRenderer } from "./MagnetosphereMode";
import { DEFAULT_PALETTE, type RGB, type RenderContext, type VizRenderer } from "./renderer";
import type { VizMode } from "./state";

export interface VizLoopOptions {
  canvas: HTMLCanvasElement;
  analyser: AnalyserNode | null;
  isPlaying: () => boolean;
  mode: () => VizMode;
  palette?: () => RGB[];
  /** Notified when the adaptive governor changes the quality budget (0..1). */
  onQuality?: (q: number) => void;
}

export interface VizLoop {
  stop(): void;
  /** Current adaptive quality budget, 0..1. Exposed for tests/diagnostics. */
  quality(): number;
}

// Trail strength per mode: plasma repaints the whole frame so it clears cleanly;
// the particle field keeps a little persistence for motion bloom.
const TRAIL: Record<VizMode, number> = { classic: 0, magnetosphere: 0.78 };

export function createVizLoop(opts: VizLoopOptions): VizLoop {
  const { canvas } = opts;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const analysis = createAnalysis(opts.analyser, { isPlaying: opts.isPlaying });

  const renderers: Record<VizMode, VizRenderer> = {
    classic: new ClassicRenderer(),
    magnetosphere: new MagnetosphereRenderer(),
  };
  let activeId: VizMode | null = null;

  let dpr = 1;
  let w = 0;
  let h = 0;
  function resize(): void {
    dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    w = canvas.clientWidth || canvas.width;
    h = canvas.clientHeight || canvas.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const r of Object.values(renderers)) r.resize(w, h);
  }
  resize();

  let ro: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(resize);
    ro.observe(canvas);
  }

  // Adaptive quality: an EMA of frame time nudges the budget down when we blow
  // ~22ms (≈45fps) and back up when we have comfortable headroom, so weak
  // hardware sheds particles/plasma resolution instead of stuttering.
  let quality = 1;
  let frameMs = 16;
  const BUDGET_HI = 22; // ms — over this, ease quality down
  const BUDGET_LO = 13; // ms — under this, ease quality back up

  const start = now();
  let last = start;
  let raf = 0;

  function tick(): void {
    raf = requestAnimationFrame(tick);
    const t = now();
    const dtMs = t - last;
    last = t;

    frameMs = frameMs * 0.9 + dtMs * 0.1;
    if (frameMs > BUDGET_HI && quality > 0.25) quality = Math.max(0.25, quality - 0.02);
    else if (frameMs < BUDGET_LO && quality < 1) quality = Math.min(1, quality + 0.01);

    const mode = opts.mode();
    const renderer = renderers[mode];
    if (mode !== activeId) {
      activeId = mode;
      renderer.resize(w, h); // ensure freshly-shown renderer matches the canvas
    }

    // Background: clear (plasma) or fade (particle trails).
    const trail = TRAIL[mode];
    if (trail > 0) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - trail).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    }

    const rc: RenderContext = {
      ctx,
      width: w,
      height: h,
      time: (t - start) / 1000,
      dt: Math.min(0.05, dtMs / 1000),
      quality,
      palette: opts.palette?.() ?? DEFAULT_PALETTE,
      frame: analysis.read(),
    };
    renderer.draw(rc);
    opts.onQuality?.(quality);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const r of Object.values(renderers)) r.dispose?.();
    },
    quality: () => quality,
  };
}

function now(): number {
  return (typeof performance !== "undefined" ? performance : Date).now();
}
