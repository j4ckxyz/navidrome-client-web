import { createMemo } from "solid-js";
import { Icon } from "~/ui/Icon";

const REPOSITORY = "j4ckxyz/navidrome-client-web";
const RELEASES = `https://github.com/${REPOSITORY}/releases/latest`;

function platform(): "mac" | "windows" | "linux" {
  const value = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (value.includes("mac")) return "mac";
  if (value.includes("win")) return "windows";
  return "linux";
}

const choices = {
  mac: { label: "Download for macOS", detail: "Universal DMG · Apple Silicon + Intel · macOS 15+" },
  windows: { label: "Download for Windows", detail: "64-bit native installer" },
  linux: { label: "Download for Linux", detail: "64-bit AppImage" },
} as const;

export function DesktopDownloads() {
  const selected = createMemo(() => choices[platform()]);
  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Desktop app</h3>
      <p class="muted settings-hint">
        The lightweight native app uses your operating system's WebView rather than bundling a
        second browser. Track, album and playlist downloads are available from their menus for
        offline listening. Native Playback-menu shortcuts use Command on macOS and Control on
        Windows/Linux, while your custom shortcuts work whenever the app is focused.
      </p>
      <div class="settings-actions">
        <a class="btn btn-primary" href={RELEASES} target="_blank" rel="noreferrer noopener">
          <Icon name="download" size={16} /> {selected().label}
        </a>
        <a class="btn" href={RELEASES} target="_blank" rel="noreferrer noopener">Other platforms</a>
      </div>
      <p class="muted settings-hint">{selected().detail} · Downloads open the latest GitHub release.</p>
    </div>
  );
}
