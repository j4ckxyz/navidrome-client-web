// Star/favourite state. The server is the source of truth (so stars sync across
// clients), but we keep an in-memory override map for instant UI feedback while
// the request and query invalidation settle.

import { createStore } from "solid-js/store";
import { client } from "~/auth/session";
import { invalidateStarSensitive } from "~/lib/query";

type Kind = "song" | "album" | "artist";

const [overrides, setOverrides] = createStore<Record<string, boolean>>({});

// Resolve effective starred state: an override wins over the server value.
export function isStarred(id: string, serverStarred: string | boolean | undefined): boolean {
  if (id in overrides) return overrides[id];
  return Boolean(serverStarred);
}

export async function toggleStar(
  id: string,
  serverStarred: string | boolean | undefined,
  kind: Kind = "song",
): Promise<void> {
  const c = client();
  if (!c) return;
  const currentlyStarred = isStarred(id, serverStarred);
  const nextStarred = !currentlyStarred;
  setOverrides(id, nextStarred); // optimistic
  try {
    if (nextStarred) await c.star(id, kind);
    else await c.unstar(id, kind);
    invalidateStarSensitive();
  } catch {
    setOverrides(id, currentlyStarred); // revert on failure
  }
}
