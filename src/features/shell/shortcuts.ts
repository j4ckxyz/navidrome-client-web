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

// Normalize a keyboard event into a binding string like "Ctrl+ArrowRight".
export function keyFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  let key = e.key;
  if (key === " ") key = "Space";
  parts.push(key);
  return parts.join("+");
}

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

// Actions allowed even when focus is in a text field (none by default, but
// focusSearch and playPause are commonly wanted; we keep it strict and only
// allow nothing while typing to avoid surprises).
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function installShortcuts(): void {
  const handler = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const combo = keyFromEvent(e);
    
    if (combo === "?" || combo === "Shift+?") {
      e.preventDefault();
      setShowShortcuts((v) => !v);
      return;
    }

    const bindings = settings.power.shortcuts;
    for (const action of Object.keys(bindings) as ShortcutAction[]) {
      if (bindings[action] === combo) {
        e.preventDefault();
        ACTIONS[action]();
        return;
      }
    }
  };
  window.addEventListener("keydown", handler);
  onCleanup(() => window.removeEventListener("keydown", handler));
}
