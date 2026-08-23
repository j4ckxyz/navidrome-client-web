/* @refresh reload */
import { render } from "solid-js/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "~/lib/query";
import { ThemeProvider } from "~/theme/provider";
import { initSession } from "~/auth/session";
import { player } from "~/player/store";
import { loadHistory } from "~/features/history/history";
import { installMediaSession } from "~/player/mediaSession";
import { installJellyfinSocket } from "~/player/jellyfinSocket";
import { installJellyfinRemote } from "~/player/jellyfinRemote";
import { installRemoteSessions } from "~/player/remoteSessions";
import { installArtCacheBudget } from "~/lib/artCache";
import { installListeners as installPwaListeners } from "~/lib/installPwa";
import { desktopClasses, desktopPlatform, isTauriDesktop } from "~/lib/runtime";
import { loadServerConfig } from "~/lib/serverConfig";
import { APP_NAME, APP_TAGLINE } from "~/lib/branding";
import { App } from "./App";

import "~/styles/global.css";
import "~/pages/pages.css";
import "~/styles/desktop.css";

// Tauri provides the native window controls and compositor blur; this marker
// reserves a draggable title-bar region without changing the browser/PWA UI.
// Only macOS hides its caption behind the content (titleBarStyle "Overlay"), so
// only macOS gets the reserved strip — on Windows and Linux the real title bar
// sits above the client area and the strip would be a second, dead one covering
// the top of the UI.
if (desktopPlatform) {
  document.documentElement.classList.add(...desktopClasses(desktopPlatform));
}

// Restore a prior session and queue before first paint.
initSession();
player.restoreQueue();
loadHistory();
// Lock-screen / media-key transport controls.
installMediaSession();
// Remote control, both directions. All three are no-ops for Navidrome, whose
// Subsonic API has no concept of a session or another device.
//   - inbound:  be a controllable device, so a phone can drive playback here
//   - outbound: discover other devices and hand playback off to one
// Handlers are registered before the socket opens so nothing pushed on connect
// is missed.
installJellyfinRemote();
installRemoteSessions();
installJellyfinSocket();
// Hand the artwork cache budget to the service worker, which does the eviction
// but cannot read the setting itself.
installArtCacheBudget();
// Native shells neither need nor understand browser installation prompts.
if (!isTauriDesktop) installPwaListeners();
// Check if running with a backend proxy (non-blocking; sets proxyMode signal).
void loadServerConfig();

// Install the service worker (production builds only — it would fight Vite's
// dev server). Registration failures are non-fatal; the app just isn't
// installable/offline-capable in that session.
if ("serviceWorker" in navigator) {
  if (isTauriDesktop) {
    // Remove registrations left by older desktop builds. Native assets ship
    // with the binary, so a web cache can only make an upgraded app stale.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister();
    });
  } else if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
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
  `%c◉ ${APP_NAME}%c  ${APP_TAGLINE} — enjoy the music.`,
  "font-weight:700",
  "color:#9b9384",
);
