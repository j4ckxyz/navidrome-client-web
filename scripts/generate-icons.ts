// Generates the PWA icon set into public/icons/ — run `bun run scripts/generate-icons.ts`
// after changing the design. Pure-code rasterizer (no image deps): draws the
// same record mark as the favicon and encodes PNGs by hand using fflate's zlib.
// Desktop users can choose a colour without changing the familiar symbol.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zlibSync } from "fflate";

interface RGB {
  r: number;
  g: number;
  b: number;
}

export type AppIconVariant = "amber" | "ocean" | "violet" | "rose";

interface Palette {
  bg: RGB;
  fg: RGB;
}

const PALETTES: Record<AppIconVariant, Palette> = {
  amber: {
    bg: { r: 0xe6, g: 0xa1, b: 0x4c },
    fg: { r: 0x1a, g: 0x14, b: 0x10 },
  },
  ocean: {
    bg: { r: 0x42, g: 0xa5, b: 0xc7 },
    fg: { r: 0x09, g: 0x22, b: 0x32 },
  },
  violet: {
    bg: { r: 0x9a, g: 0x7d, b: 0xe8 },
    fg: { r: 0x20, g: 0x13, b: 0x3c },
  },
  rose: {
    bg: { r: 0xec, g: 0x70, b: 0x86 },
    fg: { r: 0x35, g: 0x0e, b: 0x1c },
  },
};

// The bundle/PWA icon is Ocean. Amber remains available in the picker for
// anyone who prefers the original Tonearm colour.
const DEFAULT_VARIANT: AppIconVariant = "ocean";

// --- Tiny PNG encoder --------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Raw scanlines, each prefixed with filter byte 0.
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// --- Rasterizer --------------------------------------------------------------

// Signed distance to a rounded square centred in the canvas (negative inside).
function sdRoundedSquare(x: number, y: number, half: number, radius: number): number {
  const qx = Math.abs(x) - (half - radius);
  const qy = Math.abs(y) - (half - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Signed distance to a ring (circle outline of given radius/width).
function sdRing(x: number, y: number, radius: number, width: number): number {
  return Math.abs(Math.hypot(x, y) - radius) - width / 2;
}

function coverage(d: number): number {
  // ~1px anti-aliasing band around the edge.
  return Math.min(1, Math.max(0, 0.5 - d));
}

interface IconOpts {
  size: number;
  palette: Palette;
  // Maskable icons need full-bleed background with the mark inside the 80% safe zone.
  fullBleed?: boolean;
}

function renderIcon({ size, palette, fullBleed }: IconOpts): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const half = size / 2;
  const cornerR = (size * 10) / 36;
  const mark = fullBleed ? 0.78 : 1; // shrink the record into the safe zone
  const outerR = size * 0.285 * mark;
  const innerR = size * 0.085 * mark;
  const stroke = size * 0.052 * mark;
  const SS = 3; // supersampling grid

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgA = 0;
      let fgA = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS - half;
          const y = py + (sy + 0.5) / SS - half;
          const bg = fullBleed ? 1 : coverage(sdRoundedSquare(x, y, half, cornerR));
          const ring = Math.min(sdRing(x, y, outerR, stroke), sdRing(x, y, innerR, stroke));
          bgA += bg;
          fgA += coverage(ring) * bg;
        }
      }
      bgA /= SS * SS;
      fgA /= SS * SS;
      const i = (py * size + px) * 4;
      // Composite: ink over amber over transparent.
      rgba[i] = palette.fg.r * fgA + palette.bg.r * (1 - fgA);
      rgba[i + 1] = palette.fg.g * fgA + palette.bg.g * (1 - fgA);
      rgba[i + 2] = palette.fg.b * fgA + palette.bg.b * (1 - fgA);
      rgba[i + 3] = Math.round(bgA * 255);
    }
  }
  return rgba;
}

const outDir = join(import.meta.dir, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const targets: { file: string; size: number; fullBleed?: boolean }[] = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512, fullBleed: true },
  // iOS home-screen icon; Apple applies its own corner mask, so full bleed.
  { file: "apple-touch-icon.png", size: 180, fullBleed: true },
];

for (const t of targets) {
  const png = encodePng(
    t.size,
    renderIcon({ ...t, palette: PALETTES[DEFAULT_VARIANT] }),
  );
  writeFileSync(join(outDir, t.file), png);
  console.log(`wrote public/icons/${t.file} (${png.length} bytes)`);
}

const desktopDir = join(outDir, "app-icons");
mkdirSync(desktopDir, { recursive: true });
for (const [name, palette] of Object.entries(PALETTES) as [AppIconVariant, Palette][]) {
  const png = encodePng(512, renderIcon({ size: 512, palette }));
  writeFileSync(join(desktopDir, `${name}.png`), png);
  console.log(`wrote public/icons/app-icons/${name}.png (${png.length} bytes)`);
}
