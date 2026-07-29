import { Show } from "solid-js";
import {
  desktopUpdateProgress,
  desktopUpdateStatus,
  desktopUpdateVersion,
  dismissDesktopUpdate,
  installDesktopUpdate,
} from "~/lib/desktopUpdater";
import "./DesktopUpdateNotice.css";

export function DesktopUpdateNotice() {
  return (
    <Show
      when={
        desktopUpdateStatus() === "available" ||
        desktopUpdateStatus() === "downloading" ||
        desktopUpdateStatus() === "installing"
      }
    >
      <aside class="desktop-update-notice" aria-live="polite">
        <div>
          <strong>
            {desktopUpdateStatus() === "available"
              ? `Tonearm ${desktopUpdateVersion()} is available`
              : desktopUpdateStatus() === "downloading"
                ? "Downloading Tonearm update"
                : "Installing update"}
          </strong>
          <span class="muted">
            {desktopUpdateStatus() === "downloading" && desktopUpdateProgress() !== null
              ? `${Math.round(desktopUpdateProgress()! * 100)}%`
              : desktopUpdateStatus() === "installing"
                ? "Tonearm will relaunch"
                : "Install it without leaving the app"}
          </span>
        </div>
        <Show when={desktopUpdateStatus() === "available"}>
          <button class="btn" onClick={dismissDesktopUpdate}>Later</button>
          <button class="btn btn-primary" onClick={() => void installDesktopUpdate()}>
            Update & relaunch
          </button>
        </Show>
      </aside>
    </Show>
  );
}
