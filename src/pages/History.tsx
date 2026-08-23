// Listening history: every track played here, newest first, grouped by day.

import { createMemo, createSignal, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import {
  clearHistory,
  historyEntries,
  topFromHistory,
  type HistoryEntry,
} from "~/features/history/history";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { formatDuration } from "~/lib/format";
import type { Song } from "~/api/types";
import "./history.css";

const DAY_MS = 86_400_000;
const RANGES = [
  { id: "7", label: "Last 7 days", ms: 7 * DAY_MS },
  { id: "30", label: "Last 30 days", ms: 30 * DAY_MS },
  { id: "all", label: "All time", ms: Number.MAX_SAFE_INTEGER },
] as const;

// The log stores only what's needed to display and replay a track, so entries
// have to be widened back into Songs to hand to the player.
function toSong(entry: HistoryEntry): Song {
  return {
    id: entry.id,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    albumId: entry.albumId,
    artistId: entry.artistId,
    coverArt: entry.coverArt,
    duration: entry.duration ?? 0,
  } as Song;
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (timestamp >= startOfToday) return "Today";
  if (timestamp >= startOfToday - DAY_MS) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function History() {
  const [range, setRange] = createSignal<(typeof RANGES)[number]["id"]>("7");
  const [confirmClear, setConfirmClear] = createSignal(false);

  const windowMs = () => RANGES.find((r) => r.id === range())!.ms;

  const visible = createMemo(() => {
    const cutoff = Date.now() - windowMs();
    return historyEntries().filter((e) => e.playedAt >= cutoff);
  });

  // Newest-first entries grouped into consecutive days.
  const days = createMemo(() => {
    const groups: { label: string; entries: HistoryEntry[] }[] = [];
    for (const entry of visible()) {
      const label = dayLabel(entry.playedAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.entries.push(entry);
      else groups.push({ label, entries: [entry] });
    }
    return groups;
  });

  const top = createMemo(() => topFromHistory(windowMs(), 5));

  function playFrom(entry: HistoryEntry): void {
    // Play the run of tracks from here forward in time, so pressing play on
    // something from last night replays that evening rather than one track.
    const list = visible();
    const start = list.indexOf(entry);
    if (start < 0) return;
    const forward = list.slice(0, start + 1).reverse().map(toSong);
    player.playNow(forward, forward.length - 1);
  }

  return (
    <div class="page history-page">
      <header class="page-head history-head">
        <div>
          <h1>Listening history</h1>
          <p class="muted history-sub">
            Everything played in this browser, newest first. Stored on this device only.
          </p>
        </div>
        <div class="history-actions">
          <div class="history-ranges" role="group" aria-label="Time range">
            <For each={RANGES}>
              {(r) => (
                <button
                  class="btn btn-ghost"
                  classList={{ "history-range-active": range() === r.id }}
                  onClick={() => setRange(r.id)}
                >
                  {r.label}
                </button>
              )}
            </For>
          </div>
          <Show when={historyEntries().length > 0}>
            <Show
              when={confirmClear()}
              fallback={
                <button class="btn btn-ghost" onClick={() => setConfirmClear(true)}>
                  Clear
                </button>
              }
            >
              <button
                class="btn btn-danger"
                onClick={() => {
                  clearHistory();
                  setConfirmClear(false);
                }}
              >
                Delete all history
              </button>
              <button class="btn btn-ghost" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </Show>
          </Show>
        </div>
      </header>

      <Show
        when={visible().length > 0}
        fallback={
          <div class="center-state">
            <Icon name="clock" size={30} />
            <p>
              {historyEntries().length === 0
                ? "Nothing played yet. Your history builds as you listen."
                : "Nothing in this range."}
            </p>
          </div>
        }
      >
        <Show when={top().length > 1}>
          <section class="history-top">
            <h2 class="history-section-title">Most played</h2>
            <div class="history-top-list">
              <For each={top()}>
                {({ entry, plays }) => (
                  <button class="history-top-item" onClick={() => player.playNow([toSong(entry)], 0)}>
                    <CoverArt coverArt={entry.coverArt} size={44} alt="" class="history-cover" />
                    <span class="history-top-meta">
                      <span class="history-top-title">{entry.title}</span>
                      <span class="muted">{entry.artist}</span>
                    </span>
                    <span class="history-plays muted">{plays}×</span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>

        <For each={days()}>
          {(day) => (
            <section class="history-day">
              <h2 class="history-section-title">
                {day.label}
                <span class="muted history-day-count"> · {day.entries.length} tracks</span>
              </h2>
              <div class="history-list">
                <For each={day.entries}>
                  {(entry) => (
                    <div class="history-row" onDblClick={() => playFrom(entry)}>
                      <span class="history-time muted">{timeLabel(entry.playedAt)}</span>
                      <button
                        class="history-play"
                        onClick={() => playFrom(entry)}
                        aria-label={`Play ${entry.title}`}
                      >
                        <Icon name="play" size={14} />
                      </button>
                      <CoverArt coverArt={entry.coverArt} size={36} alt="" class="history-cover" />
                      <span class="history-meta">
                        <span class="history-title">{entry.title}</span>
                        <Show when={entry.artistId} fallback={<span class="muted">{entry.artist}</span>}>
                          <A href={`/artist/${entry.artistId}`} class="muted history-link">
                            {entry.artist}
                          </A>
                        </Show>
                      </span>
                      <Show when={entry.albumId}>
                        <A href={`/album/${entry.albumId}`} class="muted history-album">
                          {entry.album}
                        </A>
                      </Show>
                      <span class="muted history-dur">{formatDuration(entry.duration ?? 0)}</span>
                      <button
                        class="icon-btn history-queue"
                        onClick={() => player.addToQueue([toSong(entry)])}
                        aria-label="Add to queue"
                        title="Add to queue"
                        disabled={!client()}
                      >
                        <Icon name="queue" size={15} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}
