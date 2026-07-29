import type { ShortcutAction } from "~/settings/schema";

// Pure shortcut matching lives separately from player/session wiring so it can
// be regression-tested without booting the browser application.
export function keyFromEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(event.key === " " ? "Space" : event.key);
  return parts.join("+");
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

export function shortcutActionForEvent(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "target"
  >,
  bindings: Record<ShortcutAction, string>,
): ShortcutAction | null {
  if (isTypingTarget(event.target)) return null;
  const combo = keyFromEvent(event);
  for (const action of Object.keys(bindings) as ShortcutAction[]) {
    if (bindings[action] === combo) return action;
  }
  return null;
}
