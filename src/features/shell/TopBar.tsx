// Top bar: history back/forward and a debounced global search box. Typing
// navigates to /search?q=…; the focus-search shortcut focuses the input.

import { useLocation, useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, on } from "solid-js";
import { Icon } from "~/ui/Icon";
import { focusTick } from "./searchFocus";
import { settings } from "~/settings/store";
import "./topbar.css";

export function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  let inputRef: HTMLInputElement | undefined;

  const [value, setValue] = createSignal<string>(
    location.pathname === "/search" ? String(searchParams.q ?? "") : "",
  );

  let debounce: number | undefined;
  function onInput(v: string) {
    setValue(v);
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      const q = v.trim();
      if (q) navigate(`/search?q=${encodeURIComponent(q)}`, { replace: location.pathname === "/search" });
    }, 280);
  }

  // Focus on shortcut.
  createEffect(
    on(focusTick, (tick) => {
      if (tick > 0) inputRef?.focus();
    }, { defer: true }),
  );

  // Keep the box in sync if the URL query changes externally.
  createEffect(
    on(
      () => (location.pathname === "/search" ? String(searchParams.q ?? "") : ""),
      (q) => {
        if (location.pathname === "/search" && q !== value()) setValue(q);
      },
    ),
  );

  return (
    <header class="topbar">
      <div class="topbar-search">
        <Icon name="search" size={18} class="topbar-search-icon" />
        <input
          ref={inputRef}
          class="topbar-search-input"
          type="search"
          placeholder={`Search  ·  ${settings.power.shortcuts.focusSearch}`}
          value={value()}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const q = value().trim();
              if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
            }
          }}
        />
      </div>
    </header>
  );
}
