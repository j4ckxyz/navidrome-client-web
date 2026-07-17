// /listen/:artist/:id[/visualiser] — the full-screen player as a real URL.
// Landing here (pasted link, refresh, back button) loads the song, starts it,
// and opens the full-screen view in the right display mode. The page itself
// renders nothing; the FullScreenPlayer overlay is the UI.

import { onMount } from "solid-js";
import { useParams } from "@solidjs/router";
import { client } from "~/auth/session";
import { player } from "~/player/store";
import { openFullScreen } from "~/features/player/fullscreen";
import { openVisualizer } from "~/features/visualizer/state";

export default function Listen() {
  const params = useParams();

  onMount(async () => {
    const id = params.id;
    if (id && player.current()?.id !== id) {
      try {
        const song = await client()!.getSong(id);
        // Autoplay needs a user gesture; if the browser blocks it the queue is
        // still loaded and the play button starts it.
        player.playNow([song]);
      } catch {
        // Unknown/foreign id: still open the player on whatever is queued.
      }
    }
    if (params.view === "visualiser") openVisualizer();
    else openFullScreen();
  });

  return <div class="page" aria-hidden="true" />;
}
