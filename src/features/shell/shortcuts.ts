// Global keyboard shortcuts. Bindings are user-configurable (settings.power.
// shortcuts); this maps an event to a binding string and runs the matching
// action. Shortcuts are ignored while typing in inputs (except a few globals).

import { onCleanup } from "solid-js";
import { player } from "~/player/store";
import { settings, updateSettings } from "~/settings/store";
import { toggleStar } from "~/features/stars";
import { requestSearchFocus } from "./searchFocus";
import { setShowShortcuts } from "./ShortcutsHelpDialog";
import type { ShortcutAction } from "~/settings/schema";
import {
  isTypingTarget,
  keyFromEvent,
  shortcutActionForEvent,
} from "./shortcutMatching";

export { isTypingTarget, keyFromEvent, shortcutActionForEvent } from "./shortcutMatching";

const ACTIONS: Record<ShortcutAction, () => void> = {
  playPause: () => player.togglePlay(),
  next: () => player.next(),
  previous: () => player.previous(),
  seekForward: () => player.seekBy(5),
  seekBackward: () => player.seekBy(-5),
  volumeUp: () => player.changeVolume(0.05),
  volumeDown: () => player.changeVolume(-0.05),
  toggleMute: () => player.toggleMute(),
  toggleQueue: () =>
    updateSettings((s) => (s.layout.showQueuePanel = !s.layout.showQueuePanel)),
  toggleLyrics: () =>
    updateSettings((s) => (s.layout.showLyricsPanel = !s.layout.showLyricsPanel)),
  focusSearch: () => requestSearchFocus(),
  toggleShuffle: () => player.toggleShuffle(),
  toggleRepeat: () => player.cycleRepeat(),
  starCurrent: () => {
    const s = player.current();
    if (s) toggleStar(s.id, s.starred, "song");
  },
};

export function installShortcuts(): void {
  const handler = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const combo = keyFromEvent(e);

    if (combo === "?" || combo === "Shift+?") {
      e.preventDefault();
      setShowShortcuts((v) => !v);
      return;
    }

    const action = shortcutActionForEvent(e, settings.power.shortcuts);
    if (!action) return;
    e.preventDefault();
    ACTIONS[action]();
  };
  window.addEventListener("keydown", handler);
  onCleanup(() => window.removeEventListener("keydown", handler));
}
