// Shared open/close + mode state for the immersive visualiser, so the now-playing
// bar can launch it and the app shell can render it (mirrors player/fullscreen.ts).

import { createSignal } from "solid-js";

export type VizMode = "classic" | "magnetosphere";

const [isVisualizerOpen, setVisualizerOpen] = createSignal(false);
const [vizMode, setVizMode] = createSignal<VizMode>("classic");

export { isVisualizerOpen, vizMode, setVizMode };
export const openVisualizer = (mode?: VizMode) => {
  if (mode) setVizMode(mode);
  setVisualizerOpen(true);
};
export const closeVisualizer = () => setVisualizerOpen(false);
