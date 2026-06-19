// The settings store: a Solid store persisted to localStorage under `nd:settings`
// (namespaced away from credentials). Provides export/import (credentials are
// never included) and reset-to-defaults.

import { createStore, produce, reconcile } from "solid-js/store";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type Settings,
} from "./schema";

const STORAGE_KEY = "nd:settings";

// Deep-merge persisted settings onto defaults so new fields added in later
// versions are filled in rather than left undefined.
function mergeWithDefaults(stored: unknown): Settings {
  const base: Settings = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== "object") return base;
  deepMerge(base as unknown as Record<string, unknown>, stored as Record<string, unknown>);
  base.version = SETTINGS_VERSION;
  return base;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined) {
      target[key] = sv;
    }
  }
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return mergeWithDefaults(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

const [settings, setSettings] = createStore<Settings>(load());

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to persist settings", e);
  }
}

// Apply a mutation via Solid's produce, then persist.
export function updateSettings(mutator: (s: Settings) => void): void {
  setSettings(produce(mutator));
  persist();
}

export function resetSettings(): void {
  setSettings(reconcile(structuredClone(DEFAULT_SETTINGS)));
  persist();
}

export interface ImportResult {
  ok: boolean;
  error?: string;
}

// Validate then apply an imported settings JSON string. Credentials are not part
// of the schema, so they can never be imported.
export function importSettings(json: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "File does not contain a settings object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    return { ok: false, error: "Missing settings version — is this a settings export?" };
  }
  // Structural sanity check on the major sections.
  for (const section of ["theme", "layout", "playback", "power"]) {
    if (obj[section] !== undefined && typeof obj[section] !== "object") {
      return { ok: false, error: `Invalid '${section}' section` };
    }
  }
  const merged = mergeWithDefaults(parsed);
  setSettings(reconcile(merged));
  persist();
  return { ok: true };
}

export function exportSettings(): string {
  // Snapshot, stripping any accidental non-schema keys to guarantee no
  // credentials ever leak into an export.
  const clean: Settings = mergeWithDefaults(JSON.parse(JSON.stringify(settings)));
  return JSON.stringify(clean, null, 2);
}

export { settings };
