// Shared scaffolding for the visualiser render modes: the palette helpers (cover
// colours → vivid RGB stops) and the small renderer contract the stage drives.

import type { VizFrame } from "./analysis";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const DEFAULT_PALETTE: RGB[] = [
  { r: 110, g: 168, b: 255 },
  { r: 155, g: 108, b: 255 },
  { r: 255, g: 110, b: 199 },
];

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Bump a colour's perceived vividness so dim covers still glow on a black field.
export function liven(c: RGB): RGB {
  const max = Math.max(c.r, c.g, c.b, 1);
  const boost = Math.min(1.7, 200 / max);
  return {
    r: Math.min(255, c.r * boost),
    g: Math.min(255, c.g * boost),
    b: Math.min(255, c.b * boost),
  };
}

export const rgba = (c: RGB, a: number) => `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${a})`;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

// Resolve raw cover hex strings to a vivid palette, falling back to defaults.
export function buildPalette(colors: string[]): RGB[] {
  let p = colors
    .map(hexToRgb)
    .filter((c): c is RGB => !!c)
    .map(liven);
  if (p.length === 0) p = DEFAULT_PALETTE;
  if (p.length === 1) p = [p[0], mixRgb(p[0], DEFAULT_PALETTE[2], 0.5)];
  return p;
}

// Sample a palette as a continuous gradient at position p in [0,1].
export function colorAt(palette: RGB[], p: number): RGB {
  const n = palette.length - 1;
  if (n <= 0) return palette[0];
  const x = Math.max(0, Math.min(0.9999, p)) * n;
  const i = Math.floor(x);
  return mixRgb(palette[i], palette[i + 1], x - i);
}

// HSL → RGB for palette-cycling effects that want to roam the colour wheel.
export function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels (the context is pre-scaled by dpr). */
  width: number;
  height: number;
  /** Seconds since the stage started. */
  time: number;
  /** Seconds since the previous frame (clamped). */
  dt: number;
  /** 0..1 quality budget; the stage lowers it on slow hardware. */
  quality: number;
  palette: RGB[];
  frame: VizFrame;
}

// A visual mode. The stage owns the canvas, RAF loop, analysis and palette; each
// renderer just paints one frame and may keep its own internal state.
export interface VizRenderer {
  readonly id: string;
  readonly label: string;
  /** Notify of a canvas resize (CSS pixels). */
  resize(width: number, height: number): void;
  /** Paint one frame. */
  draw(rc: RenderContext): void;
  /** Release any retained resources. */
  dispose?(): void;
}
