// Applies the active theme + layout density to CSS custom properties on the
// document root. Everything visual reads from these vars, which is what makes
// per-region theming live and cheap.

import { createEffect, type ParentProps } from "solid-js";
import { settings } from "~/settings/store";
import type { Density, Settings, ThemeColors } from "~/settings/schema";
import { PRESET_COLORS } from "~/settings/schema";
import { adjustL, derivePalette, isDark, readableText } from "./colors";

// The colors actually in effect, accounting for preset vs custom and simple vs
// advanced customization.
export function resolveColors(theme: Settings["theme"]): ThemeColors {
  if (theme.preset !== "custom") {
    return PRESET_COLORS[theme.preset];
  }
  if (theme.customizationMode === "simple") {
    return derivePalette(theme.base, theme.colors.accent);
  }
  return theme.colors;
}

const DENSITY_SCALE: Record<Density, { row: string; gap: string; pad: string }> = {
  compact: { row: "34px", gap: "8px", pad: "10px" },
  comfortable: { row: "44px", gap: "14px", pad: "16px" },
  spacious: { row: "56px", gap: "22px", pad: "24px" },
};

export function applyTheme(colors: ThemeColors, base: "dark" | "light", density: Density): void {
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);

  set("--accent", colors.accent);
  set("--accent-text", colors.accentText);
  set("--accent-hover", adjustL(colors.accent, isDark(colors.accent) ? 0.06 : -0.06));
  set("--sidebar-bg", colors.sidebarBg);
  set("--sidebar-text", colors.sidebarText);
  set("--content-bg", colors.contentBg);
  set("--content-text", colors.contentText);
  set("--text-muted", colors.textMuted);
  set("--surface", colors.surface);
  set("--now-playing-bg", colors.nowPlayingBg);

  // Derived states so we don't expose extra knobs.
  const dark = isDark(colors.contentBg);
  set("--surface-hover", adjustL(colors.surface, dark ? 0.04 : -0.03));
  set("--surface-active", adjustL(colors.surface, dark ? 0.08 : -0.06));
  set("--border", adjustL(colors.surface, dark ? 0.07 : -0.08));
  set("--sidebar-text-muted", adjustL(colors.sidebarText, dark ? -0.22 : 0.22));
  set("--on-accent", readableText(colors.accent));

  const d = DENSITY_SCALE[density];
  set("--row-height", d.row);
  set("--gap", d.gap);
  set("--pad", d.pad);

  // Helps native form controls and scrollbars match.
  root.style.colorScheme = base === "dark" ? "dark" : "light";
  root.dataset.base = base;
}

export function ThemeProvider(props: ParentProps) {
  createEffect(() => {
    const colors = resolveColors(settings.theme);
    // Effective base: presets carry their own light/dark feel; for custom we
    // honor the chosen base.
    const base =
      settings.theme.preset === "light"
        ? "light"
        : settings.theme.preset === "custom"
          ? settings.theme.base
          : isDark(colors.contentBg)
            ? "dark"
            : "light";
    applyTheme(colors, base, settings.layout.density);
    document.documentElement.dataset.cover = settings.layout.coverArtSize;
  });

  return <>{props.children}</>;
}
