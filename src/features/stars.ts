// Star/favourite state. The server is the source of truth (so stars sync across
// clients), but we keep an in-memory override map for instant UI feedback while
// the request and query invalidation settle.
//
// Overrides are deliberately short-lived. An override that outlives its
// invalidation wins forever over the refetched server value, so a favourite
// changed on another device would stay visually wrong here — which would quietly
// defeat the point of keeping the server authoritative.

import { createEffect, createRoot, on } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { client } from "~/auth/session";
import { invalidateStarSensitive } from "~/lib/query";

type Kind = "song" | "album" | "artist";

const [overrides, setOverrides] = createStore<Record<string, boolean>>({});

// How long an override outlives its invalidation. Long enough for the refetch
// to land and repaint, short enough that a change made elsewhere shows up.
const OVERRIDE_TTL_MS = 4_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function release(id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  setOverrides(produce((o) => void delete o[id]));
}

function scheduleRelease(id: string): void {
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  timers.set(
    id,
    setTimeout(() => release(id), OVERRIDE_TTL_MS),
  );
}

// Drop every override. Ids are only meaningful on the server they came from, so
// logging out or switching servers must not carry them across.
export function clearStarOverrides(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  setOverrides(produce((o) => {
    for (const key of Object.keys(o)) delete o[key];
  }));
}

// Changing server (or logging out) invalidates every override: ids only mean
// something on the server they came from, and one server's id could otherwise
// mask another's. Watched here rather than called from session.ts, which would
// make the two modules import each other.
createRoot(() => {
  createEffect(on(client, () => clearStarOverrides(), { defer: true }));
});

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
    // Hand authority back to the server once the refetch has had time to land.
    scheduleRelease(id);
  } catch {
    release(id); // revert to the server value
  }
}
