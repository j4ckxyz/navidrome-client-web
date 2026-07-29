// A small global "download" dialog. Album/playlist/track menus call
// openDownload(target); the dialog (mounted once at app root) lets the user pick
// a quality, then kicks off the right download path. See download.ts for the
// mechanics and why lossy collection downloads need proxy mode.

import { Dialog } from "@kobalte/core";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Song } from "~/api/types";
import { client } from "~/auth/session";
import { Icon } from "~/ui/Icon";
import { proxyMode } from "~/lib/serverConfig";
import { formatCount } from "~/lib/format";
import {
  QUALITIES,
  isLossy,
  downloadSong,
  downloadCollectionOriginal,
  downloadCollectionZip,
  downloadCollectionClientZip,
  type Quality,
} from "./download";
import "./download.css";

export type DownloadTarget =
  | { kind: "song"; song: Song }
  | { kind: "album"; id: string; name: string; artist?: string; songs: Song[] }
  | { kind: "playlist"; id: string; name: string; songs: Song[] };

const [target, setTarget] = createSignal<DownloadTarget | null>(null);
const [busy, setBusy] = createSignal(false);
// "3 of 12" while a client-side zip is being assembled — it can take a while,
// and a dialog that just sits there looks broken.
const [progress, setProgress] = createSignal<{ done: number; total: number } | null>(null);

export function openDownload(t: DownloadTarget): void {
  if (t.kind !== "song" && t.songs.length === 0) return;
  setTarget(t);
}

function title(t: DownloadTarget): string {
  return t.kind === "song" ? t.song.title : t.name;
}

function subtitle(t: DownloadTarget): string {
  if (t.kind === "song") return t.song.artist ?? "Song";
  return formatCount(t.songs.length, "track");
}

export function DownloadDialog() {
  // Whether the server bundles a collection for us. Navidrome zips originals
  // server-side and lossy versions through our proxy; Jellyfin has no such
  // endpoint, so those get zipped in the browser instead (see download.ts).
  const serverZips = createMemo(() => client()?.canDownloadCollections ?? false);
  const clientZips = createMemo(() => {
    const t = target();
    return !!t && t.kind !== "song" && !serverZips();
  });

  // Lossy options for a whole collection need *somewhere* to transcode: our
  // backend in proxy mode, or the browser pulling per-track transcodes from a
  // server that can produce them. Single songs transcode anywhere.
  const allowLossy = createMemo(() => {
    const t = target();
    if (!t) return true;
    if (t.kind === "song") return true;
    if (serverZips()) return proxyMode();
    return client()?.canTranscodeDownloads ?? false;
  });

  const qualities = createMemo(() =>
    QUALITIES.filter((q) => !isLossy(q) || allowLossy()),
  );

  async function choose(q: Quality) {
    const t = target();
    if (!t || busy()) return;
    setBusy(true);
    try {
      if (t.kind === "song") {
        await downloadSong(t.song, q);
        setTarget(null);
        return;
      }
      const zipBase = t.kind === "album" && t.artist ? `${t.artist} - ${t.name}` : t.name;
      if (clientZips()) {
        // No server-side bundling (Jellyfin): assemble the archive here.
        setProgress({ done: 0, total: t.songs.length });
        await downloadCollectionClientZip({
          songs: t.songs,
          quality: q,
          zipBaseName: zipBase,
          byTrackNumber: t.kind === "album",
          onProgress: (done, total) => setProgress({ done, total }),
        });
      } else if (!isLossy(q)) {
        // Original collection: Navidrome zips the source files.
        downloadCollectionOriginal(t.id);
      } else {
        // Lossy collection: our backend transcodes and streams a zip.
        downloadCollectionZip({
          songs: t.songs,
          quality: q,
          zipBaseName: zipBase,
          byTrackNumber: t.kind === "album",
        });
      }
      setTarget(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Dialog.Root open={target() !== null} onOpenChange={(o) => !o && setTarget(null)}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Dialog.Content class="dialog-content dl-dialog">
            <div class="dialog-header">
              <Dialog.Title class="dialog-title">Download</Dialog.Title>
              <Dialog.CloseButton class="icon-btn">
                <Icon name="close" size={18} />
              </Dialog.CloseButton>
            </div>

            <Show when={target()}>
              {(t) => (
                <div class="dl-target">
                  <Icon name={t().kind === "song" ? "disc" : t().kind === "album" ? "disc" : "list"} size={16} />
                  <div class="dl-target-text">
                    <span class="dl-target-title">{title(t())}</span>
                    <span class="muted">{subtitle(t())}</span>
                  </div>
                </div>
              )}
            </Show>

            <div class="dl-qualities">
                <For each={qualities()}>
                  {(q) => (
                    <button class="dl-quality" disabled={busy()} onClick={() => choose(q)}>
                      <Icon name="download" size={16} />
                      <span class="dl-quality-text">
                        <span class="dl-quality-label">{q.label}</span>
                        <span class="muted">{q.sub}</span>
                      </span>
                    </button>
                  )}
                </For>
              </div>

            <Show when={progress()}>
              {(p) => (
                <p class="dl-note muted">
                  Building archive — track {p().done} of {p().total}…
                </p>
              )}
            </Show>

            <Show when={clientZips() && !progress()}>
              <p class="dl-note muted">
                This server can't bundle a {target()!.kind}, so the archive is built
                here in your browser. Keep this tab open until it finishes.
              </p>
            </Show>

            <Show when={target() && target()!.kind !== "song" && serverZips() && !proxyMode()}>
              <p class="dl-note muted">
                Transcoded (lossy) downloads of a whole {target()!.kind} need the
                bundled server in proxy mode. Original quality is available now.
              </p>
            </Show>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
