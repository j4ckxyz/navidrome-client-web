import { getVersion } from "@tauri-apps/api/app";
import { createSignal, onMount, Show } from "solid-js";
import {
  canUseInAppUpdates,
  checkForDesktopUpdate,
  desktopUpdateError,
  desktopUpdateProgress,
  desktopUpdateStatus,
  desktopUpdateVersion,
  installDesktopUpdate,
} from "~/lib/desktopUpdater";
import { settings, updateSettings } from "~/settings/store";
import { Row, Toggle } from "./controls";

export function DesktopUpdates() {
  const [version, setVersion] = createSignal("…");
  onMount(() => void getVersion().then(setVersion).catch(() => setVersion("unknown")));

  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Software updates</h3>
      <p class="muted settings-hint">Tonearm {version()}</p>

      <Show
        when={canUseInAppUpdates()}
        fallback={
          <div class="desktop-update-linux">
            <p>Update an AppImage from a terminal:</p>
            <code>tonearm --update</code>
            <p class="muted settings-hint">
              You can also run the downloaded AppImage with <code>--update</code>.
            </p>
          </div>
        }
      >
        <Row label="Check automatically" hint="Quietly check GitHub when Tonearm opens">
          <Toggle
            label="Check for updates on launch"
            checked={settings.desktop.checkForUpdatesOnLaunch}
            onChange={(value) =>
              updateSettings((s) => (s.desktop.checkForUpdatesOnLaunch = value))
            }
          />
        </Row>

        <div class="desktop-update-actions">
          <button
            class="btn"
            disabled={
              desktopUpdateStatus() === "checking" ||
              desktopUpdateStatus() === "downloading" ||
              desktopUpdateStatus() === "installing"
            }
            onClick={() => void checkForDesktopUpdate()}
          >
            {desktopUpdateStatus() === "checking" ? "Checking…" : "Check for updates"}
          </button>
          <Show when={desktopUpdateStatus() === "available"}>
            <button class="btn btn-primary" onClick={() => void installDesktopUpdate()}>
              Update to {desktopUpdateVersion()}
            </button>
          </Show>
        </div>

        <Show when={desktopUpdateStatus() === "current"}>
          <p class="settings-import-msg">You’re up to date.</p>
        </Show>
        <Show when={desktopUpdateStatus() === "downloading"}>
          <p class="settings-import-msg">
            Downloading update
            {desktopUpdateProgress() !== null
              ? ` · ${Math.round(desktopUpdateProgress()! * 100)}%`
              : "…"}
          </p>
        </Show>
        <Show when={desktopUpdateStatus() === "installing"}>
          <p class="settings-import-msg">Installing and relaunching…</p>
        </Show>
        <Show when={desktopUpdateStatus() === "error"}>
          <p class="settings-import-msg settings-import-err">
            Update failed: {desktopUpdateError()}
          </p>
        </Show>
      </Show>
    </div>
  );
}
