// The authenticated app layout: sidebar, scrolling content with a sticky top
// bar, optional queue/lyrics side panel, and the persistent now-playing bar.
// Also installs global keyboard shortcuts and the add-to-playlist dialog.

import { type JSX, onMount, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { NowPlayingBar } from "~/features/player/NowPlayingBar";
import { QueuePanel } from "~/features/player/QueuePanel";
import { LyricsPanel } from "~/features/player/LyricsPanel";
import { AddToPlaylistDialog } from "~/features/playlists/addToPlaylist";
import { settings } from "~/settings/store";
import { installShortcuts } from "./shortcuts";
import "./shell.css";

// Map the default-landing setting to a route for the initial redirect.
const LANDING_ROUTES: Record<string, string> = {
  home: "/",
  albums: "/albums",
  artists: "/artists",
  playlists: "/",
  "recently-added": "/albums?sort=newest",
  "recently-played": "/albums?sort=recent",
};

export function AppShell(props: { children?: JSX.Element }) {
  installShortcuts();
  const navigate = useNavigate();
  const location = useLocation();
  const sidePanel = () => settings.layout.showQueuePanel || settings.layout.showLyricsPanel;

  // Honor the configured landing page once on first load.
  onMount(() => {
    if (location.pathname === "/") {
      const target = LANDING_ROUTES[settings.layout.defaultLanding] ?? "/";
      if (target !== "/") navigate(target, { replace: true });
    }
  });

  return (
    <div class="app-shell" classList={{ "app-shell-side": sidePanel() }}>
      <Sidebar />
      <main class="app-content">
        <TopBar />
        <div class="app-scroll">{props.children}</div>
      </main>
      <Show when={sidePanel()}>
        {/* Queue takes precedence if both are toggled; lyrics shows otherwise. */}
        <Show when={settings.layout.showQueuePanel} fallback={<LyricsPanel />}>
          <QueuePanel />
        </Show>
      </Show>
      <NowPlayingBar />
      <AddToPlaylistDialog />
    </div>
  );
}
