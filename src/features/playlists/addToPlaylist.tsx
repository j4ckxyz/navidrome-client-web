// A small global "add to playlist" dialog. Track/album menus call
// openAddToPlaylist(songIds); the dialog (mounted once at app root) handles
// picking an existing playlist or creating a new one. All writes go to the API.

import { Dialog } from "@kobalte/core";
import { createSignal, For, Show } from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import { client } from "~/auth/session";
import { qk, queryClient } from "~/lib/query";
import { Icon } from "~/ui/Icon";
import { formatCount } from "~/lib/format";
import "./addToPlaylist.css";

const [pendingIds, setPendingIds] = createSignal<string[] | null>(null);
const [newName, setNewName] = createSignal("");
const [busy, setBusy] = createSignal(false);
const [toast, setToast] = createSignal<string | null>(null);

export function openAddToPlaylist(songIds: string[]): void {
  if (songIds.length === 0) return;
  setNewName("");
  setPendingIds(songIds);
}

function flash(msg: string): void {
  setToast(msg);
  window.setTimeout(() => setToast(null), 2600);
}

export function AddToPlaylistDialog() {
  const playlists = createQuery(() => ({
    queryKey: qk.playlists(),
    queryFn: () => client()!.getPlaylists(),
    enabled: !!client(),
  }));

  // Only your own playlists — you can't add tracks to someone else's anyway.
  const mine = () => {
    const me = client()?.username;
    return (playlists.data ?? []).filter((pl) => !me || !pl.owner || pl.owner === me);
  };

  async function addToExisting(id: string, name: string) {
    const ids = pendingIds();
    if (!ids) return;
    setBusy(true);
    try {
      await client()!.updatePlaylist(id, { songIdToAdd: ids });
      queryClient.invalidateQueries({ queryKey: qk.playlist(id) });
      queryClient.invalidateQueries({ queryKey: qk.playlists() });
      flash(`Added ${formatCount(ids.length, "track")} to ${name}`);
      setPendingIds(null);
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(e: Event) {
    e.preventDefault();
    const ids = pendingIds();
    const name = newName().trim();
    if (!ids || !name) return;
    setBusy(true);
    try {
      await client()!.createPlaylist(name, ids);
      queryClient.invalidateQueries({ queryKey: qk.playlists() });
      flash(`Created ${name} with ${formatCount(ids.length, "track")}`);
      setPendingIds(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog.Root open={pendingIds() !== null} onOpenChange={(o) => !o && setPendingIds(null)}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <div class="dialog-positioner">
            <Dialog.Content class="dialog-content atp-dialog">
              <div class="dialog-header">
                <Dialog.Title class="dialog-title">Add to playlist</Dialog.Title>
                <Dialog.CloseButton class="icon-btn">
                  <Icon name="close" size={18} />
                </Dialog.CloseButton>
              </div>

              <form class="atp-new" onSubmit={createAndAdd}>
                <input
                  class="input"
                  placeholder="New playlist name…"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                />
                <button class="btn btn-primary" type="submit" disabled={busy() || !newName().trim()}>
                  <Icon name="plus" size={16} /> Create
                </button>
              </form>

              <div class="atp-divider"><span>or add to existing</span></div>

              <div class="atp-list">
                <Show
                  when={mine().length > 0}
                  fallback={<p class="muted atp-empty">No playlists yet.</p>}
                >
                  <For each={mine()}>
                    {(pl) => (
                      <button
                        class="atp-item"
                        disabled={busy()}
                        onClick={() => addToExisting(pl.id, pl.name)}
                      >
                        <Icon name="list" size={16} />
                        <span class="atp-item-name">{pl.name}</span>
                        <span class="muted">{formatCount(pl.songCount, "track")}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>

      <Show when={toast()}>
        <div class="toast" role="status">
          <Icon name="check" size={16} /> {toast()}
        </div>
      </Show>
    </>
  );
}
