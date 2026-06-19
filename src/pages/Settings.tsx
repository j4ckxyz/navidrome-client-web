// Settings — organised into Appearance, Layout, Playback, and Advanced so depth
// doesn't overwhelm. Theme regions, layout density, playback behaviour, power-user
// controls, a debug panel, and settings export/import/reset all live here.

import { createSignal, Show } from "solid-js";
import { settings, updateSettings, resetSettings, exportSettings, importSettings } from "~/settings/store";
import { player } from "~/player/store";
import { ThemeEditor } from "~/features/settings/ThemeEditor";
import { EqualizerEditor } from "~/features/settings/EqualizerEditor";
import { ShortcutsEditor } from "~/features/settings/ShortcutsEditor";
import { Row, Toggle, SelectField, RangeField } from "~/features/settings/controls";
import { DebugPanel } from "~/features/settings/DebugPanel";
import { Icon } from "~/ui/Icon";
import "./settings.css";

type Tab = "appearance" | "layout" | "playback" | "advanced";
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { id: "appearance", label: "Appearance", icon: "settings" },
  { id: "layout", label: "Layout", icon: "list" },
  { id: "playback", label: "Playback", icon: "play" },
  { id: "advanced", label: "Advanced", icon: "trending" },
];

export default function Settings() {
  const [tab, setTab] = createSignal<Tab>("appearance");
  const [importMsg, setImportMsg] = createSignal<{ ok: boolean; text: string } | null>(null);

  function doExport() {
    const blob = new Blob([exportSettings()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "navidrome-web-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doImport(file: File) {
    const text = await file.text();
    const result = importSettings(text);
    setImportMsg(
      result.ok
        ? { ok: true, text: "Settings imported." }
        : { ok: false, text: result.error ?? "Import failed." },
    );
    window.setTimeout(() => setImportMsg(null), 4000);
  }

  return (
    <div class="page settings-page">
      <h1 class="page-title">Settings</h1>

      <div class="settings-layout">
        <nav class="settings-tabs">
          {TABS.map((t) => (
            <button
              class="settings-tab"
              classList={{ "settings-tab-active": tab() === t.id }}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        <div class="settings-content">
          {/* Appearance */}
          <Show when={tab() === "appearance"}>
            <ThemeEditor />
          </Show>

          {/* Layout */}
          <Show when={tab() === "layout"}>
            <div class="settings-block">
              <h3 class="settings-block-title">Layout</h3>
              <Row label="Density" hint="Row height and spacing throughout the app">
                <SelectField
                  value={settings.layout.density}
                  options={[
                    { value: "compact", label: "Compact" },
                    { value: "comfortable", label: "Comfortable" },
                    { value: "spacious", label: "Spacious" },
                  ]}
                  onChange={(v) => updateSettings((s) => (s.layout.density = v))}
                />
              </Row>
              <Row label="Cover art size" hint="Tile size in grids and carousels">
                <SelectField
                  value={settings.layout.coverArtSize}
                  options={[
                    { value: "small", label: "Small" },
                    { value: "medium", label: "Medium" },
                    { value: "large", label: "Large" },
                  ]}
                  onChange={(v) => updateSettings((s) => (s.layout.coverArtSize = v))}
                />
              </Row>
              <Row label="Default landing page" hint="Where the app opens">
                <SelectField
                  value={settings.layout.defaultLanding}
                  options={[
                    { value: "home", label: "Home" },
                    { value: "albums", label: "Albums" },
                    { value: "artists", label: "Artists" },
                    { value: "recently-added", label: "Recently added" },
                    { value: "recently-played", label: "Recently played" },
                  ]}
                  onChange={(v) => updateSettings((s) => (s.layout.defaultLanding = v))}
                />
              </Row>
              <Row label="Show queue panel by default">
                <Toggle
                  label="Show queue panel"
                  checked={settings.layout.showQueuePanel}
                  onChange={(v) => updateSettings((s) => (s.layout.showQueuePanel = v))}
                />
              </Row>
              <Row label="Show lyrics panel by default">
                <Toggle
                  label="Show lyrics panel"
                  checked={settings.layout.showLyricsPanel}
                  onChange={(v) => updateSettings((s) => (s.layout.showLyricsPanel = v))}
                />
              </Row>
            </div>
          </Show>

          {/* Playback */}
          <Show when={tab() === "playback"}>
            <div class="settings-block">
              <h3 class="settings-block-title">Playback</h3>
              <Row label="Default volume">
                <RangeField
                  value={settings.playback.defaultVolume}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(v) => updateSettings((s) => (s.playback.defaultVolume = v))}
                />
              </Row>
              <Row label="Crossfade" hint="Fade between tracks; 0 disables">
                <RangeField
                  value={settings.playback.crossfadeSeconds}
                  min={0}
                  max={12}
                  suffix="s"
                  onChange={(v) => {
                    updateSettings((s) => (s.playback.crossfadeSeconds = v));
                    player.syncCrossfade();
                  }}
                />
              </Row>
              <Row label="Gapless playback" hint="Preload the next track to minimise gaps">
                <Toggle
                  label="Gapless"
                  checked={settings.playback.gapless}
                  onChange={(v) => updateSettings((s) => (s.playback.gapless = v))}
                />
              </Row>
              <Row label="Scrobble plays" hint="Report play counts and now-playing to the server">
                <Toggle
                  label="Scrobble"
                  checked={settings.playback.scrobble}
                  onChange={(v) => updateSettings((s) => (s.playback.scrobble = v))}
                />
              </Row>
              <Row label="Volume normalization" hint="Use ReplayGain tags to even out loudness">
                <SelectField
                  value={settings.playback.replayGain.mode}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "track", label: "Per track" },
                    { value: "album", label: "Per album" },
                  ]}
                  onChange={(v) => updateSettings((s) => (s.playback.replayGain.mode = v))}
                />
              </Row>
              <Show when={settings.playback.replayGain.mode !== "off"}>
                <Row label="Normalization pre-amp">
                  <RangeField
                    value={settings.playback.replayGain.preAmpDb}
                    min={-12}
                    max={12}
                    suffix=" dB"
                    onChange={(v) => updateSettings((s) => (s.playback.replayGain.preAmpDb = v))}
                  />
                </Row>
              </Show>
              <Row label="Max streaming bitrate" hint="Transcode above this; 0 streams original">
                <SelectField
                  value={String(settings.playback.maxBitRate)}
                  options={[
                    { value: "0", label: "Original" },
                    { value: "320", label: "320 kbps" },
                    { value: "256", label: "256 kbps" },
                    { value: "192", label: "192 kbps" },
                    { value: "128", label: "128 kbps" },
                  ]}
                  onChange={(v) => updateSettings((s) => (s.playback.maxBitRate = Number(v)))}
                />
              </Row>
              <Row label="Resume queue on launch" hint="Reload the last queue when you reopen the app">
                <Toggle
                  label="Resume queue"
                  checked={settings.playback.resumeQueueOnLaunch}
                  onChange={(v) => updateSettings((s) => (s.playback.resumeQueueOnLaunch = v))}
                />
              </Row>
            </div>

            <EqualizerEditor />
          </Show>

          {/* Advanced */}
          <Show when={tab() === "advanced"}>
            <ShortcutsEditor />

            <div class="settings-block">
              <h3 class="settings-block-title">Performance</h3>
              <Row label="Prefetch next track" hint="Start loading the next track early">
                <Toggle
                  label="Prefetch"
                  checked={settings.power.prefetch.enabled}
                  onChange={(v) => updateSettings((s) => (s.power.prefetch.enabled = v))}
                />
              </Row>
              <Row label="Cover art cache" hint="Browser cache budget for artwork">
                <RangeField
                  value={settings.power.coverArtCacheMB}
                  min={0}
                  max={500}
                  step={25}
                  suffix=" MB"
                  onChange={(v) => updateSettings((s) => (s.power.coverArtCacheMB = v))}
                />
              </Row>
              <Row label="Now-playing poll interval" hint="How often live playback state refreshes">
                <RangeField
                  value={settings.power.polling.nowPlayingMs / 1000}
                  min={1}
                  max={30}
                  suffix="s"
                  onChange={(v) => updateSettings((s) => (s.power.polling.nowPlayingMs = v * 1000))}
                />
              </Row>
              <Row label="Library cache lifetime" hint="How long fetched library data stays fresh">
                <RangeField
                  value={settings.power.polling.libraryStaleMs / 60000}
                  min={1}
                  max={60}
                  suffix=" min"
                  onChange={(v) => updateSettings((s) => (s.power.polling.libraryStaleMs = v * 60000))}
                />
              </Row>
            </div>

            <div class="settings-block">
              <h3 class="settings-block-title">Developer</h3>
              <Row label="Debug panel" hint="Show API inspector below">
                <Toggle
                  label="Debug panel"
                  checked={settings.power.developer.debugPanel}
                  onChange={(v) => updateSettings((s) => (s.power.developer.debugPanel = v))}
                />
              </Row>
              <Row label="Log level">
                <SelectField
                  value={settings.power.developer.logLevel}
                  options={[
                    { value: "silent", label: "Silent" },
                    { value: "error", label: "Error" },
                    { value: "info", label: "Info" },
                    { value: "debug", label: "Debug" },
                  ]}
                  onChange={(v) => updateSettings((s) => (s.power.developer.logLevel = v))}
                />
              </Row>
              <Show when={settings.power.developer.debugPanel}>
                <DebugPanel />
              </Show>
            </div>

            <div class="settings-block">
              <h3 class="settings-block-title">Backup & reset</h3>
              <p class="muted settings-hint">
                Export your settings (theme, layout, shortcuts) to a JSON file. Credentials are never
                included.
              </p>
              <div class="settings-actions">
                <button class="btn" onClick={doExport}>
                  <Icon name="share" size={16} /> Export settings
                </button>
                <label class="btn">
                  <Icon name="plus" size={16} /> Import settings
                  <input
                    type="file"
                    accept="application/json"
                    hidden
                    onChange={(e) => {
                      const f = e.currentTarget.files?.[0];
                      if (f) doImport(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
                <button
                  class="btn"
                  onClick={() => {
                    if (confirm("Reset all settings to defaults? This won't log you out.")) {
                      resetSettings();
                      player.syncCrossfade();
                      player.syncEqualizer();
                    }
                  }}
                >
                  <Icon name="trash" size={16} /> Reset to defaults
                </button>
              </div>
              <Show when={importMsg()}>
                <p class="settings-import-msg" classList={{ "settings-import-err": !importMsg()!.ok }}>
                  {importMsg()!.text}
                </p>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
