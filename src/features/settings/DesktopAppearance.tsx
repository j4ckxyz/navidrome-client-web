import { For } from "solid-js";
import { settings, updateSettings } from "~/settings/store";
import type { AppIconVariant } from "~/settings/schema";

const APP_ICONS: readonly { id: AppIconVariant; label: string }[] = [
  { id: "ocean", label: "Ocean" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
  { id: "amber", label: "Amber" },
];

export function DesktopAppearance() {
  let picker!: HTMLDivElement;

  function chooseIcon(id: AppIconVariant): void {
    updateSettings((current) => (current.desktop.appIcon = id));
  }

  function moveSelection(event: KeyboardEvent, index: number): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % APP_ICONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + APP_ICONS.length) % APP_ICONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = APP_ICONS.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    const next = APP_ICONS[nextIndex];
    chooseIcon(next.id);
    picker.querySelector<HTMLElement>(`[data-app-icon="${next.id}"]`)?.focus();
  }

  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Desktop app icon</h3>
      <p class="muted settings-hint">
        Same Tonearm record, different colour. Your choice appears in the Dock on macOS and the
        running app icon on Windows.
      </p>
      <div
        ref={picker}
        class="app-icon-picker"
        role="radiogroup"
        aria-label="Desktop app icon"
      >
        <For each={APP_ICONS}>
          {(icon, index) => (
            <button
              class="app-icon-choice"
              classList={{ "app-icon-choice-active": settings.desktop.appIcon === icon.id }}
              role="radio"
              aria-checked={settings.desktop.appIcon === icon.id}
              tabIndex={settings.desktop.appIcon === icon.id ? 0 : -1}
              data-app-icon={icon.id}
              onClick={() => chooseIcon(icon.id)}
              onKeyDown={(event) => moveSelection(event, index())}
            >
              <img src={`/icons/app-icons/${icon.id}.png`} alt="" width="56" height="56" />
              <span>{icon.label}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
