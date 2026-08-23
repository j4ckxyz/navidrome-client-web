// Command palette: one keystroke to reach anything.
//
// For a keyboard-driven library this replaces most navigation — you think of an
// artist and you're there, without going to Search and back. Two kinds of
// result share the list: commands (playback and navigation actions, matched
// locally and always available) and library results (fetched from the server,
// debounced).
//
// Deliberately not a second search page: results are things you *act on*, and
// Enter does the obvious thing to whichever is highlighted.

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { settings, updateSettings } from "~/settings/store";
import { fuzzyScore } from "~/lib/fuzzy";
import { openFullScreen } from "~/features/player/fullscreen";
import { CoverArt } from "~/ui/CoverArt";
import { Icon, type IconName } from "~/ui/Icon";
import type { Album, ArtistSummary, Playlist, Song } from "~/api/types";
import "./commandpalette.css";

const [open, setOpen] = createSignal(false);

export function openCommandPalette(): void {
  setOpen(true);
}
export const commandPaletteOpen = open;

interface Entry {
  id: string;
  label: string;
  sublabel?: string;
  icon?: IconName;
  coverArt?: string;
  group: string;
  run: () => void;
}

// How long to wait after typing stops before asking the server. Commands filter
// instantly regardless, so the palette never feels like it's waiting.
const SEARCH_DEBOUNCE_MS = 180;

export function CommandPalette() {
  const navigate = useNavigate();
  const [term, setTerm] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [results, setResults] = createSignal<{
    artist: ArtistSummary[];
    album: Album[];
    song: Song[];
  }>({ artist: [], album: [], song: [] });
  const [playlists, setPlaylists] = createSignal<Playlist[]>([]);
  let inputEl: HTMLInputElement | undefined;

  function close(): void {
    setOpen(false);
    setTerm("");
    setDebounced("");
    setActive(0);
    setResults({ artist: [], album: [], song: [] });
  }

  // Playlists come from one fetch when the palette opens: they're a short list
  // and the server search doesn't cover them.
  createEffect(
    on(open, (isOpen) => {
      if (!isOpen) return;
      setActive(0);
      queueMicrotask(() => inputEl?.focus());
      const c = client();
      if (!c) return;
      void c
        .getPlaylists()
        .then((pls) => setPlaylists(pls))
        .catch(() => setPlaylists([]));
    }),
  );

  // Debounce the server search.
  createEffect(
    on(term, (value) => {
      const handle = setTimeout(() => setDebounced(value.trim()), SEARCH_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(handle));
    }),
  );

  createEffect(
    on(debounced, (value) => {
      const c = client();
      if (!c || value.length < 2) {
        setResults({ artist: [], album: [], song: [] });
        return;
      }
      let stale = false;
      onCleanup(() => (stale = true));
      void c
        .search(value, { artistCount: 4, albumCount: 4, songCount: 6 })
        .then((r) => {
          if (stale) return; // a newer query has already been issued
          setResults({ artist: r.artist ?? [], album: r.album ?? [], song: r.song ?? [] });
        })
        .catch(() => {
          if (!stale) setResults({ artist: [], album: [], song: [] });
        });
    }),
  );

  const commands = (): Entry[] => [
    { id: "cmd:home", label: "Go to Home", icon: "home", group: "Go", run: () => navigate("/") },
    { id: "cmd:albums", label: "Go to Albums", icon: "disc", group: "Go", run: () => navigate("/albums") },
    { id: "cmd:artists", label: "Go to Artists", icon: "mic", group: "Go", run: () => navigate("/artists") },
    { id: "cmd:genres", label: "Go to Genres", icon: "tag", group: "Go", run: () => navigate("/genres") },
    { id: "cmd:favourites", label: "Go to Favourites", icon: "heart", group: "Go", run: () => navigate("/favourites") },
    { id: "cmd:radio", label: "Go to Radio", icon: "radio", group: "Go", run: () => navigate("/radio") },
    { id: "cmd:history", label: "Go to History", icon: "clock", group: "Go", run: () => navigate("/history") },
    { id: "cmd:stats", label: "Go to Stats", icon: "server", group: "Go", run: () => navigate("/stats") },
    { id: "cmd:recap", label: "Go to Recap", icon: "trending", group: "Go", run: () => navigate("/recap") },
    { id: "cmd:settings", label: "Go to Settings", icon: "settings", group: "Go", run: () => navigate("/settings") },
    {
      id: "cmd:playpause",
      label: player.state.isPlaying ? "Pause" : "Play",
      icon: player.state.isPlaying ? "pause" : "play",
      group: "Playback",
      run: () => player.togglePlay(),
    },
    { id: "cmd:next", label: "Next track", icon: "next", group: "Playback", run: () => player.next() },
    { id: "cmd:prev", label: "Previous track", icon: "prev", group: "Playback", run: () => player.previous() },
    {
      id: "cmd:shuffle",
      label: player.state.shuffle ? "Turn shuffle off" : "Turn shuffle on",
      icon: "shuffle",
      group: "Playback",
      run: () => player.toggleShuffle(),
    },
    {
      id: "cmd:repeat",
      label: "Cycle repeat mode",
      icon: "repeat",
      group: "Playback",
      run: () => player.cycleRepeat(),
    },
    {
      id: "cmd:fullscreen",
      label: "Open full-screen player",
      icon: "chevron-right",
      group: "Playback",
      run: () => openFullScreen(),
    },
    {
      id: "cmd:queue",
      label: settings.layout.showQueuePanel ? "Hide queue" : "Show queue",
      icon: "queue",
      group: "View",
      run: () => updateSettings((s) => (s.layout.showQueuePanel = !s.layout.showQueuePanel)),
    },
    {
      id: "cmd:lyrics",
      label: settings.layout.showLyricsPanel ? "Hide lyrics" : "Show lyrics",
      icon: "lyrics",
      group: "View",
      run: () => updateSettings((s) => (s.layout.showLyricsPanel = !s.layout.showLyricsPanel)),
    },
  ];

  const entries = createMemo<Entry[]>(() => {
    const q = term().trim();
    const out: Entry[] = [];

    // Commands score locally, so they respond on every keystroke.
    const matched = q
      ? commands()
          .map((c) => ({ c, score: fuzzyScore(q, c.label) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 6)
          .map((x) => x.c)
      : commands().slice(0, 6);
    out.push(...matched);

    if (q) {
      const pls = playlists()
        .map((p) => ({ p, score: fuzzyScore(q, p.name) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
      for (const { p } of pls) {
        out.push({
          id: `pl:${p.id}`,
          label: p.name,
          sublabel: `${p.songCount ?? 0} tracks`,
          icon: "list",
          group: "Playlists",
          run: () => navigate(`/playlist/${p.id}`),
        });
      }

      const r = results();
      for (const a of r.artist) {
        out.push({
          id: `ar:${a.id}`,
          label: a.name,
          sublabel: "Artist",
          icon: "mic",
          group: "Library",
          run: () => navigate(`/artist/${a.id}`),
        });
      }
      for (const al of r.album) {
        out.push({
          id: `al:${al.id}`,
          label: al.name,
          sublabel: al.artist,
          coverArt: al.coverArt,
          group: "Library",
          run: () => navigate(`/album/${al.id}`),
        });
      }
      for (const song of r.song) {
        out.push({
          id: `so:${song.id}`,
          label: song.title,
          sublabel: song.artist,
          coverArt: song.coverArt,
          group: "Tracks",
          // Tracks are the one result you'd rather hear than look at.
          run: () => player.playNow([song], 0),
        });
      }
    }
    return out;
  });

  // Keep the highlight in range as results stream in.
  createEffect(
    on(entries, (list) => {
      if (active() >= list.length) setActive(Math.max(0, list.length - 1));
    }),
  );

  function runActive(): void {
    const entry = entries()[active()];
    if (!entry) return;
    close();
    entry.run();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, entries().length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    }
  }

  return (
    <Show when={open()}>
      <div class="cmdk-backdrop" onClick={close}>
        <div
          class="cmdk"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="cmdk-input-row">
            <Icon name="search" size={17} />
            <input
              ref={inputEl}
              class="cmdk-input"
              value={term()}
              placeholder="Search your library, or type a command…"
              aria-label="Search your library, or type a command"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => {
                setTerm(e.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <kbd class="cmdk-esc">Esc</kbd>
          </div>

          <Show
            when={entries().length > 0}
            fallback={
              <div class="cmdk-empty muted">
                {term().trim().length > 0 ? "Nothing matched." : "Start typing."}
              </div>
            }
          >
            <ul class="cmdk-list" role="listbox">
              <For each={entries()}>
                {(entry, i) => (
                  <>
                    {/* A group heading whenever the group changes, so the list
                        stays readable as commands give way to library hits. */}
                    <Show when={i() === 0 || entries()[i() - 1].group !== entry.group}>
                      <li class="cmdk-group" aria-hidden="true">
                        {entry.group}
                      </li>
                    </Show>
                    <li
                      class="cmdk-item"
                      classList={{ "cmdk-item-active": i() === active() }}
                      role="option"
                      aria-selected={i() === active()}
                      onMouseEnter={() => setActive(i())}
                      onClick={runActive}
                    >
                      <Show
                        when={entry.coverArt}
                        fallback={<Icon name={entry.icon ?? "play"} size={16} />}
                      >
                        <CoverArt coverArt={entry.coverArt} size={28} alt="" class="cmdk-cover" />
                      </Show>
                      <span class="cmdk-label">{entry.label}</span>
                      <Show when={entry.sublabel}>
                        <span class="cmdk-sublabel muted">{entry.sublabel}</span>
                      </Show>
                    </li>
                  </>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  );
}
