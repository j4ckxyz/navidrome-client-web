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

import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

const NAVIDROME_URL = (process.env.NAVIDROME_URL ?? "").replace(/\/+$/, "");
const PORT = +(process.env.PORT ?? 8080);
const DIST = (process.env.DIST_DIR ?? "./dist").replace(/\/+$/, "");
const MUSIC_DIR = (process.env.MUSIC_DIR ?? "").replace(/\/+$/, "");

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

// Sanitize a path from a ZIP entry: strip leading slashes, drop MacOS junk.
function sanitizeZipEntry(entry: string): string | null {
  const parts = entry.split("/");
  if (parts.some((p) => p === "__MACOSX" || (p.startsWith(".") && p !== "."))) return null;
  return parts.filter(Boolean).join("/");
}

const app = new Hono();

// ---- Config ----------------------------------------------------------------

app.get("/api/config", (c) =>
  c.json({ proxyMode: !!NAVIDROME_URL, uploadEnabled: !!(NAVIDROME_URL && MUSIC_DIR), version: "1.0.0" }),
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

// ---- Upload ----------------------------------------------------------------

app.post("/upload", async (c) => {
  if (!MUSIC_DIR || !NAVIDROME_URL) {
    return c.json({ error: "Upload not configured (set MUSIC_DIR and NAVIDROME_URL)" }, 503);
  }

  const jwt = c.req.header("x-nd-authorization");
  const subUser = c.req.header("x-nd-subsonic-u");
  const subToken = c.req.header("x-nd-subsonic-t");
  const subSalt = c.req.header("x-nd-subsonic-s");

  const admin = await verifyAdmin({ jwt, subUser, subToken, subSalt });
  if (!admin) {
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

  const relativePath = (formData.get("path") as string | null) ?? file.name;
  const written: string[] = [];

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
        let dest: string;
        try {
          dest = safeJoin(MUSIC_DIR, clean);
        } catch {
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        await Bun.write(dest, data);
        written.push(clean);
      }
    } else if (isAudioFile(file.name)) {
      const clean = relativePath.replace(/\.\.(\/|\\)/g, "").replace(/^[/\\]+/, "");
      let dest: string;
      try {
        dest = safeJoin(MUSIC_DIR, clean);
      } catch {
        return c.json({ error: "Invalid file path" }, 400);
      }
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(dest, buf);
      written.push(clean);
    } else {
      return c.json({ error: "Unsupported file type. Upload audio files or a ZIP archive." }, 400);
    }
  } catch (err) {
    console.error("Upload error:", err);
    return c.json({ error: "Failed to write file to music directory" }, 500);
  }

  // Trigger a library scan so the new files appear in Navidrome.
  let scanStarted = false;
  if (written.length > 0) {
    try {
      if (subUser && subToken && subSalt) {
        const params = new URLSearchParams({
          u: subUser, t: subToken, s: subSalt,
          v: "1.16.1", c: "navidrome-web", f: "json",
        });
        const res = await fetch(`${NAVIDROME_URL}/rest/startScan.view?${params}`);
        scanStarted = res.ok;
      } else if (jwt) {
        const res = await fetch(`${NAVIDROME_URL}/api/scanner`, {
          method: "PUT",
          headers: { "x-nd-authorization": jwt, "Content-Type": "application/json" },
          body: JSON.stringify({ fullRescan: false }),
        });
        scanStarted = res.ok;
      }
    } catch {
      // Non-fatal — files are written; manual scan still works.
    }
  }

  return c.json({ written, scanStarted });
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
