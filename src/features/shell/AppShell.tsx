// The authenticated app layout: sidebar, scrolling content with a sticky top
// bar, optional queue/lyrics side panel, and the persistent now-playing bar.
// Also installs global keyboard shortcuts and the add-to-playlist dialog.

import { createSignal, type JSX, onMount, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { NowPlayingBar } from "~/features/player/NowPlayingBar";
import { FullScreenPlayer } from "~/features/player/FullScreenPlayer";
import { isFullScreen } from "~/features/player/fullscreen";
import { QueuePanel } from "~/features/player/QueuePanel";
import { LyricsPanel } from "~/features/player/LyricsPanel";
import { AddToPlaylistDialog } from "~/features/playlists/addToPlaylist";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { UploadDialog } from "~/features/upload/UploadDialog";
import { Icon } from "~/ui/Icon";
import { settings, updateSettings } from "~/settings/store";
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
  const [showUpload, setShowUpload] = createSignal(false);

  // Honor the configured landing page once on first load.
  onMount(() => {
    if (location.pathname === "/") {
      const target = LANDING_ROUTES[settings.layout.defaultLanding] ?? "/";
      if (target !== "/") navigate(target, { replace: true });
    }
  });

  return (
    <div
      class="app-shell"
      classList={{
        "app-shell-side": sidePanel(),
        "app-shell-collapsed": !settings.layout.showSidebar,
      }}
    >
      <Sidebar onUpload={() => setShowUpload(true)} />
      <button
        class="sidebar-edge"
        onClick={() => updateSettings((s) => (s.layout.showSidebar = !s.layout.showSidebar))}
        aria-label={settings.layout.showSidebar ? "Hide sidebar" : "Show sidebar"}
        title={settings.layout.showSidebar ? "Hide sidebar" : "Show sidebar"}
      >
        <span class="sidebar-edge-chevron">
          <Icon name="chevron-right" size={15} />
        </span>
      </button>
      <main class="app-content">
        <TopBar />
        <div class="app-scroll">{props.children}</div>
      </main>
      <div class="side-panel-wrapper">
        <div
          class="side-panel-item"
          classList={{
            "side-panel-item-active": settings.layout.showQueuePanel,
          }}
        >
          <QueuePanel />
        </div>
        <div
          class="side-panel-item"
          classList={{
            "side-panel-item-active": !settings.layout.showQueuePanel && settings.layout.showLyricsPanel,
          }}
        >
          <LyricsPanel />
        </div>
      </div>
      <NowPlayingBar />
      <Show when={isFullScreen()}>
        <FullScreenPlayer />
      </Show>
      <AddToPlaylistDialog />
      <ShortcutsHelpDialog />
      <Show when={showUpload()}>
        <UploadDialog onClose={() => setShowUpload(false)} />
      </Show>
    </div>
  );
}
