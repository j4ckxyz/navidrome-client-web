// PWA install plumbing. Chrome/Edge fire `beforeinstallprompt` when the app
// meets installability criteria; we stash the event so Settings can offer a
// real "Install app" button. iOS Safari never fires it — the UI shows
// Share-sheet instructions instead. Import early (main.tsx) or the event is
// missed.

import { createSignal } from "solid-js";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const [installEvent, setInstallEvent] = createSignal<BeforeInstallPromptEvent | null>(null);
const [installed, setInstalled] = createSignal(
  typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS standalone flag
      (navigator as { standalone?: boolean }).standalone === true),
);

export const canPromptInstall = (): boolean => !!installEvent();
export const isInstalled = installed;

export const isIos = (): boolean =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as Mac but is touch-first
    (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1));

export function installListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep Chrome's mini-infobar quiet; we offer our own UI
    setInstallEvent(e as BeforeInstallPromptEvent);
  });
  window.addEventListener("appinstalled", () => {
    setInstallEvent(null);
    setInstalled(true);
  });
}

export async function promptInstall(): Promise<void> {
  const ev = installEvent();
  if (!ev) return;
  await ev.prompt();
  const choice = await ev.userChoice;
  if (choice.outcome === "accepted") setInstallEvent(null);
}
