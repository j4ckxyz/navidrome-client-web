// Bun/Hono backend for navidrome-client-web.
//
// When NAVIDROME_URL is set (e.g. http://navidrome:4533), this server acts as
// a transparent proxy for all Navidrome REST + auth endpoints. The browser
// always talks to the same origin as the app, so no CORS configuration is
// needed on the Navidrome side.
//
// When NAVIDROME_URL is not set, the proxy routes return 503 and the frontend
// falls back to prompting the user for their Navidrome server URL (direct mode).
//
// When MUSIC_DIR is set, admin users can upload audio files and ZIP archives
// via POST /upload. Files are written to MUSIC_DIR and a library scan is
// triggered automatically.

import { Hono, type Context } from "hono";
import {
  mkdirSync, readdirSync, statSync, renameSync,
  copyFileSync, unlinkSync, existsSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { unzipSync, Zip, ZipPassThrough } from "fflate";
import { parseBuffer, parseFile } from "music-metadata";

const NAVIDROME_URL = (process.env.NAVIDROME_URL ?? "").replace(/\/+$/, "");
const PORT = +(process.env.PORT ?? 8080);
const DIST = (process.env.DIST_DIR ?? "./dist").replace(/\/+$/, "");
const MUSIC_DIR = (process.env.MUSIC_DIR ?? "").replace(/\/+$/, "");

// Link previews: when a read-only Navidrome account is configured here, the
// server can fetch titles + cover art on behalf of anonymous link-preview
// crawlers (Twitter, Discord, Slack, Bluesky, Facebook…). Humans still hit the
// login-gated SPA. Requires NAVIDROME_URL (proxy mode) — same config surface as
// uploads, off until you set it.
const OG_USER = process.env.NAVIDROME_OG_USER ?? "";
const OG_PASS = process.env.NAVIDROME_OG_PASS ?? "";
const SUBSONIC_VERSION = "1.16.1";
const SUBSONIC_CLIENT = "navidrome-web";
const linkPreviewsEnabled = !!(NAVIDROME_URL && OG_USER && OG_PASS);

const AUDIO_EXTS = new Set([
  "mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "wv", "ape",
  "mpc", "wma", "aiff", "aif", "dsf", "dff",
]);

function isAudioFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.has(ext);
}

// Resolve a relative path inside a base directory and reject path traversal.
function safeJoin(base: string, rel: string): string {
  const resolved = resolve(join(base, rel));
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

// ---- Tag-driven album organisation -----------------------------------------
//
// Navidrome groups tracks into albums by their *tags*, not their folders, which
// is why an album can show up correctly even while its files are dumped loose in
// the media root. We read the same tags here so uploads (and the cleanup
// backfill) can mirror that grouping on disk: one "Artist - Album" folder per
// album, files inside.

interface TrackTags {
  artist: string | null;
  album: string | null;
}

const UNKNOWN_ARTIST = "Unknown Artist";
const UNKNOWN_ALBUM = "Unknown Album";

// Prefer album-artist so compilations and "feat." tracks still collapse into a
// single album folder — the same way Navidrome groups them.
function tagsFrom(meta: { common?: any }): TrackTags {
  const c = meta.common ?? {};
  const artistRaw =
    c.albumartist || c.artist || (Array.isArray(c.artists) ? c.artists[0] : null) || null;
  const albumRaw = c.album || null;
  const clean = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return { artist: clean(artistRaw), album: clean(albumRaw) };
}

// Read only what we need; skip cover art and duration scanning for speed.
const TAG_OPTS = { duration: false, skipCovers: true } as const;

async function readTagsBuffer(buf: Uint8Array, filename: string): Promise<TrackTags> {
  try {
    return tagsFrom(await parseBuffer(buf, { path: filename }, TAG_OPTS));
  } catch {
    return { artist: null, album: null };
  }
}

async function readTagsFile(path: string): Promise<TrackTags> {
  try {
    return tagsFrom(await parseFile(path, TAG_OPTS));
  } catch {
    return { artist: null, album: null };
  }
}

// Make a string safe to use as a single cross-platform path segment.
function sanitizeSegment(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, " ") // illegal + control chars
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "") // no leading/trailing dots or spaces
    .slice(0, 120)
    .trim();
}

// "Artist - Album" folder name derived from tags, with safe fallbacks.
function albumFolder(tags: TrackTags): string {
  const artist = sanitizeSegment(tags.artist ?? "") || UNKNOWN_ARTIST;
  const album = sanitizeSegment(tags.album ?? "") || UNKNOWN_ALBUM;
  return `${artist} - ${album}`;
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

// Sanitize a path from a ZIP entry: strip leading slashes, drop MacOS junk.
function sanitizeZipEntry(entry: string): string | null {
  const parts = entry.split("/");
  if (parts.some((p) => p === "__MACOSX" || (p.startsWith(".") && p !== "."))) return null;
  return parts.filter(Boolean).join("/");
}

const app = new Hono();

// ---- Config ----------------------------------------------------------------

app.get("/api/config", (c) =>
  c.json({
    proxyMode: !!NAVIDROME_URL,
    uploadEnabled: !!(NAVIDROME_URL && MUSIC_DIR),
    linkPreviews: linkPreviewsEnabled,
    version: "1.0.0",
  }),
);

// ---- Admin verification ----------------------------------------------------

async function verifyAdmin(opts: {
  jwt?: string;
  subUser?: string;
  subToken?: string;
  subSalt?: string;
}): Promise<boolean> {
  if (!NAVIDROME_URL) return false;

  // JWT path: GET /api/user requires admin.
  if (opts.jwt) {
    try {
      const res = await fetch(`${NAVIDROME_URL}/api/user?_end=1&_start=0`, {
        headers: { "x-nd-authorization": opts.jwt },
      });
      if (res.ok) return true;
    } catch {
      // fall through to Subsonic check
    }
  }

  // Subsonic path: getUser.view returns adminRole for the authenticated user.
  if (opts.subUser && opts.subToken && opts.subSalt) {
    try {
      const params = new URLSearchParams({
        u: opts.subUser,
        t: opts.subToken,
        s: opts.subSalt,
        v: "1.16.1",
        c: "navidrome-web",
        f: "json",
        username: opts.subUser,
      });
      const res = await fetch(`${NAVIDROME_URL}/rest/getUser.view?${params}`);
      if (!res.ok) return false;
      const body = await res.json() as any;
      return body["subsonic-response"]?.user?.adminRole === true;
    } catch {
      return false;
    }
  }

  return false;
}

interface AuthHeaders {
  jwt?: string;
  subUser?: string;
  subToken?: string;
  subSalt?: string;
}

function authHeadersFrom(c: Context): AuthHeaders {
  return {
    jwt: c.req.header("x-nd-authorization"),
    subUser: c.req.header("x-nd-subsonic-u"),
    subToken: c.req.header("x-nd-subsonic-t"),
    subSalt: c.req.header("x-nd-subsonic-s"),
  };
}

// Kick off a Navidrome library scan so newly written/moved files appear.
// Non-fatal: a manual scan still works if this fails.
async function triggerScan(h: AuthHeaders): Promise<boolean> {
  try {
    if (h.subUser && h.subToken && h.subSalt) {
      const params = new URLSearchParams({
        u: h.subUser, t: h.subToken, s: h.subSalt,
        v: "1.16.1", c: "navidrome-web", f: "json",
      });
      const res = await fetch(`${NAVIDROME_URL}/rest/startScan.view?${params}`);
      return res.ok;
    } else if (h.jwt) {
      const res = await fetch(`${NAVIDROME_URL}/api/scanner`, {
        method: "PUT",
        headers: { "x-nd-authorization": h.jwt, "Content-Type": "application/json" },
        body: JSON.stringify({ fullRescan: false }),
      });
      return res.ok;
    }
  } catch {
    // swallow — non-fatal
  }
  return false;
}

// ---- Upload ----------------------------------------------------------------

app.post("/upload", async (c) => {
  if (!MUSIC_DIR || !NAVIDROME_URL) {
    return c.json({ error: "Upload not configured (set MUSIC_DIR and NAVIDROME_URL)" }, 503);
  }

  const auth = authHeadersFrom(c);
  if (!(await verifyAdmin(auth))) {
    return c.json({ error: "Admin access required" }, 403);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Could not parse upload" }, 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  const written: string[] = [];

  // Place an audio file into its tag-derived "Artist - Album" folder. The
  // original folder structure (webkitRelativePath / ZIP paths) is intentionally
  // ignored — grouping comes from tags so loose files and flat archives still
  // land in tidy album folders.
  async function place(data: Uint8Array, name: string) {
    const tags = await readTagsBuffer(data, name);
    const rel = `${albumFolder(tags)}/${baseName(name)}`;
    let dest: string;
    try {
      dest = safeJoin(MUSIC_DIR, rel);
    } catch {
      return; // path traversal — skip
    }
    mkdirSync(dirname(dest), { recursive: true });
    await Bun.write(dest, data);
    written.push(rel);
  }

  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "zip") {
      let unzipped: Record<string, Uint8Array>;
      try {
        unzipped = unzipSync(buf);
      } catch {
        return c.json({ error: "Invalid or corrupt ZIP file" }, 400);
      }

      for (const [entryPath, data] of Object.entries(unzipped)) {
        const clean = sanitizeZipEntry(entryPath);
        if (!clean || !isAudioFile(clean)) continue;
        await place(data, clean);
      }
    } else if (isAudioFile(file.name)) {
      await place(buf, file.name);
    } else {
      return c.json({ error: "Unsupported file type. Upload audio files or a ZIP archive." }, 400);
    }
  } catch (err) {
    console.error("Upload error:", err);
    return c.json({ error: "Failed to write file to music directory" }, 500);
  }

  // Trigger a library scan so the new files appear in Navidrome.
  const scanStarted = written.length > 0 ? await triggerScan(auth) : false;

  return c.json({ written, scanStarted });
});

// ---- Cleanup / backfill ----------------------------------------------------
//
// "Organize" pass for libraries where files were dumped loose in the media root
// (e.g. older single-file uploads). Scans only the *top level* of MUSIC_DIR:
// existing subfolders are treated as already-organised albums and left alone.
// /cleanup/scan returns the proposed grouping for confirmation; /cleanup/apply
// re-derives the same grouping server-side and moves only the confirmed albums.

interface CleanupFile {
  name: string;
  size: number;
  hasTags: boolean;
}
interface CleanupGroup {
  folder: string;
  artist: string;
  album: string;
  hasTags: boolean;
  files: CleanupFile[];
}

// Group loose top-level audio files by their tag-derived album folder.
async function scanLooseFiles(): Promise<CleanupGroup[]> {
  const entries = readdirSync(MUSIC_DIR, { withFileTypes: true });
  const groups = new Map<string, CleanupGroup>();

  for (const ent of entries) {
    if (!ent.isFile() || !isAudioFile(ent.name)) continue; // skip album folders
    const full = join(MUSIC_DIR, ent.name);
    const tags = await readTagsFile(full);
    const folder = albumFolder(tags);
    const hasTags = !!(tags.artist || tags.album);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      // unreadable — still report it
    }

    let g = groups.get(folder);
    if (!g) {
      g = {
        folder,
        artist: tags.artist ?? UNKNOWN_ARTIST,
        album: tags.album ?? UNKNOWN_ALBUM,
        hasTags,
        files: [],
      };
      groups.set(folder, g);
    }
    g.files.push({ name: ent.name, size, hasTags });
  }

  return [...groups.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

app.post("/cleanup/scan", async (c) => {
  if (!MUSIC_DIR || !NAVIDROME_URL) {
    return c.json({ error: "Upload not configured (set MUSIC_DIR and NAVIDROME_URL)" }, 503);
  }
  const auth = authHeadersFrom(c);
  if (!(await verifyAdmin(auth))) {
    return c.json({ error: "Admin access required" }, 403);
  }

  let groups: CleanupGroup[];
  try {
    groups = await scanLooseFiles();
  } catch (err) {
    console.error("Cleanup scan error:", err);
    return c.json({ error: "Could not read music directory" }, 500);
  }

  const totalFiles = groups.reduce((n, g) => n + g.files.length, 0);
  return c.json({ groups, totalFiles });
});

app.post("/cleanup/apply", async (c) => {
  if (!MUSIC_DIR || !NAVIDROME_URL) {
    return c.json({ error: "Upload not configured (set MUSIC_DIR and NAVIDROME_URL)" }, 503);
  }
  const auth = authHeadersFrom(c);
  if (!(await verifyAdmin(auth))) {
    return c.json({ error: "Admin access required" }, 403);
  }

  let body: { folders?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }
  const selected = new Set(
    Array.isArray(body.folders) ? body.folders.filter((f): f is string => typeof f === "string") : [],
  );
  if (selected.size === 0) {
    return c.json({ error: "No albums selected" }, 400);
  }

  let entries;
  try {
    entries = readdirSync(MUSIC_DIR, { withFileTypes: true });
  } catch {
    return c.json({ error: "Could not read music directory" }, 500);
  }

  const moved: string[] = [];
  const errors: { file: string; error: string }[] = [];

  for (const ent of entries) {
    if (!ent.isFile() || !isAudioFile(ent.name)) continue;
    const src = join(MUSIC_DIR, ent.name);
    // Re-derive the folder from tags rather than trusting the client, so we only
    // ever move files into a grouping the server itself computed.
    const tags = await readTagsFile(src);
    const folder = albumFolder(tags);
    if (!selected.has(folder)) continue;

    const rel = `${folder}/${baseName(ent.name)}`;
    let dest: string;
    try {
      dest = safeJoin(MUSIC_DIR, rel);
    } catch {
      errors.push({ file: ent.name, error: "Invalid path" });
      continue;
    }
    if (existsSync(dest)) {
      errors.push({ file: ent.name, error: "Target already exists" });
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      try {
        renameSync(src, dest);
      } catch {
        // Cross-device (different mount): fall back to copy + delete.
        copyFileSync(src, dest);
        unlinkSync(src);
      }
      moved.push(rel);
    } catch (err) {
      console.error("Cleanup move error:", ent.name, err);
      errors.push({ file: ent.name, error: "Move failed" });
    }
  }

  const scanStarted = moved.length > 0 ? await triggerScan(auth) : false;
  return c.json({ moved, errors, scanStarted });
});

// ---- Transcoded ZIP download -----------------------------------------------
//
// Streams a ZIP of an album/playlist transcoded to a lossy format. Each track is
// pulled from Navidrome's transcoder (stream.view) using the *caller's* own
// Subsonic credentials (sent in the form payload), then stored — not recompressed
// — into a streaming ZIP. The browser posts a hidden form so the response
// downloads straight to disk. Only works in proxy mode.

interface ZipRequest {
  zipName?: string;
  format?: string;
  bitRate?: number;
  tracks?: { id: string; name: string }[];
  u?: string;
  t?: string;
  s?: string;
}

function contentDisposition(filename: string): string {
  // ASCII fallback + RFC 5987 UTF-8 name so non-Latin titles survive.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

app.post("/download/zip", async (c) => {
  if (!NAVIDROME_URL) {
    return c.json({ error: "Transcoded downloads require proxy mode (set NAVIDROME_URL)" }, 503);
  }

  let req: ZipRequest;
  try {
    const form = await c.req.formData();
    req = JSON.parse((form.get("payload") as string) ?? "{}");
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }

  const { u, t, s, format, bitRate } = req;
  const tracks = req.tracks ?? [];
  if (!u || !t || !s || tracks.length === 0 || !format) {
    return c.json({ error: "Missing credentials or tracks" }, 400);
  }

  const zipName = (req.zipName || "download.zip").replace(/[/\\]/g, "_");

  const streamUrl = (id: string) => {
    const p = new URLSearchParams({
      u, t, s, v: SUBSONIC_VERSION, c: SUBSONIC_CLIENT, id, format,
    });
    if (bitRate) p.set("maxBitRate", String(bitRate));
    return `${NAVIDROME_URL}/rest/stream.view?${p.toString()}`;
  };

  // Bridge fflate's streaming ZIP into a web ReadableStream.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          controller.error(err);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });

      (async () => {
        const used = new Set<string>();
        for (const track of tracks) {
          let name = track.name || `${track.id}.${format}`;
          while (used.has(name.toLowerCase())) name = `_${name}`;
          used.add(name.toLowerCase());

          let res: Response;
          try {
            res = await fetch(streamUrl(track.id));
          } catch {
            continue; // skip unreachable track, keep building the archive
          }
          if (!res.ok || !res.body) continue;

          const entry = new ZipPassThrough(name);
          zip.add(entry);
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) entry.push(value);
          }
          entry.push(new Uint8Array(0), true);
        }
        zip.end();
      })().catch((err) => controller.error(err));
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(zipName),
      "Cache-Control": "no-store",
    },
  });
});

// ---- Navidrome proxy -------------------------------------------------------

async function proxy(c: Parameters<Parameters<typeof app.all>[1]>[0]): Promise<Response> {
  if (!NAVIDROME_URL) {
    return c.json({ error: "NAVIDROME_URL is not configured on this server" }, 503);
  }

  const url = new URL(c.req.url);
  const target = `${NAVIDROME_URL}${url.pathname}${url.search}`;

  const isWrite = c.req.method !== "GET" && c.req.method !== "HEAD";
  const reqHeaders: Record<string, string> = {};

  // Forward critical request headers for auth, streaming/seeking, and custom API usage
  for (const key of [
    "content-type",
    "accept",
    "range",
    "authorization",
    "x-nd-authorization",
    "x-nd-client-unique-id",
  ]) {
    const val = c.req.header(key);
    if (val) reqHeaders[key] = val;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: c.req.method,
      headers: reqHeaders,
      body: isWrite ? await c.req.raw.arrayBuffer() : undefined,
    });
  } catch (err) {
    return c.json({ error: `Could not reach Navidrome at ${NAVIDROME_URL}` }, 502);
  }

  // Forward a safe subset of response headers. Stream the body so large audio
  // responses are not buffered in memory. Include headers for range requests and custom auth.
  const resHeaders: Record<string, string> = {};
  for (const key of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "transfer-encoding",
    "x-nd-authorization",
  ]) {
    const val = upstream.headers.get(key);
    if (val) resHeaders[key] = val;
  }

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

app.all("/rest/*", proxy);
app.all("/auth/*", proxy);
app.all("/api/*", proxy);

// ---- Link previews (OpenGraph / Twitter / Bluesky cards) -------------------
//
// For crawler requests to /album/:id, /playlist/:id and /artist/:id we fetch the
// item's name + cover from Navidrome (using the configured read-only account) and
// serve an index.html with proper og:* / twitter:* tags. The cover is exposed via
// a public /og/cover proxy so unauthenticated crawlers can load it. Everything is
// off unless link previews are configured.

const CRAWLER_RE =
  /bot|facebookexternalhit|twitterbot|slackbot|discordbot|whatsapp|telegrambot|embed|preview|pinterest|redditbot|applebot|linkedinbot|skypeuripreview|bluesky|bsky|mastodon|iframely|vkshare|quora|google-inspectiontool|developers\.google\.com/i;

const DETAIL_RE = /^\/(album|artist|playlist)\/([^/?#]+)/;

// Build Subsonic auth params for the configured read-only preview account. A
// fresh salt/token is derived per call from the stored password.
function ogAuthParams(): URLSearchParams {
  const salt = randomBytes(9).toString("hex");
  const token = createHash("md5").update(OG_PASS + salt).digest("hex");
  return new URLSearchParams({
    u: OG_USER, t: token, s: salt, v: SUBSONIC_VERSION, c: SUBSONIC_CLIENT, f: "json",
  });
}

async function ndGet(endpoint: string, params: Record<string, string>): Promise<any | null> {
  const search = ogAuthParams();
  for (const [k, v] of Object.entries(params)) search.set(k, v);
  try {
    const res = await fetch(`${NAVIDROME_URL}/rest/${endpoint}?${search.toString()}`);
    if (!res.ok) return null;
    const sub = (await res.json())?.["subsonic-response"];
    return sub && sub.status === "ok" ? sub : null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Honor reverse-proxy headers so absolute preview URLs point at the public host.
function reqOrigin(c: any): string {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? c.req.header("host");
  if (proto && host) return `${proto}://${host}`;
  return new URL(c.req.url).origin;
}

interface PreviewMeta {
  title: string;
  description: string;
  coverArt?: string;
  ogType: string;
}

async function previewMeta(kind: string, id: string): Promise<PreviewMeta | null> {
  if (kind === "album") {
    const sub = await ndGet("getAlbum.view", { id });
    const a = sub?.album;
    if (!a) return null;
    const bits = [a.artist, a.songCount != null ? `${a.songCount} tracks` : null, a.year]
      .filter(Boolean)
      .join(" · ");
    return {
      title: a.artist ? `${a.name} — ${a.artist}` : a.name,
      description: bits || "Album",
      coverArt: a.coverArt ?? id,
      ogType: "music.album",
    };
  }
  if (kind === "playlist") {
    const sub = await ndGet("getPlaylist.view", { id });
    const p = sub?.playlist;
    if (!p) return null;
    return {
      title: p.name,
      description: [p.comment, p.songCount != null ? `${p.songCount} tracks` : null]
        .filter(Boolean)
        .join(" · ") || "Playlist",
      coverArt: p.coverArt ?? id,
      ogType: "music.playlist",
    };
  }
  if (kind === "artist") {
    const sub = await ndGet("getArtist.view", { id });
    const a = sub?.artist;
    if (!a) return null;
    return {
      title: a.name,
      description: a.albumCount != null ? `${a.albumCount} albums` : "Artist",
      coverArt: a.coverArt ?? (a.album?.[0]?.coverArt),
      ogType: "profile",
    };
  }
  return null;
}

// Inject preview meta into the SPA shell and override its <title>.
function injectPreview(html: string, meta: PreviewMeta, url: string, origin: string): string {
  const fullTitle = `${meta.title} · Navidrome`;
  const image = meta.coverArt ? `${origin}/og/cover/${encodeURIComponent(meta.coverArt)}` : "";
  const tags = [
    `<meta property="og:site_name" content="Navidrome" />`,
    `<meta property="og:type" content="${escapeHtml(meta.ogType)}" />`,
    `<meta property="og:title" content="${escapeHtml(fullTitle)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(fullTitle)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}" />` : "",
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
  ]
    .filter(Boolean)
    .join("\n    ");

  let out = html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(fullTitle)}</title>`);
  return out.replace(/<\/head>/i, `    ${tags}\n  </head>`);
}

// Public cover proxy: streams cover art via the preview account so anonymous
// crawlers can load the image. Only available when link previews are enabled.
app.get("/og/cover/:id", async (c) => {
  if (!linkPreviewsEnabled) return c.notFound();
  const search = ogAuthParams();
  search.set("id", c.req.param("id"));
  search.set("size", "1200");
  let upstream: Response;
  try {
    upstream = await fetch(`${NAVIDROME_URL}/rest/getCoverArt.view?${search.toString()}`);
  } catch {
    return c.notFound();
  }
  if (!upstream.ok) return c.notFound();
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ---- Static file server with SPA fallback ----------------------------------

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  json: "application/json",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain",
};

function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

app.all("*", async (c) => {
  const pathname = new URL(c.req.url).pathname;

  // Crawler hitting a detail route: serve a link-preview-enriched index.html.
  // Humans fall through to the normal SPA shell below.
  const detail = pathname.match(DETAIL_RE);
  if (
    linkPreviewsEnabled &&
    detail &&
    c.req.method === "GET" &&
    CRAWLER_RE.test(c.req.header("user-agent") ?? "")
  ) {
    try {
      const meta = await previewMeta(detail[1], decodeURIComponent(detail[2]));
      if (meta) {
        const shell = await Bun.file(`${DIST}/index.html`).text();
        const origin = reqOrigin(c);
        const html = injectPreview(shell, meta, `${origin}${pathname}`, origin);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        });
      }
    } catch {
      // Any failure: fall through and serve the plain shell.
    }
  }

  // Try exact file, then index.html inside a directory.
  const candidates = [
    `${DIST}${pathname}`,
    `${DIST}${pathname.replace(/\/$/, "")}/index.html`,
  ];

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const isHtml = candidate.endsWith(".html");
      const isHashed = pathname.startsWith("/assets/");
      return new Response(file, {
        headers: {
          "Content-Type": mimeOf(candidate),
          "Cache-Control": isHashed
            ? "public, max-age=31536000, immutable"
            : isHtml
              ? "no-cache, no-store, must-revalidate"
              : "public, max-age=600",
        },
      });
    }
  }

  // SPA fallback: any unrecognised path serves index.html for client routing.
  return new Response(Bun.file(`${DIST}/index.html`), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
});

// ---- Start -----------------------------------------------------------------

// Raise the body size limit to accommodate large ZIP uploads.
const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
  maxRequestBodySize: 4 * 1024 * 1024 * 1024, // 4 GB
});

console.log(`navidrome-client-web listening on port ${server.port}`);
if (NAVIDROME_URL) {
  console.log(`Proxy mode: forwarding /rest/* and /auth/* → ${NAVIDROME_URL}`);
} else {
  console.log("Direct mode: no NAVIDROME_URL set — clients connect to their own server");
}
if (MUSIC_DIR) {
  console.log(`Upload mode: writing to ${MUSIC_DIR}`);
}
if (linkPreviewsEnabled) {
  console.log(`Link previews: rich cards for crawlers via account "${OG_USER}"`);
}
