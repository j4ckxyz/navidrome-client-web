import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

// Version and commit are injected at build time rather than hand-maintained.
// A hardcoded APP_VERSION had already drifted to 1.0.0 while package.json said
// 0.2.2, which meant the app announced a version to Jellyfin that never existed.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Best-effort: there's no git in the Docker build stage (.dockerignore excludes
// .git), so this is empty there and the version above carries the identity.
function gitCommit(): string {
  if (process.env.COMMIT_HASH) return process.env.COMMIT_HASH.trim();
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// When VITE_NAVIDROME_URL is set in your environment (or a .env.local file),
// Vite proxies /rest/* and /auth/* to that server during development — the
// same paths the production backend proxy handles.
const navidromeUrl = process.env.VITE_NAVIDROME_URL;

export default defineConfig({
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_HASH__: JSON.stringify(gitCommit()),
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: navidromeUrl
      ? {
          "/rest": { target: navidromeUrl, changeOrigin: true },
          "/auth": { target: navidromeUrl, changeOrigin: true },
          "/api/config": {
            target: navidromeUrl, // required by vite proxy but bypassed
            bypass: (_req, res) => {
              if (res) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ proxyMode: true, version: pkg.version }));
              }
            },
          },
          "/api": { target: navidromeUrl, changeOrigin: true },
        }
      : undefined,
  },
  build: {
    target: "esnext",
    sourcemap: false,
  },
});
