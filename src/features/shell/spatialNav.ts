// Spatial ("D-pad") navigation. Lets a TV remote or arrow keys move focus
// between on-screen controls — left/right/up/down jump to the nearest focusable
// element in that direction. This makes every page reachable without a mouse.
//
// It cooperates with the player's arrow-key seek/volume shortcuts: those fire
// when nothing is focused (the default "media remote" state) or when focus is in
// the now-playing bar / full-screen transport. Once you focus a link, card, or
// button elsewhere, the arrows navigate focus instead. We run on the capture
// phase and stop propagation only when we actually move focus, so the shortcut
// handler still receives the keys when we don't.

import { onCleanup } from "solid-js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Dir = "left" | "right" | "up" | "down";

const DIR: Record<string, Dir> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

// Regions where arrows should keep their media meaning (seek / volume / slider)
// rather than moving focus.
const MEDIA_REGIONS = ".np-bar, [role='slider'], .slider";

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function candidates(): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));
  return all.filter(isVisible);
}

// Centre point of a rect.
function centre(r: DOMRect): { x: number; y: number } {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Pick the best candidate in `dir` from the current rect. We require the
// candidate to lie predominantly in the travel direction, then score by distance
// along that axis plus a penalty for drifting off-axis, so focus moves to the
// visually nearest neighbour.
function bestInDirection(from: DOMRect, dir: Dir, els: HTMLElement[]): HTMLElement | null {
  const c = centre(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of els) {
    const r = el.getBoundingClientRect();
    const t = centre(r);
    const dx = t.x - c.x;
    const dy = t.y - c.y;

    let along: number; // distance in the travel direction (must be > 0)
    let across: number; // off-axis drift
    switch (dir) {
      case "left":
        along = -dx;
        across = Math.abs(dy);
        break;
      case "right":
        along = dx;
        across = Math.abs(dy);
        break;
      case "up":
        along = -dy;
        across = Math.abs(dx);
        break;
      default:
        along = dy;
        across = Math.abs(dx);
        break;
    }

    // Must be meaningfully in front of us in the chosen direction.
    if (along <= 1) continue;
    // Heavily penalise off-axis drift so we prefer the aligned neighbour.
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function installSpatialNav(): void {
  const handler = (e: KeyboardEvent) => {
    const dir = DIR[e.key];
    if (!dir || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    const active = document.activeElement as HTMLElement | null;
    // Nothing focused → leave arrows to the media shortcuts (seek / volume).
    if (!active || active === document.body) return;
    // Inside an input, slider, or the now-playing transport → don't hijack.
    if (active.closest(MEDIA_REGIONS)) return;
    const tag = active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) {
      return;
    }

    const target = bestInDirection(active.getBoundingClientRect(), dir, candidates());
    if (!target) return; // edge of the UI — let the event fall through

    e.preventDefault();
    e.stopImmediatePropagation(); // keep the seek/volume shortcut from also firing
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // Capture phase so we run before the shortcut handler's window listener.
  window.addEventListener("keydown", handler, true);
  onCleanup(() => window.removeEventListener("keydown", handler, true));
}
