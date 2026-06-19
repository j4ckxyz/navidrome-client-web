// The full settings schema. This is the single source of truth for everything
// the user can configure. It is persisted to localStorage under `nd:settings`,
// namespaced separately from credentials, and is what export/import serializes.

export const SETTINGS_VERSION = 1 as const;

export type ThemePreset = "dark" | "light" | "midnight" | "warm" | "mono" | "custom";
export type CustomizationMode = "simple" | "advanced";

// The nine deliberate, documented themeable regions. Dividers/borders are
// derived from `surface` rather than exposed as a tenth knob.
export interface ThemeColors {
  accent: string; // active states, progress, primary buttons
  accentText: string; // text/icons drawn on top of accent
  sidebarBg: string;
  sidebarText: string;
  contentBg: string;
  contentText: string;
  textMuted: string; // secondary text in both regions
  surface: string; // cards, panels, menus, dividers (derived)
  nowPlayingBg: string;
}

export const THEME_REGION_LABELS: Record<keyof ThemeColors, string> = {
  accent: "Accent",
  accentText: "Accent text",
  sidebarBg: "Sidebar background",
  sidebarText: "Sidebar text",
  contentBg: "Content background",
  contentText: "Content text",
  textMuted: "Muted text",
  surface: "Surface (cards, menus)",
  nowPlayingBg: "Now-playing bar",
};

export type Density = "compact" | "comfortable" | "spacious";
export type CoverArtSize = "small" | "medium" | "large";
export type LandingPage =
  | "home"
  | "albums"
  | "artists"
  | "playlists"
  | "recently-added"
  | "recently-played";

export type ReplayGainMode = "off" | "track" | "album";
export type LogLevel = "silent" | "error" | "info" | "debug";

// Rebindable playback/navigation actions.
export type ShortcutAction =
  | "playPause"
  | "next"
  | "previous"
  | "seekForward"
  | "seekBackward"
  | "volumeUp"
  | "volumeDown"
  | "toggleMute"
  | "toggleQueue"
  | "toggleLyrics"
  | "focusSearch"
  | "toggleShuffle"
  | "toggleRepeat"
  | "starCurrent";

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  playPause: "Play / pause",
  next: "Next track",
  previous: "Previous track",
  seekForward: "Seek forward",
  seekBackward: "Seek backward",
  volumeUp: "Volume up",
  volumeDown: "Volume down",
  toggleMute: "Mute / unmute",
  toggleQueue: "Toggle queue panel",
  toggleLyrics: "Toggle lyrics panel",
  focusSearch: "Focus search",
  toggleShuffle: "Toggle shuffle",
  toggleRepeat: "Cycle repeat mode",
  starCurrent: "Star current track",
};

export interface UserPreset {
  id: string;
  name: string;
  colors: ThemeColors;
  base: "dark" | "light";
}

export interface Settings {
  version: typeof SETTINGS_VERSION;

  theme: {
    preset: string; // "dark" | "light" | "midnight" | "warm" | "mono" | "custom" or user preset ID
    customizationMode: CustomizationMode;
    base: "dark" | "light"; // simple-mode base the neutrals derive from
    colors: ThemeColors;
    userPresets: UserPreset[];
  };

  layout: {
    density: Density;
    coverArtSize: CoverArtSize;
    showQueuePanel: boolean;
    showLyricsPanel: boolean;
    showSidebar: boolean;
    defaultLanding: LandingPage;
  };

  playback: {
    defaultVolume: number; // 0–100
    crossfadeSeconds: number; // 0 = off, max 12
    gapless: boolean;
    scrobble: boolean;
    replayGain: { mode: ReplayGainMode; preAmpDb: number };
    resumeQueueOnLaunch: boolean;
    maxBitRate: number; // 0 = original
  };

  power: {
    shortcuts: Record<ShortcutAction, string>;
    prefetch: { enabled: boolean; nextTrackCount: number };
    coverArtCacheMB: number;
    polling: { nowPlayingMs: number; libraryStaleMs: number };
    developer: { debugPanel: boolean; showRawApiResponses: boolean; logLevel: LogLevel };
    featureFlags: Record<string, boolean>;
  };
}

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  playPause: "Space",
  next: "Ctrl+ArrowRight",
  previous: "Ctrl+ArrowLeft",
  seekForward: "ArrowRight",
  seekBackward: "ArrowLeft",
  volumeUp: "ArrowUp",
  volumeDown: "ArrowDown",
  toggleMute: "m",
  toggleQueue: "q",
  toggleLyrics: "l",
  focusSearch: "/",
  toggleShuffle: "s",
  toggleRepeat: "r",
  starCurrent: "f",
};

// Dark is the default theme given the use case.
export const DARK_COLORS: ThemeColors = {
  accent: "#e6a14c", // warm amber — record-collection feel, not streaming-green
  accentText: "#1a1410",
  sidebarBg: "#16130f",
  sidebarText: "#ece6dd",
  contentBg: "#1c1813",
  contentText: "#f2ece2",
  textMuted: "#9b9384",
  surface: "#262017",
  nowPlayingBg: "#120f0b",
};

export const LIGHT_COLORS: ThemeColors = {
  accent: "#b9762a",
  accentText: "#fdfaf4",
  sidebarBg: "#efe9df",
  sidebarText: "#2a2520",
  contentBg: "#faf6ee",
  contentText: "#241f19",
  textMuted: "#736b5e",
  surface: "#ffffff",
  nowPlayingBg: "#e7e0d3",
};

export const PRESET_COLORS: Record<Exclude<ThemePreset, "custom">, ThemeColors> = {
  dark: DARK_COLORS,
  light: LIGHT_COLORS,
  midnight: {
    accent: "#7aa2f7",
    accentText: "#0b0f1a",
    sidebarBg: "#0d1017",
    sidebarText: "#c8d3f5",
    contentBg: "#11141c",
    contentText: "#e3e9ff",
    textMuted: "#7c84a3",
    surface: "#1a1e2b",
    nowPlayingBg: "#090b12",
  },
  warm: {
    accent: "#d96846",
    accentText: "#fff6ef",
    sidebarBg: "#241a16",
    sidebarText: "#f3e3d8",
    contentBg: "#2b201a",
    contentText: "#fbeee4",
    textMuted: "#b3937f",
    surface: "#372a22",
    nowPlayingBg: "#1c1410",
  },
  mono: {
    accent: "#d6d6d6",
    accentText: "#161616",
    sidebarBg: "#141414",
    sidebarText: "#e8e8e8",
    contentBg: "#1a1a1a",
    contentText: "#f0f0f0",
    textMuted: "#8a8a8a",
    surface: "#242424",
    nowPlayingBg: "#0f0f0f",
  },
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  theme: {
    preset: "dark",
    customizationMode: "simple",
    base: "dark",
    colors: DARK_COLORS,
    userPresets: [],
  },
  layout: {
    density: "comfortable",
    coverArtSize: "medium",
    showQueuePanel: false,
    showLyricsPanel: false,
    showSidebar: true,
    defaultLanding: "home",
  },
  playback: {
    defaultVolume: 80,
    crossfadeSeconds: 0,
    gapless: true,
    scrobble: true,
    replayGain: { mode: "off", preAmpDb: 0 },
    resumeQueueOnLaunch: true,
    maxBitRate: 0,
  },
  power: {
    shortcuts: { ...DEFAULT_SHORTCUTS },
    prefetch: { enabled: true, nextTrackCount: 1 },
    coverArtCacheMB: 100,
    polling: { nowPlayingMs: 5000, libraryStaleMs: 300000 },
    developer: { debugPanel: false, showRawApiResponses: false, logLevel: "error" },
    featureFlags: {},
  },
};
