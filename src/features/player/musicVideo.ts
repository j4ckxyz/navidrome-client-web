// Music-video matching state. When a Jellyfin server is linked, every track
// change quietly checks whether Jellyfin has a music video for the song; when
// it does, the player UI offers a "watch video" switch that opens the overlay.

import { createMemo, createResource, createRoot, createSignal } from "solid-js";
import { findMusicVideo, jellyfin, type JellyfinItem } from "~/api/jellyfinExtras";
import { player } from "~/player/store";

const [videoOpen, setVideoOpen] = createSignal(false);
// A video opened explicitly (e.g. from search results) rather than matched to
// the current song. Takes precedence in the overlay while set.
const [explicitVideo, setExplicitVideo] = createSignal<JellyfinItem | null>(null);
// Whether music was playing when the video opened, so closing can resume it.
let resumeMusicOnClose = false;

export { videoOpen };

// Open the overlay — with a specific video, or the one matched to the current
// song when called without arguments.
export function openMusicVideo(item?: JellyfinItem): void {
  setExplicitVideo(item ?? null);
  resumeMusicOnClose = player.state.isPlaying;
  if (player.state.isPlaying) player.togglePlay();
  setVideoOpen(true);
}

export function closeMusicVideo(): void {
  setVideoOpen(false);
  setExplicitVideo(null);
  if (resumeMusicOnClose) {
    resumeMusicOnClose = false;
    if (!player.state.isPlaying) player.togglePlay();
  }
}

// What the overlay should play: an explicitly chosen video wins, otherwise the
// match for the current song.
export function activeMusicVideo(): JellyfinItem | null | undefined {
  return explicitVideo() ?? currentMusicVideo();
}

export const currentMusicVideo: () => JellyfinItem | null | undefined = createRoot(() => {
  const key = createMemo(() => {
    const s = player.current();
    if (!s || s.isRadio || !jellyfin()) return null;
    return { title: s.title, artist: s.artist ?? "" };
  });
  const [video] = createResource(key, async ({ title, artist }) => {
    try {
      return await findMusicVideo(title, artist);
    } catch {
      return null;
    }
  });
  // undefined while loading / when nothing playing; null when no match.
  return () => (key() ? video() : null);
});
