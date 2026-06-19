import { Dialog } from "@kobalte/core";
import { createSignal, For } from "solid-js";
import { settings } from "~/settings/store";
import { SHORTCUT_LABELS, type ShortcutAction } from "~/settings/schema";
import { Icon } from "~/ui/Icon";
import "./shortcutsHelp.css";

export const [showShortcuts, setShowShortcuts] = createSignal(false);

interface ShortcutGroup {
  title: string;
  actions: ShortcutAction[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Playback",
    actions: ["playPause", "next", "previous", "seekForward", "seekBackward", "toggleShuffle", "toggleRepeat", "starCurrent"],
  },
  {
    title: "Volume",
    actions: ["volumeUp", "volumeDown", "toggleMute"],
  },
  {
    title: "Application",
    actions: ["focusSearch", "toggleQueue", "toggleLyrics"],
  },
];

export function ShortcutsHelpDialog() {
  return (
    <Dialog.Root open={showShortcuts()} onOpenChange={setShowShortcuts}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Dialog.Content class="dialog-content sh-dialog">
            <div class="dialog-header">
              <Dialog.Title class="dialog-title sh-title">
                <Icon name="keyboard" size={20} class="sh-title-icon" /> Keyboard Shortcuts
              </Dialog.Title>
              <Dialog.CloseButton class="icon-btn">
                <Icon name="close" size={18} />
              </Dialog.CloseButton>
            </div>

            <div class="sh-body">
              <For each={GROUPS}>
                {(group) => (
                  <div class="sh-group">
                    <h3 class="sh-group-title">{group.title}</h3>
                    <div class="sh-list">
                      <For each={group.actions}>
                        {(action) => {
                          const binding = () => settings.power.shortcuts[action];
                          return (
                            <div class="sh-item">
                              <span class="sh-label">{SHORTCUT_LABELS[action]}</span>
                              <kbd class="sh-kbd">{binding() || "None"}</kbd>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
            
            <div class="sh-footer muted">
              Press <kbd class="sh-kbd">?</kbd> again or click outside to dismiss.
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
