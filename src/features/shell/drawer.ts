// Shared state for the mobile navigation drawer (the off-canvas sidebar). Lives
// in its own module so the top bar's hamburger, the bottom tab bar's "More"
// button, the sidebar itself, and the dimming scrim can all drive one signal.

import { createSignal } from "solid-js";

const [drawerOpen, setDrawerOpen] = createSignal(false);

export { drawerOpen };
export const openDrawer = () => setDrawerOpen(true);
export const closeDrawer = () => setDrawerOpen(false);
export const toggleDrawer = () => setDrawerOpen((v) => !v);
