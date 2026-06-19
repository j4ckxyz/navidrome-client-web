// Rebindable keyboard shortcuts. Click a binding, then press the desired key
// combination to capture it. Detects and warns on conflicts.

import { createSignal, For, Show } from "solid-js";
import { settings, updateSettings } from "~/settings/store";
import { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, type ShortcutAction } from "~/settings/schema";
import { keyFromEvent } from "~/features/shell/shortcuts";
import { Icon } from "~/ui/Icon";
import "./shortcuts-editor.css";

export function ShortcutsEditor() {
  const [recording, setRecording] = createSignal<ShortcutAction | null>(null);

  function capture(e: KeyboardEvent, action: ShortcutAction) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      return;
    }
    // Ignore lone modifier presses; wait for a real key.
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    const combo = keyFromEvent(e);
    updateSettings((s) => (s.power.shortcuts[action] = combo));
    setRecording(null);
  }

  function conflictFor(action: ShortcutAction): boolean {
    const combo = settings.power.shortcuts[action];
    return (
      (Object.keys(settings.power.shortcuts) as ShortcutAction[]).filter(
        (a) => settings.power.shortcuts[a] === combo,
      ).length > 1
    );
  }

  function resetAll() {
    updateSettings((s) => (s.power.shortcuts = { ...DEFAULT_SHORTCUTS }));
  }

  return (
    <div class="settings-block">
      <div class="settings-block-head">
        <h3 class="settings-block-title">Keyboard shortcuts</h3>
        <button class="btn btn-ghost" onClick={resetAll}>
          Reset to defaults
        </button>
      </div>
      <div class="shortcut-list">
        <For each={Object.keys(SHORTCUT_LABELS) as ShortcutAction[]}>
          {(action) => (
            <div class="shortcut-row">
              <span class="shortcut-label">{SHORTCUT_LABELS[action]}</span>
              <Show when={conflictFor(action)}>
                <span class="shortcut-conflict" title="This key is bound to more than one action">
                  <Icon name="close" size={12} /> conflict
                </span>
              </Show>
              <button
                class="shortcut-key"
                classList={{ "shortcut-key-recording": recording() === action }}
                onClick={() => setRecording(action)}
                onKeyDown={(e) => recording() === action && capture(e, action)}
                onBlur={() => recording() === action && setRecording(null)}
              >
                {recording() === action ? "Press keys…" : settings.power.shortcuts[action]}
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
