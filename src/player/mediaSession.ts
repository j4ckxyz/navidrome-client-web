// Media Session integration: lock-screen / notification transport controls and
// hardware media keys, essential once the app is installed on a phone. Mirrors
// the player store into navigator.mediaSession and routes the platform's
// play/pause/next/seek actions back into it.

import { createEffect, createRoot } from "solid-js";
import { client } from "~/auth/session";
import { player } from "./store";

export function installMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;

  createRoot(() => {
    // Metadata follows the current track.
    createEffect(() => {
      const song = player.current();
      if (!song) {
        ms.metadata = null;
        return;
      }
      const c = client();
      const artwork: MediaImage[] = [];
      if (song.artworkUrl) {
        artwork.push({ src: song.artworkUrl });
      } else if (c && song.coverArt) {
        for (const size of [96, 256, 512]) {
          artwork.push({
            src: c.coverArtUrl(song.coverArt, size),
            sizes: `${size}x${size}`,
          });
        }
      }
      ms.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist ?? "",
        album: song.isRadio ? "Live radio" : song.album ?? "",
        artwork,
      });
    });

    createEffect(() => {
      ms.playbackState = player.state.isPlaying ? "playing" : "paused";
    });

    // Position state lets the lock screen draw a live progress bar. Radio
    // streams have no duration, so skip them.
    createEffect(() => {
      const { duration, currentTime, isPlaying } = player.state;
      if (!("setPositionState" in ms)) return;
      try {
        if (duration > 0 && currentTime <= duration) {
          ms.setPositionState({
            duration,
            position: currentTime,
            playbackRate: isPlaying ? 1 : 0,
          });
        } else {
          ms.setPositionState();
        }
      } catch {
        // some browsers reject transiently inconsistent values — harmless
      }
    });
  });

  const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
    ["play", () => player.togglePlay()],
    ["pause", () => player.togglePlay()],
    ["previoustrack", () => player.previous()],
    ["nexttrack", () => player.next()],
    ["seekbackward", (d) => player.seekBy(-(d.seekOffset ?? 10))],
    ["seekforward", (d) => player.seekBy(d.seekOffset ?? 10)],
    ["seekto", (d) => {
      if (d.seekTime !== undefined) player.seek(d.seekTime);
    }],
    ["stop", () => player.stop()],
  ];
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // action unsupported on this platform
    }
  }
}
