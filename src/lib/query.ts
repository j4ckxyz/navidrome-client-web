// Shared QueryClient + query-key helpers. All server state flows through
// TanStack Query so caching, dedup, and background refresh are consistent, and
// mutations (star, playlist edits) invalidate the right keys to keep other
// clients in sync on next fetch.

import { QueryClient } from "@tanstack/solid-query";
import { settings } from "~/settings/store";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      get staleTime() {
        return settings.power.polling.libraryStaleMs;
      },
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const qk = {
  artists: () => ["artists"] as const,
  artist: (id: string) => ["artist", id] as const,
  artistInfo: (id: string) => ["artistInfo", id] as const,
  album: (id: string) => ["album", id] as const,
  albumList: (type: string, opts?: unknown) => ["albumList", type, opts] as const,
  genres: () => ["genres"] as const,
  songsByGenre: (genre: string) => ["songsByGenre", genre] as const,
  starred: () => ["starred"] as const,
  playlists: () => ["playlists"] as const,
  playlist: (id: string) => ["playlist", id] as const,
  search: (q: string) => ["search", q] as const,
  lyrics: (id: string) => ["lyrics", id] as const,
  randomSongs: () => ["randomSongs"] as const,
};

// Invalidate everything that can reflect a star/unstar.
export function invalidateStarSensitive(): void {
  queryClient.invalidateQueries({ queryKey: ["starred"] });
  queryClient.invalidateQueries({ queryKey: ["album"] });
  queryClient.invalidateQueries({ queryKey: ["artist"] });
  queryClient.invalidateQueries({ queryKey: ["playlist"] });
  queryClient.invalidateQueries({ queryKey: ["albumList"] });
  queryClient.invalidateQueries({ queryKey: ["search"] });
}
