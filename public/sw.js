// Service worker for the installable app. Strategy:
//   - navigations: network-first with the cached shell as offline fallback
//   - hashed build assets (/assets/*): cache-first (immutable by construction)
//   - cover art (Navidrome getCoverArt + Jellyfin Images): stale-while-revalidate,
//     trimmed so artwork can't grow without bound
//   - everything else (API calls, audio/video streams): straight to the network,
//     never cached
// Bump VERSION to invalidate the shell cache on deploy.

const VERSION = "v1";
const SHELL_CACHE = `nd-shell-${VERSION}`;
const ASSET_CACHE = "nd-assets-v1";
const ART_CACHE = "nd-art-v1";
// Artwork is trimmed by bytes, not entry count: the setting is a megabyte
// budget, and a 4000px cover and a 96px thumbnail are three orders of magnitude
// apart in size, so counting entries told the user nothing useful.
const DEFAULT_ART_BUDGET_BYTES = 150 * 1024 * 1024;
let artBudgetBytes = DEFAULT_ART_BUDGET_BYTES;
// Hashed assets change name every deploy; trim so old builds don't pile up.
const ASSET_LIMIT = 80;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["/", "/manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, ART_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isArtRequest(url) {
  return (
    url.pathname.includes("/rest/getCoverArt") ||
    (url.pathname.includes("/Items/") && url.pathname.includes("/Images/"))
  );
}

function isStreamRequest(url) {
  return (
    url.pathname.includes("/rest/stream") ||
    url.pathname.includes("/rest/download") ||
    url.pathname.includes("/Videos/") ||
    url.pathname.includes("/Audio/")
  );
}

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  // Cache keys come back oldest-first; drop from the front.
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

// Evict oldest-first until the cache fits the byte budget. Reading every entry
// to size it is why this is debounced rather than run on each store.
async function trimCacheBySize(name, budgetBytes) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const sizes = await Promise.all(
    keys.map(async (key) => {
      const res = await cache.match(key);
      if (!res) return 0;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0) return declared;
      // Opaque cross-origin responses report no length; measuring costs a read.
      try {
        return (await res.clone().blob()).size;
      } catch {
        return 0;
      }
    }),
  );
  let total = sizes.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < keys.length && total > budgetBytes; i++) {
    await cache.delete(keys[i]);
    total -= sizes[i];
  }
}

// Sizing the whole cache on every stored image would be pathological during a
// scroll through an album grid, so coalesce into one pass.
let artTrimTimer = null;
function scheduleArtTrim() {
  if (artTrimTimer !== null) return;
  artTrimTimer = setTimeout(() => {
    artTrimTimer = null;
    trimCacheBySize(ART_CACHE, artBudgetBytes);
  }, 10_000);
}

// The app sends the budget on boot and whenever the setting changes. A worker
// can't read localStorage, so this is the only way it learns the value.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "art-budget") return;
  const mb = Number(data.megabytes);
  if (Number.isFinite(mb) && mb > 0) {
    artBudgetBytes = mb * 1024 * 1024;
    scheduleArtTrim();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // App navigation: fresh when online, cached shell when not.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/", { cacheName: SHELL_CACHE }).then((r) => r || Response.error())),
    );
    return;
  }

  // Never intercept media streams or API traffic.
  if (isStreamRequest(url)) return;

  // Hashed build assets: immutable, cache-first.
  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          cache.put(req, res.clone());
          trimCache(ASSET_CACHE, ASSET_LIMIT);
        }
        return res;
      }),
    );
    return;
  }

  // Artwork: serve cached immediately, refresh in the background.
  if (isArtRequest(url)) {
    event.respondWith(
      caches.open(ART_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        // A tagged URL names one specific image revision, so a hit can never be
        // stale — skip the background refetch entirely.
        if (hit && url.searchParams.has("tag")) return hit;
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok || res.type === "opaque") {
              cache.put(req, res.clone());
              scheduleArtTrim();
            }
            return res;
          })
          .catch(() => hit || Response.error());
        return hit || refresh;
      }),
    );
  }
});
