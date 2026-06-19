// Extract a colour palette from an image (album art). Used to build an album
// page's gradient backdrop and to generate a theme from a cover.
//
// Requires the image to be CORS-clean (same-origin in proxy mode, or a server
// that sends Access-Control-Allow-Origin). Throws if the canvas is tainted, so
// callers should handle failure gracefully.

import { rgbToHex, rgbToOklch, type RGB } from "~/theme/colors";

export interface ExtractedColors {
  palette: string[]; // dominant colours, most frequent first
  accent: string; // the most usable vivid colour for an accent
}

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = url;
  });
}

export async function extractColors(url: string): Promise<ExtractedColors> {
  const img = await loadImage(url);
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, size, size);

  // Throws SecurityError if the image tainted the canvas (no CORS).
  const { data } = ctx.getImageData(0, 0, size, size);

  // Quantise to 16 levels per channel and tally, averaging the true colour
  // within each bucket so the result isn't a coarse step value.
  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 125) continue; // skip transparent
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const e = buckets.get(key);
    if (e) {
      e.count++;
      e.r += r;
      e.g += g;
      e.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  const colours = [...buckets.values()]
    .map((e) => ({ count: e.count, rgb: { r: e.r / e.count, g: e.g / e.count, b: e.b / e.count } }))
    .sort((a, b) => b.count - a.count);

  if (colours.length === 0) throw new Error("No colours found");

  const palette = colours.slice(0, 6).map((c) => rgbToHex(c.rgb));

  // Accent: among the frequent colours, the most vivid (high chroma) that isn't
  // near-black or near-white, lightly weighted by how common it is.
  let accent = palette[0];
  let best = -1;
  for (const c of colours.slice(0, 14)) {
    const { l, c: chroma } = rgbToOklch(c.rgb);
    if (l < 0.12 || l > 0.9) continue;
    const score = chroma * 4 + Math.log(c.count + 1) * 0.04;
    if (score > best) {
      best = score;
      accent = rgbToHex(c.rgb);
    }
  }

  return { palette, accent };
}

// Pick up to `n` visually distinct colours from a palette for a gradient, so the
// result has variety rather than three near-identical shades.
export function distinctColours(palette: string[], n = 3): string[] {
  const chosen: { hex: string; rgb: RGB }[] = [];
  for (const hex of palette) {
    const rgb = hexToRgbLocal(hex);
    const tooClose = chosen.some(({ rgb: o }) => {
      const d = Math.abs(o.r - rgb.r) + Math.abs(o.g - rgb.g) + Math.abs(o.b - rgb.b);
      return d < 60;
    });
    if (!tooClose) chosen.push({ hex, rgb });
    if (chosen.length >= n) break;
  }
  // Pad from the palette if we couldn't find enough distinct ones.
  while (chosen.length < Math.min(n, palette.length)) {
    const next = palette[chosen.length];
    if (!next) break;
    chosen.push({ hex: next, rgb: hexToRgbLocal(next) });
  }
  return chosen.map((c) => c.hex);
}

function hexToRgbLocal(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
