// Small reusable settings controls: labelled rows with a toggle, select, or
// range. Keeps the settings panels consistent and uncluttered.

import { For, type JSX, Show } from "solid-js";

export function Row(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <span class="settings-row-label">{props.label}</span>
        <Show when={props.hint}>
          <span class="settings-row-hint muted">{props.hint}</span>
        </Show>
      </div>
      <div class="settings-row-control">{props.children}</div>
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      class="toggle"
      classList={{ "toggle-on": props.checked }}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-knob" />
    </button>
  );
}

export function SelectField<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select class="input settings-select" value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as T)}>
      <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
    </select>
  );
}

export function RangeField(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div class="settings-range">
      <input
        type="range"
        class="slider"
        style={{ "--fill": `${((props.value - props.min) / (props.max - props.min)) * 100}%` }}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
      />
      <span class="settings-range-value">
        {props.value}
        {props.suffix ?? ""}
      </span>
    </div>
  );
}
