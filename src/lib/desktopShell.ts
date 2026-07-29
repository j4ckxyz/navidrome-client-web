import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppIconVariant } from "~/settings/schema";
import { desktopPlatform, isTauriDesktop } from "./runtime";

export async function applyDesktopAppIcon(variant: AppIconVariant): Promise<void> {
  if (!isTauriDesktop || desktopPlatform === "linux") return;
  try {
    await invoke("set_app_icon", { variant });
  } catch (error) {
    console.warn("Could not apply the selected desktop app icon:", error);
  }
}

// Tauri's data-tauri-drag-region attribute intentionally applies only to the
// exact DOM node clicked. Calling the native API from the full titlebar gives
// the whole visible strip one dependable hit target on macOS.
export function startDesktopWindowDrag(event: MouseEvent): void {
  if (!isTauriDesktop || desktopPlatform !== "macos") return;
  if (event.button !== 0 || event.detail !== 1) return;
  event.preventDefault();
  void getCurrentWindow().startDragging().catch((error) => {
    console.warn("Could not start native window drag:", error);
  });
}
