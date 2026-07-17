// Open/close state for the full-screen "now playing" view. Both this view and
// the immersive visualiser stage are URL-backed (/listen/:artist/:id and
// /listen/:artist/:id/visualiser) so every player state is a shareable,
// bookmarkable address; the router sync lives in each overlay component, and
// the return-path helpers here are shared between them.

import { createSignal } from "solid-js";

const [isFullScreen, setFullScreen] = createSignal(false);

// Route to return to when a /listen overlay closes (captured when the URL
// first switches into /listen/…).
let returnPath = "/";

export { isFullScreen };

export const openFullScreen = () => setFullScreen(true);
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
