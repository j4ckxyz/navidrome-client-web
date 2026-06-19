// Top-level app: shows the login screen until there's an authenticated client,
// otherwise mounts the router with the app shell as the persistent layout.

import { lazy, Show } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { client, reauthRequired, activeServerUrl, activeUsername } from "~/auth/session";
import { LoginScreen } from "~/auth/LoginScreen";
import { AppShell } from "~/features/shell/AppShell";

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
const Settings = lazy(() => import("~/pages/Settings"));

export function App() {
  return (
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
        <Route path="/settings" component={Settings} />
        <Route path="*" component={Home} />
      </Router>
    </Show>
  );
}
