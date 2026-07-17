// Full-screen music-video playback, streamed from the linked Jellyfin server.
// Opening pauses the music; closing resumes it if it was playing. The song's
// audio and the video are separate streams — this is a "switch to the video"
// experience, not synchronized playback.

import { createMemo, onCleanup, onMount, Show } from "solid-js";
import { jellyfinVideoUrl } from "~/api/jellyfinExtras";
import { player } from "~/player/store";
import { Icon } from "~/ui/Icon";
import { activeMusicVideo, closeMusicVideo } from "./musicVideo";
import "./musicvideo.css";

export function MusicVideoOverlay() {
  const video = createMemo(() => activeMusicVideo());
  const song = createMemo(() => player.current());

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMusicVideo();
    }
  }

  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="mv-overlay" role="dialog" aria-label="Music video">
      <header class="mv-top">
        <div class="mv-meta">
          <span class="mv-title">{video()?.Name ?? song()?.title}</span>
          <span class="mv-artist muted">
            {video()?.Artists?.join(", ") || song()?.artist || ""}
          </span>
        </div>
        <button class="icon-btn mv-close" onClick={closeMusicVideo} aria-label="Close video">
          <Icon name="close" size={22} />
        </button>
      </header>
      <Show when={video()}>
        {(v) => (
          <video
            class="mv-video"
            src={jellyfinVideoUrl(v().Id)}
            controls
            autoplay
            playsinline
            onError={() => {
              /* leave the overlay up; the element shows its own error UI */
            }}
          />
        )}
      </Show>
    </div>
  );
}
