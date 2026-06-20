// Playlist detail: play, reorder (drag), remove tracks, rename, and delete — all
// persisted to the server via the API so changes sync to other clients.

import { createQuery } from "@tanstack/solid-query";
import { useNavigate, useParams } from "@solidjs/router";
import { createEffect, createSignal, For, Show } from "solid-js";
import { client } from "~/auth/session";
import type { Song } from "~/api/types";
import { qk, queryClient } from "~/lib/query";
import { player } from "~/player/store";
import { TrackRow } from "~/ui/TrackRow";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { MenuButton } from "~/ui/Menu";
import { AsyncState } from "~/ui/AsyncState";
import { shareLink } from "~/features/share/share";
import { openDownload } from "~/features/download/DownloadDialog";
import { formatCount, formatLongDuration } from "~/lib/format";
import "./playlist.css";

export default function PlaylistDetail() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  const q = createQuery(() => ({
    queryKey: qk.playlist(params.id),
    queryFn: () => client()!.getPlaylist(params.id),
    enabled: !!client(),
  }));

  // Local working copy of order for instant drag feedback.
  const [order, setOrder] = createSignal<Song[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [name, setName] = createSignal("");
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [overIndex, setOverIndex] = createSignal<number | null>(null);
  const [coverBusy, setCoverBusy] = createSignal(false);
  let coverInput: HTMLInputElement | undefined;

  const canEditCover = () => !!client()?.canEditServerImages;

  async function onPickCover(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;
    setCoverBusy(true);
    try {
      await client()!.uploadPlaylistImage(params.id, file);
      // Re-fetch so the new server-side cover (and its art id) loads everywhere.
      await queryClient.invalidateQueries({ queryKey: qk.playlist(params.id) });
      queryClient.invalidateQueries({ queryKey: qk.playlists() });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setCoverBusy(false);
    }
  }

  createEffect(() => {
    if (q.data) {
      setOrder(q.data.entry);
      setName(q.data.name);
    }
  });

  async function persistOrder(next: Song[]) {
    setSaving(true);
    setOrder(next);
    try {
      await client()!.overwritePlaylist(
        params.id,
        next.map((s) => s.id),
        q.data?.entry.length ?? next.length,
      );
      queryClient.invalidateQueries({ queryKey: qk.playlist(params.id) });
    } finally {
      setSaving(false);
    }
  }

  function onDrop(target: number) {
    const from = dragIndex();
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === target) return;
    const next = [...order()];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    void persistOrder(next);
  }

  async function removeAt(index: number) {
    setSaving(true);
    const next = order().filter((_, i) => i !== index);
    setOrder(next);
    try {
      await client()!.updatePlaylist(params.id, { songIndexToRemove: [index] });
      queryClient.invalidateQueries({ queryKey: qk.playlist(params.id) });
      queryClient.invalidateQueries({ queryKey: qk.playlists() });
    } finally {
      setSaving(false);
    }
  }

  async function rename(e: Event) {
    e.preventDefault();
    const newName = name().trim();
    if (!newName) return;
    await client()!.updatePlaylist(params.id, { name: newName });
    setEditing(false);
    queryClient.invalidateQueries({ queryKey: qk.playlist(params.id) });
    queryClient.invalidateQueries({ queryKey: qk.playlists() });
  }

  // Whether the active user owns this playlist (only owners can change it).
  function ownsCurrent(): boolean {
    const me = client()?.username;
    const owner = q.data?.owner;
    return !owner || !me || owner === me;
  }

  // Flip a playlist between private (owner-only) and public (visible to everyone
  // on the server). Confirm before exposing it.
  async function toggleVisibility() {
    const pl = q.data;
    if (!pl || !ownsCurrent()) return;
    const makePublic = !pl.public;
    if (
      makePublic &&
      !confirm("Make this playlist public? Everyone on this server will be able to see it.")
    ) {
      return;
    }
    setSaving(true);
    try {
      await client()!.setPlaylistVisibility(params.id, makePublic);
      queryClient.invalidateQueries({ queryKey: qk.playlist(params.id) });
      queryClient.invalidateQueries({ queryKey: qk.playlists() });
    } finally {
      setSaving(false);
    }
  }

  async function deletePlaylist() {
    if (!confirm(`Delete playlist "${q.data?.name}"? This cannot be undone.`)) return;
    await client()!.deletePlaylist(params.id);
    queryClient.invalidateQueries({ queryKey: qk.playlists() });
    navigate("/");
  }

  return (
    <div class="page">
      <AsyncState loading={q.isLoading} error={q.error}>
        <Show when={q.data}>
          {(pl) => (
            <>
              <header class="detail-head">
                <div class="detail-art pl-art">
                  <CoverArt coverArt={pl().coverArt ?? order()[0]?.coverArt} alt={pl().name} />
                  <Show when={canEditCover()}>
                    <button
                      class="pl-art-edit"
                      onClick={() => coverInput?.click()}
                      title="Upload a cover photo"
                      disabled={coverBusy()}
                    >
                      <Show when={!coverBusy()} fallback={<span class="spinner" style={{ width: "16px", height: "16px" }} />}>
                        <Icon name="upload" size={16} />
                        <span>Cover photo</span>
                      </Show>
                    </button>
                    <input
                      ref={coverInput}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      style={{ display: "none" }}
                      onChange={onPickCover}
                    />
                  </Show>
                </div>
                <div class="detail-info">
                  <span class="detail-kind">Playlist</span>
                  <Show
                    when={!editing()}
                    fallback={
                      <form class="pl-rename" onSubmit={rename}>
                        <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
                        <button class="btn btn-primary" type="submit">Save</button>
                        <button class="btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
                      </form>
                    }
                  >
                    <h1 class="detail-title">{pl().name}</h1>
                  </Show>
                  <Show when={pl().comment}>
                    <p class="muted">{pl().comment}</p>
                  </Show>
                  <div class="detail-sub">
                    <button
                      class="pl-visibility"
                      classList={{ "pl-visibility-on": pl().public }}
                      onClick={toggleVisibility}
                      disabled={!ownsCurrent()}
                      title={
                        ownsCurrent()
                          ? pl().public
                            ? "Public — visible to everyone on this server. Click to make private."
                            : "Private — only you can see this. Click to make public."
                          : `Owned by ${pl().owner}`
                      }
                    >
                      <Icon name={pl().public ? "globe" : "lock"} size={12} />
                      {pl().public ? "Public" : "Private"}
                    </button>
                    <span class="detail-dot">{formatCount(order().length, "track")}</span>
                    <span class="detail-dot">{formatLongDuration(pl().duration)}</span>
                    <Show when={saving()}>
                      <span class="detail-dot pl-saving">
                        <span class="spinner" style={{ width: "12px", height: "12px" }} /> Saving…
                      </span>
                    </Show>
                  </div>
                </div>
              </header>

              <div class="detail-actions">
                <button
                  class="play-big"
                  onClick={() => {
                    const isCurrentPlaylist = order().some(s => s.id === player.current()?.id);
                    if (isCurrentPlaylist) {
                      player.togglePlay();
                    } else {
                      player.playNow(order(), 0);
                    }
                  }}
                  disabled={order().length === 0}
                >
                  <Icon name={player.state.isPlaying && order().some(s => s.id === player.current()?.id) ? "pause" : "play"} size={20} class="play-big-icon" />
                  {player.state.isPlaying && order().some(s => s.id === player.current()?.id) ? "Pause" : "Play"}
                </button>
                <button class="btn" onClick={() => player.playNow([...order()].sort(() => Math.random() - 0.5), 0)} disabled={order().length === 0}>
                  <Icon name="shuffle" size={17} /> Shuffle
                </button>
                <MenuButton
                  items={[
                    { label: "Add to queue", icon: "queue", onSelect: () => player.addToQueue(order()) },
                    { label: "Share", icon: "share", onSelect: () => shareLink(`/playlist/${pl().id}`, pl().name), separatorBefore: true },
                    { label: "Download…", icon: "download", onSelect: () => openDownload({ kind: "playlist", id: pl().id, name: pl().name, songs: order() }) },
                    ...(canEditCover()
                      ? [{ label: "Upload cover photo", icon: "upload" as const, onSelect: () => coverInput?.click(), separatorBefore: true }]
                      : []),
                    { label: "Rename", icon: "edit" as const, onSelect: () => setEditing(true), separatorBefore: true },
                    { label: "Delete playlist", icon: "trash" as const, onSelect: deletePlaylist, danger: true },
                  ]}
                />
              </div>

              <Show
                when={order().length > 0}
                fallback={<div class="center-state"><Icon name="list" size={28} /><p>This playlist is empty.</p></div>}
              >
                <div class="tracklist-head">
                  <span class="tracklist-head-num">#</span>
                  <span class="tracklist-head-title">Title</span>
                  <span class="tracklist-head-album">Album</span>
                  <span class="tracklist-head-dur">Time</span>
                  <span class="tracklist-head-spacer" />
                </div>
                <For each={order()}>
                  {(song, i) => (
                    <div
                      class="pl-row"
                      classList={{ "pl-row-over": overIndex() === i() }}
                      draggable={true}
                      onDragStart={() => setDragIndex(i())}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOverIndex(i());
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        onDrop(i());
                      }}
                    >
                      <span class="pl-grip" aria-hidden="true">
                        <Icon name="grip" size={15} />
                      </span>
                      <div class="pl-row-track">
                        <TrackRow
                          song={song}
                          number={i() + 1}
                          context={order()}
                          contextIndex={i()}
                          showAlbum
                          onRemoveFromPlaylist={() => removeAt(i())}
                        />
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </>
          )}
        </Show>
      </AsyncState>
    </div>
  );
}
