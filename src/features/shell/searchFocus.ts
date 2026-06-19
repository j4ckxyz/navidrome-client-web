// Tiny cross-component signal so the "focus search" keyboard shortcut can reach
// the search input in the top bar without prop drilling.

import { createSignal } from "solid-js";

const [focusTick, setFocusTick] = createSignal(0);

export { focusTick };
export function requestSearchFocus(): void {
  setFocusTick((n) => n + 1);
}
