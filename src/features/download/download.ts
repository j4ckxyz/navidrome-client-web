// Download logic for songs, albums and playlists at a chosen quality.
//
// Original quality is served straight from Navidrome: a song downloads its file,
// an album/playlist downloads a ZIP of the original files (Navidrome builds it).
// Lossy/transcoded quality goes through Navidrome's transcoder via stream.view;
// for a single song the browser fetches and saves it, but for a whole collection
// the files are zipped by *our* backend (/download/zip), which only exists when
// the app runs in proxy mode. See [[project-status]] and [[local-tooling]].

import type { Song } from "~/api/types";
import { client } from "~/auth/session";

export interface Quality {
  id: string;
  label: string;
  sub: string;
  format?: string; // undefined => original, no transcode
  bitRate?: number;
  ext?: string; // output extension when transcoded
}

export const QUALITIES: Quality[] = [
  { id: "original", label: "Original", sub: "Lossless / exactly as stored" },
  { id: "opus", label: "Opus · 192k", sub: "Efficient, near-transparent", format: "opus", bitRate: 192, ext: "opus" },
  { id: "mp3-320", label: "MP3 · 320k", sub: "Maximum compatibility", format: "mp3", bitRate: 320, ext: "mp3" },
  { id: "mp3-128", label: "MP3 · 128k", sub: "Smallest files", format: "mp3", bitRate: 128, ext: "mp3" },
];

export function isLossy(q: Quality): boolean {
  return !!q.format;
}

// Strip filesystem-hostile characters so names are safe inside a ZIP and on disk.
export function sanitizeName(s: string): string {
  return (s || "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "untitled";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Filename for a single downloaded song.
export function songFileName(song: Song, ext?: string): string {
  const e = ext || song.suffix || "mp3";
  const base = song.track
    ? `${pad2(song.track)} ${song.title}`
    : song.artist
      ? `${song.artist} - ${song.title}`
      : song.title;
  return `${sanitizeName(base)}.${e}`;
}

// Names for tracks inside a collection ZIP. Uses track numbers for albums and
// running position for playlists, prefixes multi-disc albums, and guarantees
// uniqueness so no entry overwrites another.
function collectionEntryNames(songs: Song[], ext: string | undefined, byTrackNumber: boolean): string[] {
  const seen = new Map<string, number>();
  return songs.map((song, i) => {
    const e = ext || song.suffix || "mp3";
    const num = byTrackNumber && song.track ? song.track : i + 1;
    const discPrefix = byTrackNumber && song.discNumber && song.discNumber > 1 ? `${song.discNumber}-` : "";
    let name = `${sanitizeName(`${discPrefix}${pad2(num)} ${song.title}`)}.${e}`;
    const lower = name.toLowerCase();
    const count = seen.get(lower) ?? 0;
    seen.set(lower, count + 1);
    if (count > 0) name = name.replace(new RegExp(`\\.${e}$`), ` (${count + 1}).${e}`);
    return name;
  });
}

function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

// Fetch a URL and save it under our chosen filename. Used for single songs so
// the extension/name is correct regardless of what the server would have named it.
async function fetchAndSave(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  saveBlob(await res.blob(), filename);
}

// Navigate to a URL whose response is an attachment, letting the browser stream
// it straight to disk (no in-memory buffering). Cross-origin ignores the
// download hint, but the server's Content-Disposition still forces the download.
function navigateDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// POST a payload via a hidden form targeting a hidden iframe, so the streamed ZIP
// response downloads to disk without buffering it in JS memory.
function submitHiddenForm(action: string, payload: string): void {
  const frameName = `nd-dl-${Date.now()}`;
  const iframe = document.createElement("iframe");
  iframe.name = frameName;
  iframe.style.display = "none";
  document.body.appendChild(iframe);

  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.target = frameName;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "payload";
  input.value = payload;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();

  window.setTimeout(() => {
    form.remove();
    iframe.remove();
  }, 5 * 60_000);
}

// --- Public entry points ----------------------------------------------------

export async function downloadSong(song: Song, quality: Quality): Promise<void> {
  const c = client();
  if (!c) return;
  if (isLossy(quality)) {
    const url = c.streamUrl(song.id, quality.bitRate, quality.format);
    await fetchAndSave(url, songFileName(song, quality.ext));
  } else {
    // Original: let the server stream it with its own Content-Disposition.
    navigateDownload(c.downloadUrl(song.id));
  }
}

// Download an album/playlist as original files — Navidrome assembles the ZIP.
export function downloadCollectionOriginal(id: string): void {
  const c = client();
  if (!c) return;
  navigateDownload(c.downloadUrl(id));
}

// Download an album/playlist transcoded to a lossy format, zipped by our backend.
// Only available in proxy mode (the backend must reach Navidrome).
export function downloadCollectionZip(opts: {
  songs: Song[];
  quality: Quality;
  zipBaseName: string;
  byTrackNumber: boolean;
}): void {
  const c = client();
  if (!c || !isLossy(opts.quality)) return;
  const names = collectionEntryNames(opts.songs, opts.quality.ext, opts.byTrackNumber);
  const tracks = opts.songs.map((s, i) => ({ id: s.id, name: names[i] }));
  const payload = JSON.stringify({
    zipName: `${sanitizeName(opts.zipBaseName)}.zip`,
    format: opts.quality.format,
    bitRate: opts.quality.bitRate,
    tracks,
    ...c.subsonicAuth,
  });
  submitHiddenForm("/download/zip", payload);
}
