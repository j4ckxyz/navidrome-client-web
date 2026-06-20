// A small global "download" dialog. Album/playlist/track menus call
// openDownload(target); the dialog (mounted once at app root) lets the user pick
// a quality, then kicks off the right download path. See download.ts for the
// mechanics and why lossy collection downloads need proxy mode.

import { Dialog } from "@kobalte/core";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Song } from "~/api/types";
import { Icon } from "~/ui/Icon";
import { proxyMode } from "~/lib/serverConfig";
import { formatCount } from "~/lib/format";
import {
  QUALITIES,
  isLossy,
  downloadSong,
  downloadCollectionOriginal,
  downloadCollectionZip,
  type Quality,
} from "./download";
import "./download.css";

export type DownloadTarget =
  | { kind: "song"; song: Song }
  | { kind: "album"; id: string; name: string; artist?: string; songs: Song[] }
  | { kind: "playlist"; id: string; name: string; songs: Song[] };

const [target, setTarget] = createSignal<DownloadTarget | null>(null);
const [busy, setBusy] = createSignal(false);

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
  // Lossy options for a whole collection are only possible when our backend can
  // transcode + zip server-side (proxy mode). Single songs transcode anywhere.
  const allowLossy = createMemo(() => {
    const t = target();
    if (!t) return true;
    return t.kind === "song" || proxyMode();
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
      } else if (!isLossy(q)) {
        // Original collection: Navidrome zips the source files.
        downloadCollectionOriginal(t.id);
      } else {
        // Lossy collection: our backend transcodes and streams a zip.
        const zipBaseName =
          t.kind === "album" && t.artist ? `${t.artist} - ${t.name}` : t.name;
        downloadCollectionZip({
          songs: t.songs,
          quality: q,
          zipBaseName,
          byTrackNumber: t.kind === "album",
        });
      }
      setTarget(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(false);
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

            <Show when={target() && target()!.kind !== "song" && !proxyMode()}>
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
