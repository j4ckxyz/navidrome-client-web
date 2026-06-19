// Primary navigation. Library sections up top, the user's playlists below, and
// the active server + settings/logout pinned to the bottom.

import { A, useNavigate } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { createSignal, For, Show } from "solid-js";
import { client, activeServerUrl, activeUsername, logout, isAdmin } from "~/auth/session";
import { uploadEnabled } from "~/lib/serverConfig";
import { qk, queryClient } from "~/lib/query";
import { Icon, type IconName } from "~/ui/Icon";
import "./sidebar.css";

const NAV: { href: string; label: string; icon: IconName; end?: boolean }[] = [
  { href: "/", label: "Home", icon: "home", end: true },
  { href: "/albums", label: "Albums", icon: "disc" },
  { href: "/artists", label: "Artists", icon: "mic" },
  { href: "/genres", label: "Genres", icon: "tag" },
  { href: "/favourites", label: "Favourites", icon: "heart" },
  { href: "/recap", label: "Recap", icon: "trending" },
];

export function Sidebar(props: { onUpload?: () => void }) {
  const navigate = useNavigate();
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal("");

  const playlists = createQuery(() => ({
    queryKey: qk.playlists(),
    queryFn: () => client()!.getPlaylists(),
    enabled: !!client(),
  }));

  async function createPlaylist(e: Event) {
    e.preventDefault();
    const name = newName().trim();
    if (!name) return;
    await client()!.createPlaylist(name);
    setNewName("");
    setCreating(false);
    queryClient.invalidateQueries({ queryKey: qk.playlists() });
  }

  return (
    <nav class="sidebar">
      <div class="sidebar-inner">
      <A href="/" end class="sidebar-brand">
        <span class="sidebar-logo">
          <Icon name="disc" size={22} />
        </span>
        <span class="sidebar-brand-name">Navidrome</span>
      </A>

      <div class="sidebar-nav">
        <For each={NAV}>
          {(item) => (
            <A href={item.href} end={item.end} class="sidebar-link" activeClass="sidebar-link-active">
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
            </A>
          )}
        </For>
      </div>

      <div class="sidebar-playlists">
        <div class="sidebar-section-head">
          <span>Playlists</span>
          <button class="icon-btn sidebar-add" onClick={() => setCreating((v) => !v)} aria-label="New playlist">
            <Icon name="plus" size={16} />
          </button>
        </div>

        <Show when={creating()}>
          <form class="sidebar-new" onSubmit={createPlaylist}>
            <input
              class="input"
              placeholder="Playlist name"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              autofocus
            />
          </form>
        </Show>

        <div class="sidebar-playlist-list">
          <For each={playlists.data}>
            {(pl) => (
              <A href={`/playlist/${pl.id}`} class="sidebar-link sidebar-playlist" activeClass="sidebar-link-active">
                <Icon name="list" size={17} />
                <span>{pl.name}</span>
              </A>
            )}
          </For>
          <Show when={playlists.data && playlists.data.length === 0}>
            <p class="sidebar-empty muted">No playlists yet</p>
          </Show>
        </div>
      </div>

      <div class="sidebar-foot">
        <button class="sidebar-account" onClick={() => navigate("/settings")}>
          <span class="sidebar-account-info">
            <span class="sidebar-account-user">{activeUsername()}</span>
            <span class="sidebar-account-server muted">
              {(activeServerUrl() ?? "").replace(/^https?:\/\//, "")}
            </span>
          </span>
        </button>
        <Show when={isAdmin() && uploadEnabled()}>
          <button
            class="icon-btn"
            onClick={props.onUpload}
            aria-label="Upload music"
            title="Upload music"
          >
            <Icon name="upload" size={19} />
          </button>
        </Show>
        <A href="/settings" class="icon-btn" aria-label="Settings" title="Settings">
          <Icon name="settings" size={19} />
        </A>
        <button class="icon-btn" onClick={logout} aria-label="Log out" title="Log out">
          <Icon name="logout" size={19} />
        </button>
      </div>
      </div>
    </nav>
  );
}
