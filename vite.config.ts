import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

// When VITE_NAVIDROME_URL is set in your environment (or a .env.local file),
// Vite proxies /rest/* and /auth/* to that server during development — the
// same paths the production backend proxy handles.
const navidromeUrl = process.env.VITE_NAVIDROME_URL;

export default defineConfig({
  plugins: [solid()],
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
                res.end(JSON.stringify({ proxyMode: true, version: "1.0.0" }));
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
