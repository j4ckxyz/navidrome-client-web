// Color math: hex <-> OKLCH, WCAG contrast, and the simple-mode palette
// derivation. Neutrals are tinted slightly toward the accent hue (low chroma),
// per the project's color principles, with contrast held to readable levels.

import type { ThemeColors } from "~/settings/schema";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// sRGB <-> linear
function toLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function fromLinear(c: number): number {
  const x = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return x * 255;
}

export interface OKLCH {
  l: number; // 0..1
  c: number; // chroma
  h: number; // degrees 0..360
}

export function rgbToOklch({ r, g, b }: RGB): OKLCH {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.sqrt(a * a + bb * bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}

export function oklchToRgb({ l, c, h }: OKLCH): RGB {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return { r: fromLinear(lr), g: fromLinear(lg), b: fromLinear(lb) };
}

export function oklch(l: number, c: number, h: number): string {
  return rgbToHex(oklchToRgb({ l, c, h }));
}

// WCAG relative luminance + contrast ratio.
function relLuminance({ r, g, b }: RGB): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(hexToRgb(a));
  const lb = relLuminance(hexToRgb(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Choose black-ish or white-ish text for best contrast against a background.
export function readableText(bg: string): string {
  const onLight = "#1a1714";
  const onDark = "#f5f0e8";
  return contrastRatio(bg, onDark) >= contrastRatio(bg, onLight) ? onDark : onLight;
}

// Nudge a color's OKLCH lightness by delta (clamped). Used for hover/border
// states derived from a base region color.
export function adjustL(hex: string, delta: number): string {
  const { l, c, h } = rgbToOklch(hexToRgb(hex));
  return oklch(Math.max(0, Math.min(1, l + delta)), c, h);
}

// Is this color dark (low OKLCH lightness)? Used to pick hover direction.
export function isDark(hex: string): boolean {
  return rgbToOklch(hexToRgb(hex)).l < 0.5;
}

// Simple-mode derivation: build all nine regions from a base + accent.
export function derivePalette(base: "dark" | "light", accentHex: string): ThemeColors {
  const accent = rgbToOklch(hexToRgb(accentHex));
  const h = accent.h;
  // Low chroma keeps neutrals tasteful rather than garish.
  const tint = 0.012;

  if (base === "dark") {
    return {
      accent: accentHex,
      accentText: readableText(accentHex),
      nowPlayingBg: oklch(0.13, tint, h),
      sidebarBg: oklch(0.16, tint, h),
      contentBg: oklch(0.19, tint, h),
      surface: oklch(0.25, tint + 0.004, h),
      contentText: oklch(0.95, 0.006, h),
      sidebarText: oklch(0.92, 0.006, h),
      textMuted: oklch(0.66, 0.01, h),
    };
  }
  return {
    accent: accentHex,
    accentText: readableText(accentHex),
    nowPlayingBg: oklch(0.9, tint, h),
    sidebarBg: oklch(0.93, tint, h),
    contentBg: oklch(0.97, tint - 0.004, h),
    surface: oklch(0.995, 0.003, h),
    contentText: oklch(0.22, 0.012, h),
    sidebarText: oklch(0.26, 0.012, h),
    textMuted: oklch(0.48, 0.014, h),
  };
}
