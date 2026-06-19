// Accessible range slider built on a native <input type="range"> (keyboard +
// screen-reader support for free), styled with a theme-colored fill.

import "./slider.css";

export function Slider(props: {
  value: number;
  min?: number;
  max: number;
  step?: number;
  onInput: (v: number) => void;
  onChange?: (v: number) => void;
  ariaLabel: string;
  class?: string;
}) {
  const min = () => props.min ?? 0;
  const pct = () => {
    const range = props.max - min();
    if (range <= 0) return 0;
    return ((props.value - min()) / range) * 100;
  };

  return (
    <input
      type="range"
      class={`slider ${props.class ?? ""}`}
      style={{ "--fill": `${pct()}%` }}
      min={min()}
      max={props.max}
      step={props.step ?? 1}
      value={props.value}
      aria-label={props.ariaLabel}
      onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      onChange={(e) => props.onChange?.(Number(e.currentTarget.value))}
    />
  );
}
