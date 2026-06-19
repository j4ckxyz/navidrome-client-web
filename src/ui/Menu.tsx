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
              <Icon name={item.icon!} size={16} />
            </Show>
            <span>{item.label}</span>
          </api.Item>
        </>
      )}
    </For>
  );
}

export function MenuButton(props: { items: ActionItem[]; label?: string; class?: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class={`icon-btn menu-trigger ${props.class ?? ""}`}
        aria-label={props.label ?? "More actions"}
      >
        <Icon name="more" size={18} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="menu-content">
          {renderItems(DropdownMenu, props.items)}
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
