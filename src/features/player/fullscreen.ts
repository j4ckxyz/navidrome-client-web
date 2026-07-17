// Open/close state for the full-screen "now playing" view, plus which display
// it's showing. The view is URL-backed (/listen/:artist/:id[/visualiser]) so
// every state of the player is a shareable, bookmarkable address; the router
// sync lives in FullScreenPlayer.

import { createSignal } from "solid-js";

export type FsView = "player" | "visualiser";

const [isFullScreen, setFullScreen] = createSignal(false);
const [fsView, setFsView] = createSignal<FsView>("player");

// Route to return to when the full-screen view closes (captured when the URL
// first switches into /listen/…).
let returnPath = "/";

export { isFullScreen, fsView, setFsView };

export const openFullScreen = (view: FsView = "player") => {
  setFsView(view);
  setFullScreen(true);
};
export const closeFullScreen = () => setFullScreen(false);
export const toggleFullScreen = () => setFullScreen((v) => !v);

export const rememberReturnPath = (path: string) => {
  returnPath = path;
};
export const getReturnPath = () => returnPath;

// URL-safe slug for the artist segment of /listen URLs. Cosmetic only — the
// song id is what's resolved.
export function artistSlug(name?: string): string {
  const slug = (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}
