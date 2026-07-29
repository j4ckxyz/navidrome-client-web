// The DeviceProfile this client posts to Jellyfin.
//
// Jellyfin decides direct-play vs transcode by matching a media source against
// the profile the client declares. Every real Jellyfin client (jellyfin-web,
// Finamp, Symfonium…) does this negotiation; skipping it and guessing a stream
// URL is what leaves you with a server-side ffmpeg job you didn't want and a
// browser fed a stream it can't seek.
//
// The direct-play list is probed from the browser (see lib/codecs), so Firefox,
// Chrome and Safari each get a profile that matches what they can really
// decode.

import { directPlayContainers, transcodeTarget } from "~/lib/codecs";
import { APP_NAME } from "~/lib/branding";

export type MediaStreamProtocol = "http" | "hls";

export interface DirectPlayProfile {
  Type: "Audio";
  Container: string;
  AudioCodec?: string;
}

export interface TranscodingProfile {
  Type: "Audio";
  Container: string;
  AudioCodec: string;
  Protocol: MediaStreamProtocol;
  Context: "Streaming" | "Static";
  MaxAudioChannels?: string;
  BreakOnNonKeyFrames?: boolean;
  EnableAudioVbrEncoding?: boolean;
}

export interface DeviceProfile {
  Name: string;
  MaxStreamingBitrate: number;
  MusicStreamingTranscodingBitrate: number;
  DirectPlayProfiles: DirectPlayProfile[];
  TranscodingProfiles: TranscodingProfile[];
  ContainerProfiles: unknown[];
  CodecProfiles: unknown[];
  SubtitleProfiles: unknown[];
}

// No cap. Jellyfin treats MaxStreamingBitrate as "the pipe the client has", and
// a self-hosted library on a LAN or a decent connection should not be throttled
// by a number we invented.
const UNCAPPED_BPS = 140_000_000;

export interface ProfileOptions {
  // User's "max bitrate" preference in kbps; 0/undefined means original quality.
  maxBitRateKbps?: number;
  // Force a transcode regardless of direct-play support. Used when the browser
  // has already refused the container (a decode error on the element).
  forceTranscode?: boolean;
}

export function buildDeviceProfile(opts: ProfileOptions = {}): DeviceProfile {
  const target = transcodeTarget();
  const maxBps = opts.maxBitRateKbps ? opts.maxBitRateKbps * 1000 : UNCAPPED_BPS;

  const directPlay: DirectPlayProfile[] = opts.forceTranscode
    ? []
    : directPlayContainers().map((entry) => {
        const [container, codecs] = entry.split("|");
        return {
          Type: "Audio" as const,
          Container: container,
          ...(codecs ? { AudioCodec: codecs } : {}),
        };
      });

  return {
    Name: APP_NAME,
    MaxStreamingBitrate: maxBps,
    // The bitrate Jellyfin encodes to when it *does* have to transcode. Capped
    // by the user's preference when they set one.
    MusicStreamingTranscodingBitrate: Math.min(maxBps, 320_000),
    DirectPlayProfiles: directPlay,
    TranscodingProfiles: [
      {
        Type: "Audio",
        Container: target.container,
        AudioCodec: target.codec,
        // Progressive HTTP, never HLS: an <audio> element can consume a plain
        // progressive stream without a media-source extension shim, and HLS
        // audio-only playlists are a well-known source of gapless/seek grief.
        Protocol: "http",
        Context: "Streaming",
        MaxAudioChannels: "2",
        EnableAudioVbrEncoding: true,
      },
    ],
    ContainerProfiles: [],
    // Deliberately empty: a sample-rate/bit-depth condition here would force a
    // transcode of every hi-res file. Browsers resample 96 kHz/24-bit fine, and
    // when Jellyfin does transcode, its own encoder picks a legal sample rate.
    CodecProfiles: [],
    SubtitleProfiles: [],
  };
}
