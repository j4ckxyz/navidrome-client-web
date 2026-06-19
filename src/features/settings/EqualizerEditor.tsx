// Equalizer settings: a 10-band graphic EQ with built-in + user presets, a
// pre-amp, and vertical per-band sliders. All state lives in the settings store
// (so it persists and is restored on launch); changes are pushed live to the
// audio engine via player.syncEqualizer().

import { createMemo, createSignal, For, Show } from "solid-js";
import { settings, updateSettings } from "~/settings/store";
import { player } from "~/player/store";
import {
  EQ_BAND_COUNT,
  EQ_BAND_LABELS,
  EQ_GAIN_LIMIT,
  EQ_PRESETS,
  type EqualizerPreset,
} from "~/settings/schema";
import { proxyMode, serverConfig } from "~/lib/serverConfig";
import { Toggle } from "./controls";
import { Icon } from "~/ui/Icon";
import "./equalizer.css";

function gainsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function EqualizerEditor() {
  const eq = () => settings.playback.equalizer;
  const [savePresetName, setSavePresetName] = createSignal("");
  const [eqError, setEqError] = createSignal(false);

  // The active preset's display id: a built-in/user id, or "custom" when the
  // live gains don't match any saved preset.
  const activePreset = createMemo(() => eq().preset);

  // Push the current settings to the engine and surface a CORS failure.
  function apply() {
    const ok = player.syncEqualizer();
    setEqError(!ok && eq().enabled);
  }

  function setEnabled(on: boolean) {
    updateSettings((s) => (s.playback.equalizer.enabled = on));
    apply();
  }

  // Detect which preset (if any) the current gains+preamp match, so editing a
  // band flips the selector to "Custom".
  function reconcilePresetLabel(gains: number[], preampDb: number) {
    const builtin = EQ_PRESETS.find((p) => gainsEqual(p.gains, gains));
    const user = settings.playback.equalizer.userPresets.find((p) => gainsEqual(p.gains, gains));
    // Pre-amp is not part of preset identity except for "flat", so any non-zero
    // pre-amp with otherwise-flat bands still reads as a custom curve.
    if (preampDb === 0 && builtin) return builtin.id;
    if (preampDb === 0 && user) return user.id;
    return "custom";
  }

  function setBand(index: number, value: number) {
    updateSettings((s) => {
      const e = s.playback.equalizer;
      e.gains[index] = value;
      e.preset = reconcilePresetLabel(e.gains, e.preampDb);
    });
    apply();
  }

  function setPreamp(value: number) {
    updateSettings((s) => {
      const e = s.playback.equalizer;
      e.preampDb = value;
      e.preset = reconcilePresetLabel(e.gains, e.preampDb);
    });
    apply();
  }

  function applyPreset(id: string) {
    const builtin = EQ_PRESETS.find((p) => p.id === id);
    const user = settings.playback.equalizer.userPresets.find((p) => p.id === id);
    const source = builtin ?? user;
    if (!source) return;
    updateSettings((s) => {
      s.playback.equalizer.gains = [...source.gains];
      s.playback.equalizer.preset = id;
      if (builtin?.id === "flat") s.playback.equalizer.preampDb = 0;
    });
    apply();
  }

  function resetFlat() {
    updateSettings((s) => {
      s.playback.equalizer.gains = new Array(EQ_BAND_COUNT).fill(0);
      s.playback.equalizer.preampDb = 0;
      s.playback.equalizer.preset = "flat";
    });
    apply();
  }

  function saveUserPreset(e: Event) {
    e.preventDefault();
    const name = savePresetName().trim();
    if (!name) return;
    const preset: EqualizerPreset = {
      id: `eq-${Date.now()}`,
      name,
      gains: [...settings.playback.equalizer.gains],
    };
    updateSettings((s) => {
      s.playback.equalizer.userPresets.push(preset);
      s.playback.equalizer.preset = preset.id;
    });
    setSavePresetName("");
  }

  function deleteUserPreset(id: string, e: Event) {
    e.stopPropagation();
    updateSettings((s) => {
      s.playback.equalizer.userPresets = s.playback.equalizer.userPresets.filter((p) => p.id !== id);
      if (s.playback.equalizer.preset === id) s.playback.equalizer.preset = "custom";
    });
  }

  // Warn only when EQ is on AND we're not same-origin (proxy mode), since that's
  // when createMediaElementSource can produce silence without server CORS.
  const showCorsHint = createMemo(
    () => eq().enabled && serverConfig() !== null && !proxyMode(),
  );

  return (
    <div class="settings-block eq-block">
      <div class="settings-block-head">
        <h3 class="settings-block-title">Equalizer</h3>
        <Toggle
          label="Enable equalizer"
          checked={eq().enabled}
          onChange={setEnabled}
        />
      </div>

      <Show when={!player.equalizerAvailable()}>
        <p class="muted settings-hint">
          This browser doesn't support the Web Audio API, so the equalizer is unavailable.
        </p>
      </Show>

      <Show when={eqError()}>
        <p class="eq-warning">
          <Icon name="volume-mute" size={15} />
          The equalizer couldn't tap the audio stream. If playback is silent, turn it off
          and reload — see the note below.
        </p>
      </Show>

      <Show when={showCorsHint()}>
        <p class="muted settings-hint eq-cors-hint">
          The equalizer routes audio through Web Audio, which needs CORS-clean streams.
          It works automatically when this client runs in proxy mode (same origin). In
          direct mode your Navidrome server must send <code>Access-Control-Allow-Origin</code>;
          otherwise audio may go silent and you'll need to reload after disabling.
        </p>
      </Show>

      <fieldset class="eq-body" disabled={!eq().enabled} aria-disabled={!eq().enabled}>
        <div class="eq-controls-row">
          <label class="eq-preset-select">
            <span>Preset</span>
            <select
              class="input settings-select"
              value={activePreset()}
              onChange={(e) => applyPreset(e.currentTarget.value)}
            >
              <Show when={activePreset() === "custom"}>
                <option value="custom">Custom</option>
              </Show>
              <optgroup label="Built-in">
                <For each={EQ_PRESETS}>{(p) => <option value={p.id}>{p.name}</option>}</For>
              </optgroup>
              <Show when={settings.playback.equalizer.userPresets.length > 0}>
                <optgroup label="My presets">
                  <For each={settings.playback.equalizer.userPresets}>
                    {(p) => <option value={p.id}>{p.name}</option>}
                  </For>
                </optgroup>
              </Show>
            </select>
          </label>
          <button class="btn btn-ghost eq-reset" onClick={resetFlat} type="button">
            <Icon name="repeat" size={14} /> Reset
          </button>
        </div>

        <div class="eq-graph">
          <div class="eq-band eq-band-preamp">
            <input
              type="range"
              class="eq-slider"
              min={-EQ_GAIN_LIMIT}
              max={EQ_GAIN_LIMIT}
              step={1}
              value={eq().preampDb}
              aria-label="Pre-amp"
              onInput={(e) => setPreamp(Number(e.currentTarget.value))}
            />
            <span class="eq-band-value">{fmt(eq().preampDb)}</span>
            <span class="eq-band-label">Pre</span>
          </div>

          <div class="eq-divider" />

          <For each={EQ_BAND_LABELS}>
            {(label, i) => (
              <div class="eq-band">
                <input
                  type="range"
                  class="eq-slider"
                  min={-EQ_GAIN_LIMIT}
                  max={EQ_GAIN_LIMIT}
                  step={1}
                  value={eq().gains[i()] ?? 0}
                  aria-label={`${label} Hz band`}
                  onInput={(e) => setBand(i(), Number(e.currentTarget.value))}
                />
                <span class="eq-band-value">{fmt(eq().gains[i()] ?? 0)}</span>
                <span class="eq-band-label">{label}</span>
              </div>
            )}
          </For>
        </div>

        <form class="eq-save-row" onSubmit={saveUserPreset}>
          <input
            class="input"
            placeholder="Save current curve as… (e.g. My Headphones)"
            value={savePresetName()}
            onInput={(e) => setSavePresetName(e.currentTarget.value)}
          />
          <button class="btn btn-primary" type="submit" disabled={!savePresetName().trim()}>
            <Icon name="plus" size={15} /> Save preset
          </button>
        </form>

        <Show when={settings.playback.equalizer.userPresets.length > 0}>
          <div class="eq-user-presets">
            <For each={settings.playback.equalizer.userPresets}>
              {(p) => (
                <button
                  type="button"
                  class="eq-user-chip"
                  classList={{ "eq-user-chip-active": activePreset() === p.id }}
                  onClick={() => applyPreset(p.id)}
                >
                  {p.name}
                  <span
                    class="eq-user-chip-del"
                    role="button"
                    aria-label={`Delete preset ${p.name}`}
                    onClick={(e) => deleteUserPreset(p.id, e)}
                  >
                    <Icon name="close" size={12} />
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </fieldset>
    </div>
  );
}

function fmt(db: number): string {
  return db > 0 ? `+${db}` : `${db}`;
}
