// Keeps the service worker's artwork budget in step with the setting.
//
// A worker can't read localStorage, so the "Cover art cache" slider had no way
// to reach the code that does the eviction — it wrote a value nothing consumed.
// This posts the budget across on boot and on every change.

import { createEffect, createRoot, on } from "solid-js";
import { settings } from "~/settings/store";
import { log } from "./log";

function post(megabytes: number): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready
    .then((registration) => {
      // `active` is null for a registration still installing; the next change,
      // or the next boot, delivers the budget instead.
      registration.active?.postMessage({ type: "art-budget", megabytes });
      log.debug("art-cache", `budget ${megabytes}MB sent to the worker`);
    })
    .catch((err) => log.debug("art-cache", "worker unavailable", err));
}

export function installArtCacheBudget(): void {
  createRoot(() => {
    createEffect(
      on(
        () => settings.power.coverArtCacheMB,
        (megabytes) => post(megabytes),
      ),
    );
  });
}
