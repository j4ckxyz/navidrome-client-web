// Theme sharing: encode the nine region colors + a name into a short, QR-friendly
// code. Format: `ndtheme:<base64url>` where the payload is
//   [version:1][nameLen:1][name:utf8][9 × RGB triplets].
// ~40 bytes -> ~54 base64url chars. Purely client-side; nothing is sent anywhere.

import { hexToRgb, rgbToHex } from "./colors";
import type { ThemeColors } from "~/settings/schema";

const PREFIX = "ndtheme:";
const VERSION = 1;

// Fixed region order so encode/decode stay in sync across versions.
const REGION_ORDER: (keyof ThemeColors)[] = [
  "accent",
  "accentText",
  "sidebarBg",
  "sidebarText",
  "contentBg",
  "contentText",
  "textMuted",
  "surface",
  "nowPlayingBg",
];

export interface SharedTheme {
  name: string;
  colors: ThemeColors;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str: string): Uint8Array {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeTheme(theme: SharedTheme): string {
  const nameBytes = new TextEncoder().encode(theme.name.slice(0, 40));
  const payload = new Uint8Array(2 + nameBytes.length + REGION_ORDER.length * 3);
  let o = 0;
  payload[o++] = VERSION;
  payload[o++] = nameBytes.length;
  payload.set(nameBytes, o);
  o += nameBytes.length;
  for (const region of REGION_ORDER) {
    const { r, g, b } = hexToRgb(theme.colors[region]);
    payload[o++] = r;
    payload[o++] = g;
    payload[o++] = b;
  }
  return PREFIX + bytesToBase64Url(payload);
}

export function decodeTheme(code: string): SharedTheme {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) {
    throw new Error("Not a theme code (must start with 'ndtheme:')");
  }
  const bytes = base64UrlToBytes(trimmed.slice(PREFIX.length));
  if (bytes.length < 2) throw new Error("Theme code is truncated");
  const version = bytes[0];
  if (version !== VERSION) throw new Error(`Unsupported theme version ${version}`);
  const nameLen = bytes[1];
  let o = 2;
  const name = new TextDecoder().decode(bytes.slice(o, o + nameLen));
  o += nameLen;
  const expected = o + REGION_ORDER.length * 3;
  if (bytes.length < expected) throw new Error("Theme code is missing color data");

  const colors = {} as ThemeColors;
  for (const region of REGION_ORDER) {
    colors[region] = rgbToHex({ r: bytes[o], g: bytes[o + 1], b: bytes[o + 2] });
    o += 3;
  }
  return { name: name || "Shared theme", colors };
}
