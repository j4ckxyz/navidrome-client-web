// Appearance settings: presets, simple/advanced customization across the nine
// themeable regions, and theme sharing via a short code + QR.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { settings, updateSettings } from "~/settings/store";
import {
  PRESET_COLORS,
  THEME_REGION_LABELS,
  type ThemeColors,
  type ThemePreset,
} from "~/settings/schema";
import { resolveColors } from "~/theme/provider";
import { encodeTheme, decodeTheme } from "~/theme/share";
import { Icon } from "~/ui/Icon";
import "./theme-editor.css";

const PRESETS: { id: Exclude<ThemePreset, "custom">; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "midnight", label: "Midnight" },
  { id: "warm", label: "Warm" },
  { id: "mono", label: "Mono" },
  { id: "apple-music", label: "Apple Music" },
  { id: "spotify", label: "Spotify" },
];

function ColorField(props: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = createSignal(props.value);
  return (
    <div class="color-field">
      <input
        type="color"
        class="color-swatch"
        value={props.value}
        onInput={(e) => {
          setText(e.currentTarget.value);
          props.onChange(e.currentTarget.value);
        }}
        aria-label={props.label}
      />
      <div class="color-field-body">
        <span class="color-field-label">{props.label}</span>
        <input
          class="input color-field-hex"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onChange={(e) => {
            const v = e.currentTarget.value.trim();
            if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
              const hex = v.startsWith("#") ? v : `#${v}`;
              setText(hex);
              props.onChange(hex);
            } else {
              setText(props.value);
            }
          }}
        />
      </div>
    </div>
  );
}

export function ThemeEditor() {
  const effective = createMemo(() => resolveColors(settings.theme));

  const [newPresetName, setNewPresetName] = createSignal("");

  function applyPreset(id: string) {
    const userPreset = settings.theme.userPresets?.find((p) => p.id === id);
    if (userPreset) {
      updateSettings((s) => {
        s.theme.preset = id;
        s.theme.colors = { ...userPreset.colors };
        s.theme.base = userPreset.base;
      });
      return;
    }
    const stdId = id as Exclude<ThemePreset, "custom">;
    if (PRESET_COLORS[stdId]) {
      updateSettings((s) => {
        s.theme.preset = stdId;
        s.theme.colors = { ...PRESET_COLORS[stdId] };
        s.theme.base = stdId === "light" || stdId === "apple-music" ? "light" : "dark";
      });
    }
  }

  function savePreset(e: Event) {
    e.preventDefault();
    const name = newPresetName().trim();
    if (!name) return;
    const colors = { ...effective() };
    const base = settings.theme.preset === "custom" ? settings.theme.base : (settings.theme.preset === "light" ? "light" : "dark");
    const id = `user-${Date.now()}`;
    
    updateSettings((s) => {
      if (!s.theme.userPresets) {
        s.theme.userPresets = [];
      }
      s.theme.userPresets.push({ id, name, colors, base });
      s.theme.preset = id;
    });
    setNewPresetName("");
  }

  function deletePreset(id: string, e: Event) {
    e.stopPropagation();
    updateSettings((s) => {
      s.theme.userPresets = (s.theme.userPresets || []).filter((p) => p.id !== id);
      if (s.theme.preset === id) {
        s.theme.preset = "dark";
        s.theme.colors = { ...PRESET_COLORS.dark };
      }
    });
  }

  // Move to custom editing, seeding from whatever is currently effective.
  function goCustom(mode: "simple" | "advanced") {
    updateSettings((s) => {
      const seed = resolveColors(s.theme);
      s.theme.preset = "custom";
      s.theme.customizationMode = mode;
      s.theme.colors = { ...seed };
    });
  }

  function setColor(region: keyof ThemeColors, hex: string) {
    updateSettings((s) => {
      if (s.theme.preset !== "custom" && !s.theme.preset.startsWith("user-")) {
        s.theme.colors = { ...resolveColors(s.theme) };
        s.theme.preset = "custom";
      }
      s.theme.colors[region] = hex;
    });
  }

  function setBase(base: "dark" | "light") {
    updateSettings((s) => {
      s.theme.preset = "custom";
      s.theme.base = base;
    });
  }

  const isCustom = () => settings.theme.preset === "custom";
  const mode = () => settings.theme.customizationMode;

  // Apple Music ships a light and a dark variant; the grid shows a single card
  // and a Light/Dark switch toggles between the two preset color sets.
  const isApplePreset = () =>
    settings.theme.preset === "apple-music" || settings.theme.preset === "apple-music-dark";

  // --- Theme sharing ---
  const [shareName, setShareName] = createSignal("My theme");
  const [qrDataUrl, setQrDataUrl] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [importCode, setImportCode] = createSignal("");
  const [importError, setImportError] = createSignal("");

  const shareCode = createMemo(() => encodeTheme({ name: shareName(), colors: effective() }));

  // Regenerate the QR whenever the code changes.
  createEffect(() => {
    const code = shareCode();
    QRCode.toDataURL(code, { margin: 1, width: 220 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(""));
  });

  function copyCode() {
    navigator.clipboard.writeText(shareCode()).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  }

  function applyImportedCode(code: string) {
    try {
      const theme = decodeTheme(code);
      updateSettings((s) => {
        s.theme.preset = "custom";
        s.theme.customizationMode = "advanced";
        s.theme.colors = { ...theme.colors };
      });
      setImportError("");
      setImportCode("");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Invalid theme code");
    }
  }

  async function importFromImage(file: File) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("Could not read image"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(data.data, data.width, data.height);
      if (!result) throw new Error("No QR code found in image");
      applyImportedCode(result.data);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Could not decode QR image");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div class="settings-section">
      <div class="settings-block">
        <h3 class="settings-block-title">Presets</h3>
        <div class="preset-grid">
          <For each={PRESETS}>
            {(p) => (
              <div
                class="preset-card"
                role="button"
                tabindex="0"
                classList={{
                  "preset-card-active":
                    p.id === "apple-music" ? isApplePreset() : settings.theme.preset === p.id,
                }}
                onClick={() => applyPreset(p.id === "apple-music" && isApplePreset() ? settings.theme.preset : p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    applyPreset(p.id === "apple-music" && isApplePreset() ? settings.theme.preset : p.id);
                  }
                }}
              >
                <div class="preset-swatches">
                  <span style={{ background: PRESET_COLORS[p.id].sidebarBg }} />
                  <span style={{ background: PRESET_COLORS[p.id].contentBg }} />
                  <span style={{ background: PRESET_COLORS[p.id].surface }} />
                  <span style={{ background: PRESET_COLORS[p.id].accent }} />
                </div>
                <span class="preset-label">{p.label}</span>
                <Show when={p.id === "apple-music" ? isApplePreset() : settings.theme.preset === p.id}>
                  <span class="preset-check"><Icon name="check" size={14} /></span>
                </Show>
              </div>
            )}
          </For>

          <For each={settings.theme.userPresets || []}>
            {(p) => (
              <div
                class="preset-card"
                role="button"
                tabindex="0"
                classList={{ "preset-card-active": settings.theme.preset === p.id }}
                onClick={() => applyPreset(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    applyPreset(p.id);
                  }
                }}
              >
                <div class="preset-swatches">
                  <span style={{ background: p.colors.sidebarBg }} />
                  <span style={{ background: p.colors.contentBg }} />
                  <span style={{ background: p.colors.surface }} />
                  <span style={{ background: p.colors.accent }} />
                </div>
                <span class="preset-label">{p.name}</span>
                <Show when={settings.theme.preset === p.id}>
                  <span class="preset-check"><Icon name="check" size={14} /></span>
                </Show>
                <button
                  class="preset-card-delete"
                  onClick={(e) => deletePreset(p.id, e)}
                  aria-label={`Delete preset ${p.name}`}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )}
          </For>
        </div>

        <Show when={isApplePreset()}>
          <div class="apple-variant-row">
            <span>Appearance</span>
            <div class="segmented">
              <button
                classList={{ "segmented-on": settings.theme.preset === "apple-music" }}
                onClick={() => applyPreset("apple-music")}
              >
                Light
              </button>
              <button
                classList={{ "segmented-on": settings.theme.preset === "apple-music-dark" }}
                onClick={() => applyPreset("apple-music-dark")}
              >
                Dark
              </button>
            </div>
          </div>
        </Show>

        <Show when={settings.theme.preset === "custom"}>
          <form onSubmit={savePreset} class="save-preset-row">
            <input
              class="input preset-name-input"
              placeholder="Preset name (e.g. Neon)"
              value={newPresetName()}
              onInput={(e) => setNewPresetName(e.currentTarget.value)}
              required
            />
            <button class="btn btn-primary" type="submit" disabled={!newPresetName().trim()}>
              Save preset
            </button>
          </form>
        </Show>
      </div>

      <div class="settings-block">
        <div class="settings-block-head">
          <h3 class="settings-block-title">Customization</h3>
          <div class="segmented">
            <button
              classList={{ "segmented-on": isCustom() && mode() === "simple" }}
              onClick={() => goCustom("simple")}
            >
              Simple
            </button>
            <button
              classList={{ "segmented-on": isCustom() && mode() === "advanced" }}
              onClick={() => goCustom("advanced")}
            >
              Advanced
            </button>
          </div>
        </div>

        <Show
          when={isCustom()}
          fallback={
            <p class="muted settings-hint">
              Using the <strong>{settings.theme.preset}</strong> preset. Switch to Simple or Advanced
              to customize.
            </p>
          }
        >
          <Show
            when={mode() === "simple"}
            fallback={
              <div class="color-grid">
                <For each={Object.keys(THEME_REGION_LABELS) as (keyof ThemeColors)[]}>
                  {(region) => (
                    <ColorField
                      label={THEME_REGION_LABELS[region]}
                      value={settings.theme.colors[region]}
                      onChange={(hex) => setColor(region, hex)}
                    />
                  )}
                </For>
              </div>
            }
          >
            <div class="simple-theme">
              <div class="settings-row">
                <span>Base</span>
                <div class="segmented">
                  <button
                    classList={{ "segmented-on": settings.theme.base === "dark" }}
                    onClick={() => setBase("dark")}
                  >
                    Dark
                  </button>
                  <button
                    classList={{ "segmented-on": settings.theme.base === "light" }}
                    onClick={() => setBase("light")}
                  >
                    Light
                  </button>
                </div>
              </div>
              <ColorField
                label="Accent color"
                value={settings.theme.colors.accent}
                onChange={(hex) => setColor("accent", hex)}
              />
              <p class="muted settings-hint">
                The rest of the palette is derived from your base and accent, with contrast kept
                readable.
              </p>
            </div>
          </Show>
        </Show>
      </div>

      <div class="settings-block">
        <h3 class="settings-block-title">Share theme</h3>
        <div class="share-grid">
          <div class="share-left">
            <div class="field">
              <label>Theme name</label>
              <input class="input" value={shareName()} onInput={(e) => setShareName(e.currentTarget.value)} />
            </div>
            <div class="field">
              <label>Share code</label>
              <div class="share-code-row">
                <input class="input share-code" readonly value={shareCode()} />
                <button class="btn" onClick={copyCode}>
                  <Icon name={copied() ? "check" : "share"} size={16} /> {copied() ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </div>
          <Show when={qrDataUrl()}>
            <div class="share-qr">
              <img src={qrDataUrl()} alt="Theme QR code" width={140} height={140} />
              <span class="muted">Scan to share</span>
            </div>
          </Show>
        </div>

        <div class="field" style={{ "margin-top": "16px" }}>
          <label>Import a theme</label>
          <div class="share-code-row">
            <input
              class="input"
              placeholder="Paste ndtheme:… code"
              value={importCode()}
              onInput={(e) => setImportCode(e.currentTarget.value)}
            />
            <button class="btn btn-primary" onClick={() => applyImportedCode(importCode())} disabled={!importCode().trim()}>
              Apply
            </button>
            <label class="btn share-upload">
              <Icon name="plus" size={16} /> QR image
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) importFromImage(f);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <Show when={importError()}>
            <span class="share-error">{importError()}</span>
          </Show>
        </div>
      </div>
    </div>
  );
}
