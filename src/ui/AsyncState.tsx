// Consistent loading / error / empty rendering for queries.

import { type JSX, Show } from "solid-js";
import { Icon } from "./Icon";

export function AsyncState(props: {
  loading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: JSX.Element;
}) {
  return (
    <Show
      when={!props.loading}
      fallback={
        <div class="center-state">
          <span class="spinner" />
        </div>
      }
    >
      <Show
        when={!props.error}
        fallback={
          <div class="center-state">
            <Icon name="close" size={28} />
            <p>{props.error instanceof Error ? props.error.message : "Something went wrong."}</p>
          </div>
        }
      >
        <Show
          when={!props.isEmpty}
          fallback={
            <div class="center-state">
              <Icon name="disc" size={28} />
              <p>{props.emptyMessage ?? "Nothing here yet."}</p>
            </div>
          }
        >
          {props.children}
        </Show>
      </Show>
    </Show>
  );
}
