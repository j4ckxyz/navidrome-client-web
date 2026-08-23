// The "playing on" control: pick this computer, or hand playback to another
// Jellyfin device on the account.
//
// A custom dropdown rather than MenuButton because each row carries two lines
// (device name + what it's playing) and a live state dot, which the shared
// single-line ActionItem list can't express.

import { DropdownMenu } from "@kobalte/core";
import { For, Show, createMemo } from "solid-js";
import { Icon, type IconName } from "~/ui/Icon";
import {
  refreshRemoteDevices,
  remoteControlAvailable,
  remoteDevices,
  remoteDevicesLoaded,
  remoteTarget,
  selectRemoteDevice,
  type RemoteDevice,
} from "~/player/remoteSessions";
import "./devicepicker.css";

// Jellyfin reports a free-text client/device name, not a device class, so the
// icon is a guess from the strings its own clients use. Falls back to a generic
// speaker rather than pretending to know.
function deviceIcon(device: RemoteDevice): IconName {
  const hay = `${device.client} ${device.name}`.toLowerCase();
  if (/(android tv|firetv|fire tv|roku|kodi|webos|tizen|\btv\b|chromecast|shield)/.test(hay)) {
    return "tv";
  }
  if (/(android|ios|iphone|ipad|mobile|phone|finamp)/.test(hay)) return "phone";
  if (/(web|browser|chrome|firefox|safari|edge|desktop|windows|mac|linux)/.test(hay)) {
    return "laptop";
  }
  return "speaker";
}

function subtitle(device: RemoteDevice): string {
  const song = device.nowPlaying;
  if (!song) return device.client || "Idle";
  const line = song.artist ? `${song.title} — ${song.artist}` : song.title;
  return device.isPaused ? `Paused · ${line}` : line;
}

export function DevicePicker() {
  const target = createMemo(() => remoteTarget());
  const devices = createMemo(() => remoteDevices());

  return (
    <Show when={remoteControlAvailable()}>
      <DropdownMenu.Root
        // Not modal: the picker can be opened from inside the full-screen
        // player, where modal mode would aria-hide an ancestor of the focused
        // element (see ToggleMenuButton for the same reasoning).
        modal={false}
        onOpenChange={(open) => {
          // Fill from REST on open so the list is current immediately rather
          // than up to one socket push (~1.5s) stale.
          if (open) void refreshRemoteDevices();
        }}
      >
        <DropdownMenu.Trigger
          class="icon-btn menu-trigger dp-trigger"
          classList={{ active: !!target() }}
          aria-label={target() ? `Playing on ${target()!.name}` : "Play on another device"}
          title={target() ? `Playing on ${target()!.name}` : "Play on another device"}
        >
          <Icon name="cast" size={18} />
          <Show when={target()}>
            <span class="dp-trigger-name">{target()!.name}</span>
          </Show>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="menu-content dp-menu">
            <div class="menu-heading">Play on</div>

            <DropdownMenu.Item
              class="menu-item dp-item"
              classList={{ "dp-item-active": !target() }}
              onSelect={() => selectRemoteDevice(null)}
            >
              <Icon name="laptop" size={17} />
              <span class="dp-item-text">
                <span class="dp-item-name">This computer</span>
                <span class="dp-item-sub muted">Play here</span>
              </span>
              <Show when={!target()}>
                <Icon name="check" size={15} />
              </Show>
            </DropdownMenu.Item>

            <For each={devices()}>
              {(device) => (
                <DropdownMenu.Item
                  class="menu-item dp-item"
                  classList={{ "dp-item-active": target()?.sessionId === device.sessionId }}
                  onSelect={() => selectRemoteDevice(device.sessionId)}
                >
                  <Icon name={deviceIcon(device)} size={17} />
                  <span class="dp-item-text">
                    <span class="dp-item-name">
                      {device.name}
                      <Show when={device.nowPlaying && !device.isPaused}>
                        <span class="dp-playing-dot" aria-label="Playing" />
                      </Show>
                    </span>
                    <span class="dp-item-sub muted">{subtitle(device)}</span>
                  </span>
                  <Show when={target()?.sessionId === device.sessionId}>
                    <Icon name="check" size={15} />
                  </Show>
                </DropdownMenu.Item>
              )}
            </For>

            <Show when={devices().length === 0}>
              <div class="dp-empty muted">
                {remoteDevicesLoaded()
                  ? "No other devices are signed in right now."
                  : "Looking for devices…"}
              </div>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </Show>
  );
}
