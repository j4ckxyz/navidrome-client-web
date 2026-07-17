/* @refresh reload */
import { render } from "solid-js/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "~/lib/query";
import { ThemeProvider } from "~/theme/provider";
import { initSession } from "~/auth/session";
import { player } from "~/player/store";
import { installMediaSession } from "~/player/mediaSession";
import { installListeners as installPwaListeners } from "~/lib/installPwa";
import { loadServerConfig } from "~/lib/serverConfig";
import { App } from "./App";

import "~/styles/global.css";
import "~/pages/pages.css";

// Restore a prior session and queue before first paint.
initSession();
player.restoreQueue();
// Lock-screen / media-key transport controls.
installMediaSession();
// Catch beforeinstallprompt before the browser drops it.
installPwaListeners();
// Check if running with a backend proxy (non-blocking; sets proxyMode signal).
void loadServerConfig();

// Install the service worker (production builds only — it would fight Vite's
// dev server). Registration failures are non-fatal; the app just isn't
// installable/offline-capable in that session.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  ),
  root,
);

// A quiet hello for anyone who opens the console — no tracking, no telemetry.
console.log(
  "%c◉ Navidrome%c  your library, your rules — enjoy the music.",
  "font-weight:700",
  "color:#9b9384",
);
