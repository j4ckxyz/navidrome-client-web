// Shared menu primitives over Kobalte (accessible, keyboard-navigable). The same
// action list renders as a right-click context menu (RowContextMenu) and as a
// "..." dropdown (MenuButton), so behavior stays consistent.

import { ContextMenu, DropdownMenu } from "@kobalte/core";
import { For, Show, type JSX } from "solid-js";
import { Icon, type IconName } from "./Icon";
import "./menu.css";

export interface ActionItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}

function renderItems<T extends { Item: any; Separator: any }>(
  api: T,
  items: ActionItem[],
): JSX.Element {
  return (
    <For each={items}>
      {(item) => (
        <>
          <Show when={item.separatorBefore}>
            <api.Separator class="menu-separator" />
          </Show>
          <api.Item
            class={`menu-item ${item.danger ? "menu-item-danger" : ""}`}
            onSelect={item.onSelect}
            disabled={item.disabled}
          >
            <Show when={item.icon}>
              <Icon name={item.icon!} size={15} />
            </Show>
            <span>{item.label}</span>
          </api.Item>
        </>
      )}
    </For>
  );
}

export function MenuButton(props: {
  items: ActionItem[];
  label?: string;
  class?: string;
  icon?: IconName;
  iconSize?: number;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class={`icon-btn menu-trigger ${props.class ?? ""}`}
        aria-label={props.label ?? "More actions"}
      >
        <Icon name={props.icon ?? "more"} size={props.iconSize ?? 18} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="menu-content">
          {renderItems(DropdownMenu, props.items)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface ToggleItem {
  label: string;
  icon?: IconName;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

// A dropdown of checkbox toggles. Unlike MenuButton, selecting an item flips it
// in place and keeps the menu open, so several options can be changed at once.
export function ToggleMenuButton(props: {
  items: ToggleItem[];
  label?: string;
  class?: string;
  icon?: IconName;
  iconSize?: number;
  heading?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class={`icon-btn menu-trigger ${props.class ?? ""}`}
        aria-label={props.label ?? "Options"}
        title={props.label}
      >
        <Icon name={props.icon ?? "sliders"} size={props.iconSize ?? 18} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="menu-content">
          <Show when={props.heading}>
            <div class="menu-heading">{props.heading}</div>
          </Show>
          <For each={props.items}>
            {(item) => (
              <DropdownMenu.CheckboxItem
                class="menu-item menu-item-toggle"
                checked={item.checked}
                onChange={item.onChange}
                closeOnSelect={false}
              >
                <Show when={item.icon}>
                  <Icon name={item.icon!} size={15} />
                </Show>
                <span class="menu-item-label">{item.label}</span>
                <DropdownMenu.ItemIndicator class="menu-check" forceMount>
                  <Show when={item.checked}>
                    <Icon name="check" size={15} />
                  </Show>
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function RowContextMenu(props: { items: ActionItem[]; children: JSX.Element }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger as="div" class="ctx-trigger">
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="menu-content">
          {renderItems(ContextMenu, props.items)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
