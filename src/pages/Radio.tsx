// Live radio, sourced from a linked Jellyfin server's Live TV channels (m3u
// tuners). Channels play through the normal player as endless streams — no
// seek, no scrobble. Without a Jellyfin connection this page explains how to
// set one up.

import { A } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import type { Song } from "~/api/types";
import {
  jellyfin,
  getLiveTvChannels,
  getChannelStreamUrl,
  jellyfinImageUrl,
  type JellyfinItem,
} from "~/api/jellyfinExtras";
import { player } from "~/player/store";
import { qk } from "~/lib/query";
import { AsyncState } from "~/ui/AsyncState";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import "./radio.css";

// A channel wrapped as a queue entry the player understands.
async function channelToSong(ch: JellyfinItem): Promise<Song> {
  const streamUrl = await getChannelStreamUrl(ch.Id);
  return {
    id: `jf-radio:${ch.Id}`,
    title: ch.Name,
    artist: ch.CurrentProgram?.Name || "Live radio",
    duration: 0,
    suffix: "mp3",
    streamUrl,
    isRadio: true,
    artworkUrl: jellyfinImageUrl(ch, 600) ?? undefined,
  };
}

export default function Radio() {
  const channels = createQuery(() => ({
    queryKey: qk.jellyfinChannels(),
    queryFn: getLiveTvChannels,
    enabled: !!jellyfin(),
  }));

  // Channel currently being resolved, so the tile can show a spinner state.
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function play(ch: JellyfinItem) {
    setError(null);
    setPendingId(ch.Id);
    try {
      const song = await channelToSong(ch);
      player.playNow([song]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the stream");
    } finally {
      setPendingId(null);
    }
  }

  const playingId = () => {
    const cur = player.current();
    return cur?.isRadio ? cur.id.replace(/^jf-radio:/, "") : null;
  };

  // Radio-typed channels first, then everything else — m3u playlists often mark
  // radio stations as "TV", so we show all of them rather than filtering.
  const sorted = () =>
    [...(channels.data ?? [])].sort((a, b) => {
      const ra = a.ChannelType === "Radio" ? 0 : 1;
      const rb = b.ChannelType === "Radio" ? 0 : 1;
      return ra - rb || a.Name.localeCompare(b.Name);
    });

  return (
    <div class="page radio-page">
      <h1 class="page-title">Radio</h1>

      <Show
        when={jellyfin()}
        fallback={
          <div class="radio-connect">
            <Icon name="radio" size={40} />
            <h2>Connect Jellyfin to listen to live radio</h2>
            <p class="muted">
              Radio stations come from a Jellyfin server's Live TV channels (m3u tuners).
              Sign in to Jellyfin — or link an account alongside Navidrome — and they'll
              show up here.
            </p>
            <A href="/settings?tab=connections" class="btn btn-primary">
              <Icon name="link" size={16} /> Connect Jellyfin
            </A>
          </div>
        }
      >
        <AsyncState
          loading={channels.isPending}
          error={channels.error}
          isEmpty={channels.data?.length === 0}
          emptyMessage="No Live TV channels found on your Jellyfin server. Add an m3u tuner in Jellyfin's Live TV settings."
        >
          <Show when={error()}>
            <p class="radio-error">{error()}</p>
          </Show>
          <div class="radio-grid">
            <For each={sorted()}>
              {(ch) => (
                <button
                  class="radio-tile"
                  classList={{
                    "radio-tile-playing": playingId() === ch.Id,
                    "radio-tile-pending": pendingId() === ch.Id,
                  }}
                  onClick={() => play(ch)}
                  aria-label={`Play ${ch.Name}`}
                >
                  <div class="radio-art">
                    <CoverArt src={jellyfinImageUrl(ch, 400) ?? undefined} alt="" />
                    <span class="radio-play-badge">
                      <Icon
                        name={playingId() === ch.Id && player.state.isPlaying ? "pause" : "play"}
                        size={22}
                      />
                    </span>
                    <Show when={playingId() === ch.Id && player.state.isPlaying}>
                      <span class="radio-live-dot" aria-hidden="true" />
                    </Show>
                  </div>
                  <span class="radio-name">{ch.Name}</span>
                  <span class="radio-sub muted">
                    {ch.CurrentProgram?.Name ??
                      (ch.ChannelType === "Radio" ? "Radio" : "Live")}
                  </span>
                </button>
              )}
            </For>
          </div>
        </AsyncState>
      </Show>
    </div>
  );
}
