import { createSignal } from "solid-js";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { desktopPlatform, isTauriDesktop } from "./runtime";

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "current"
  | "error";

const [desktopUpdateStatus, setDesktopUpdateStatus] =
  createSignal<DesktopUpdateStatus>("idle");
const [desktopUpdateVersion, setDesktopUpdateVersion] = createSignal<string | null>(null);
const [desktopUpdateNotes, setDesktopUpdateNotes] = createSignal<string | null>(null);
const [desktopUpdateProgress, setDesktopUpdateProgress] = createSignal<number | null>(null);
const [desktopUpdateError, setDesktopUpdateError] = createSignal<string | null>(null);

let pendingUpdate: Update | null = null;
let activeCheck: Promise<boolean> | null = null;

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function canUseInAppUpdates(): boolean {
  return isTauriDesktop && (desktopPlatform === "macos" || desktopPlatform === "windows");
}

export function checkForDesktopUpdate(options: { quiet?: boolean } = {}): Promise<boolean> {
  if (!canUseInAppUpdates()) return Promise.resolve(false);
  if (activeCheck) return activeCheck;

  activeCheck = (async () => {
    setDesktopUpdateStatus("checking");
    setDesktopUpdateError(null);
    try {
      if (pendingUpdate) await pendingUpdate.close();
      pendingUpdate = await check();
      if (!pendingUpdate) {
        setDesktopUpdateVersion(null);
        setDesktopUpdateNotes(null);
        setDesktopUpdateStatus(options.quiet ? "idle" : "current");
        return false;
      }
      setDesktopUpdateVersion(pendingUpdate.version);
      setDesktopUpdateNotes(pendingUpdate.body ?? null);
      setDesktopUpdateStatus("available");
      return true;
    } catch (error) {
      setDesktopUpdateError(messageFrom(error));
      setDesktopUpdateStatus(options.quiet ? "idle" : "error");
      return false;
    } finally {
      activeCheck = null;
    }
  })();

  return activeCheck;
}

export async function installDesktopUpdate(): Promise<void> {
  if (!pendingUpdate || desktopUpdateStatus() === "downloading") return;

  setDesktopUpdateStatus("downloading");
  setDesktopUpdateError(null);
  setDesktopUpdateProgress(0);
  let downloaded = 0;
  let total = 0;

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        setDesktopUpdateProgress(total > 0 ? 0 : null);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        setDesktopUpdateProgress(total > 0 ? Math.min(1, downloaded / total) : null);
      } else {
        setDesktopUpdateStatus("installing");
        setDesktopUpdateProgress(1);
      }
    });
    await relaunch();
  } catch (error) {
    setDesktopUpdateError(messageFrom(error));
    setDesktopUpdateStatus("error");
  }
}

export function dismissDesktopUpdate(): void {
  if (desktopUpdateStatus() === "available") setDesktopUpdateStatus("idle");
}

export {
  desktopUpdateError,
  desktopUpdateNotes,
  desktopUpdateProgress,
  desktopUpdateStatus,
  desktopUpdateVersion,
};
