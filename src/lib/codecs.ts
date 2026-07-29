// What this browser can actually decode.
//
// Two very different consumers need the same answer, and they used to disagree:
//   - the player, deciding whether a track needs transcoding at all;
//   - the Jellyfin device profile, which tells the server exactly which
//     containers/codecs to hand over untouched (direct play) instead of
//     re-encoding.
//
// Getting that list wrong is expensive in both directions: claim support you
// don't have and playback dies, understate it and every track goes through
// ffmpeg for no reason. So probe once with canPlayType and cache the result.

export interface CodecProbe {
  mp3: boolean;
  aac: boolean; // AAC in an MP4/M4A container
  alac: boolean; // Apple Lossless (Safari)
  flac: boolean;
  oggFlac: boolean;
  vorbis: boolean;
  opus: boolean;
  webmOpus: boolean;
  webmVorbis: boolean;
  wav: boolean;
}

// canPlayType returns "probably" | "maybe" | "". Treat "maybe" as yes: browsers
// answer "maybe" whenever they can't be certain without the codecs parameter,
// and for the containers below that uncertainty is almost always a yes.
function can(el: HTMLAudioElement, type: string): boolean {
  try {
    return el.canPlayType(type) !== "";
  } catch {
    return false;
  }
}

let cached: CodecProbe | null = null;

export function probeCodecs(): CodecProbe {
  if (cached) return cached;

  // No DOM (SSR, tests): assume the conservative universal baseline.
  if (typeof document === "undefined") {
    return {
      mp3: true,
      aac: true,
      alac: false,
      flac: false,
      oggFlac: false,
      vorbis: false,
      opus: false,
      webmOpus: false,
      webmVorbis: false,
      wav: true,
    };
  }

  const el = document.createElement("audio");
  cached = {
    mp3: can(el, "audio/mpeg"),
    aac: can(el, 'audio/mp4; codecs="mp4a.40.2"') || can(el, "audio/aac"),
    alac: can(el, 'audio/mp4; codecs="alac"'),
    flac: can(el, "audio/flac") || can(el, 'audio/mp4; codecs="flac"'),
    oggFlac: can(el, 'audio/ogg; codecs="flac"'),
    vorbis: can(el, 'audio/ogg; codecs="vorbis"'),
    opus: can(el, 'audio/ogg; codecs="opus"'),
    webmOpus: can(el, 'audio/webm; codecs="opus"'),
    webmVorbis: can(el, 'audio/webm; codecs="vorbis"'),
    wav: can(el, 'audio/wav; codecs="1"') || can(el, "audio/wav"),
  };
  return cached;
}

// Containers this browser can play, in Jellyfin's `container|codec,codec`
// notation, ordered best-quality-first. This is exactly the `container` query
// parameter of /Audio/{id}/universal and the DirectPlayProfile list we post in
// a DeviceProfile — the server matches a source against it and only transcodes
// what isn't on the list.
export function directPlayContainers(): string[] {
  const p = probeCodecs();
  const out: string[] = [];

  // Lossless first: if the browser can take the original bit-for-bit, say so.
  if (p.flac) out.push("flac");
  if (p.oggFlac) out.push("ogg|flac");
  if (p.wav) out.push("wav");
  if (p.alac) out.push("m4a|alac", "mp4|alac");

  if (p.opus) out.push("opus", "ogg|opus");
  if (p.webmOpus) out.push("webm|opus", "webma|opus");
  if (p.vorbis) out.push("ogg|vorbis");
  if (p.webmVorbis) out.push("webm|vorbis", "webma|vorbis");

  if (p.aac) out.push("m4a|aac", "m4b|aac", "mp4|aac", "aac");
  if (p.mp3) out.push("mp3");

  // Every browser we support plays at least one of these; the fallback keeps a
  // headless/odd environment from advertising an empty profile (which would
  // make Jellyfin transcode everything).
  return out.length > 0 ? out : ["mp3", "m4a|aac"];
}

// Preferred transcode target when the source genuinely can't be direct-played.
// Opus in an Ogg container beats MP3 on quality per bit and handles >2 channels
// and high sample rates without the resampling MP3 forces; MP3 is the fallback
// for browsers (older Safari) that won't decode it.
export function transcodeTarget(): { container: string; codec: string } {
  const p = probeCodecs();
  if (p.opus) return { container: "ogg", codec: "opus" };
  if (p.aac) return { container: "ts", codec: "aac" };
  return { container: "mp3", codec: "mp3" };
}

// Normalise the many spellings a server can use for a container into the key we
// probe on. Jellyfin reports Container as e.g. "mp3", "flac", "mp4,m4a";
// Subsonic reports a file suffix; both can also hand us a MIME content type.
export function normalizeContainer(raw?: string): string {
  if (!raw) return "";
  const first = raw.split(",")[0].trim().toLowerCase();
  // Strip a MIME type down to its meaningful half ("audio/x-flac" → "flac").
  const bare = first.includes("/") ? first.split("/")[1].replace(/^x-/, "") : first;
  switch (bare) {
    case "mpeg":
    case "mpeg3":
    case "mp3":
      return "mp3";
    case "mp4":
    case "m4a":
    case "m4b":
    case "aac":
      return "m4a";
    case "oga":
    case "ogg":
      return "ogg";
    case "opus":
      return "opus";
    case "flac":
      return "flac";
    case "wav":
    case "wave":
      return "wav";
    case "webm":
    case "webma":
      return "webm";
    default:
      return bare;
  }
}

// Can the browser play this container/codec pair as-is? Used by the player to
// decide whether to ask the server for a transcode.
export function canPlayContainer(container?: string, codec?: string): boolean {
  const c = normalizeContainer(container);
  const k = normalizeContainer(codec);
  const p = probeCodecs();
  switch (c) {
    case "mp3":
      return p.mp3;
    case "m4a":
      // ALAC lives in the same container as AAC, so the codec decides.
      if (k === "alac") return p.alac;
      return p.aac;
    case "flac":
      return p.flac;
    case "ogg":
      if (k === "opus") return p.opus;
      if (k === "flac") return p.oggFlac;
      return p.vorbis || p.opus;
    case "opus":
      return p.opus;
    case "wav":
      return p.wav;
    case "webm":
      return p.webmOpus || p.webmVorbis;
    // Formats no browser decodes natively.
    case "ape":
    case "wv":
    case "dsf":
    case "dff":
    case "wma":
    case "aiff":
    case "aif":
    case "mpc":
    case "shn":
    case "tta":
      return false;
    default:
      // Unknown container: let the element try rather than forcing a transcode.
      return true;
  }
}
