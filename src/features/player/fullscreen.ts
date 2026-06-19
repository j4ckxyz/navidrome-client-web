// Open/close state for the full-screen "now playing" view. A tiny shared signal
// so the now-playing bar can open it and the app shell can render it.

import { createSignal } from "solid-js";

const [isFullScreen, setFullScreen] = createSignal(false);

export { isFullScreen };
export const openFullScreen = () => setFullScreen(true);
export const closeFullScreen = () => setFullScreen(false);
export const toggleFullScreen = () => setFullScreen((v) => !v);
