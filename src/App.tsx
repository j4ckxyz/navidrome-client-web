// Top-level app: shows the login screen until there's an authenticated client,
// otherwise mounts the router with the app shell as the persistent layout.

import { createEffect, ErrorBoundary, lazy, onMount, Show } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { client, reauthRequired, activeServerUrl, activeUsername } from "~/auth/session";
import { LoginScreen } from "~/auth/LoginScreen";
import { AppShell } from "~/features/shell/AppShell";
import { ErrorState } from "~/ui/ErrorState";
import { applyDesktopAppIcon, startDesktopWindowDrag } from "~/lib/desktopShell";
import { isTauriDesktop } from "~/lib/runtime";
import { settings } from "~/settings/store";
import { checkForDesktopUpdate, canUseInAppUpdates } from "~/lib/desktopUpdater";

const Home = lazy(() => import("~/pages/Home"));
const Albums = lazy(() => import("~/pages/Albums"));
const Artists = lazy(() => import("~/pages/Artists"));
const Genres = lazy(() => import("~/pages/Genres"));
const GenreDetail = lazy(() => import("~/pages/GenreDetail"));
const Favourites = lazy(() => import("~/pages/Favourites"));
const AlbumDetail = lazy(() => import("~/pages/AlbumDetail"));
const ArtistDetail = lazy(() => import("~/pages/ArtistDetail"));
const PlaylistDetail = lazy(() => import("~/pages/PlaylistDetail"));
const Search = lazy(() => import("~/pages/Search"));
const Radio = lazy(() => import("~/pages/Radio"));
const Listen = lazy(() => import("~/pages/Listen"));
const SongLink = lazy(() => import("~/pages/SongLink"));
const Settings = lazy(() => import("~/pages/Settings"));
const Wrapped = lazy(() => import("~/pages/Wrapped"));
const Stats = lazy(() => import("~/pages/Stats"));
const History = lazy(() => import("~/pages/History"));

export function App() {
  createEffect(() => {
    const variant = settings.desktop.appIcon;
    if (isTauriDesktop) void applyDesktopAppIcon(variant);
  });

  onMount(() => {
    if (!canUseInAppUpdates() || !settings.desktop.checkForUpdatesOnLaunch) return;
    window.setTimeout(() => void checkForDesktopUpdate({ quiet: true }), 2500);
  });

  return (
    <ErrorBoundary fallback={(err, reset) => <ErrorState error={err} reset={reset} fatal />}>
      <div
        class="native-titlebar"
        data-tauri-drag-region
        aria-hidden="true"
        onMouseDown={startDesktopWindowDrag}
      />
      <Show
        when={client() && !reauthRequired()}
        fallback={
          <LoginScreen
            reauth={reauthRequired()}
            prefillServer={reauthRequired() ? activeServerUrl() ?? undefined : undefined}
            prefillUser={reauthRequired() ? activeUsername() ?? undefined : undefined}
          />
        }
      >
        <Router root={AppShell}>
          <Route path="/" component={Home} />
          <Route path="/albums" component={Albums} />
          <Route path="/artists" component={Artists} />
          <Route path="/genres" component={Genres} />
          <Route path="/genre/:name" component={GenreDetail} />
          <Route path="/favourites" component={Favourites} />
          <Route path="/album/:id" component={AlbumDetail} />
          <Route path="/artist/:id" component={ArtistDetail} />
          <Route path="/playlist/:id" component={PlaylistDetail} />
          <Route path="/search" component={Search} />
          <Route path="/radio" component={Radio} />
          <Route path="/song/:id" component={SongLink} />
          <Route path="/listen/:artist/:id/:view?" component={Listen} />
          <Route path="/recap" component={Wrapped} />
          <Route path="/stats" component={Stats} />
          <Route path="/history" component={History} />
          <Route path="/settings" component={Settings} />
          <Route path="*" component={Home} />
        </Router>
      </Show>
    </ErrorBoundary>
  );
}
