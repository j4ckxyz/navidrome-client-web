// Product identity in one place.
//
// The app started life as a Navidrome-only client, but it now speaks to
// Navidrome (Subsonic/OpenSubsonic) *and* Jellyfin as first-class backends, so
// the name can't be a server's name any more. Everything user-visible and
// everything we announce to a server reads from here — change these constants
// and the whole app, PWA manifest text, and server-side device registration
// follow.

export const APP_NAME = "Tonearm";
export const APP_TAGLINE = "your library, your rules";
export const APP_DESCRIPTION =
  "A modern, desktop-first web client for your Navidrome or Jellyfin music library";
export const APP_VERSION = "1.0.0";

// Identifier announced to Subsonic servers as the `c` parameter. Navidrome
// creates one "player" record per client name and hangs its per-player
// transcoding settings off it, so changing this makes Navidrome mint a fresh
// player entry with its defaults (raw/no transcode) rather than inheriting the
// old one.
export const SUBSONIC_CLIENT = "tonearm";

// Announced to Jellyfin in X-Emby-Authorization. Jellyfin shows this as the
// client name in Dashboard → Devices and in the "Play On" target list.
export const JELLYFIN_CLIENT = "Tonearm";
export const JELLYFIN_DEVICE_NAME = "Browser";
