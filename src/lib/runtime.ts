export type DesktopPlatform = "macos" | "windows" | "linux";

export function detectDesktopPlatform(userAgent: string, platform = ""): DesktopPlatform {
  const value = `${userAgent} ${platform}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  return "linux";
}

export const isTauriDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const desktopPlatform: DesktopPlatform | null =
  isTauriDesktop
    ? detectDesktopPlatform(navigator.userAgent, navigator.platform)
    : null;

export function desktopClasses(platform: DesktopPlatform): string[] {
  return [
    "tauri-desktop",
    `tauri-${platform}`,
    ...(platform === "macos" ? ["tauri-overlay-titlebar"] : []),
  ];
}
