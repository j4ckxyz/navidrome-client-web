// /song/:id — canonical shareable URL for a single track. Resolves the song and
// forwards to its album page with the track highlighted; if the track has no
// album, falls back to the full-screen player URL.

import { onMount, createSignal, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { client } from "~/auth/session";
import { artistSlug } from "~/features/player/fullscreen";
import { Icon } from "~/ui/Icon";

export default function SongLink() {
  const params = useParams();
  const navigate = useNavigate();
  const [error, setError] = createSignal(false);

  onMount(async () => {
    try {
      const song = await client()!.getSong(params.id ?? "");
      if (song.albumId) {
        navigate(`/album/${song.albumId}?track=${song.id}`, { replace: true });
      } else {
        navigate(`/listen/${artistSlug(song.artist)}/${song.id}`, { replace: true });
      }
    } catch {
      setError(true);
    }
  });

  return (
    <div class="page">
      <Show
        when={error()}
        fallback={
          <div class="center-state">
            <span class="spinner" />
          </div>
        }
      >
        <div class="center-state">
          <Icon name="close" size={28} />
          <p>That track wasn't found on this server.</p>
        </div>
      </Show>
    </div>
  );
}
