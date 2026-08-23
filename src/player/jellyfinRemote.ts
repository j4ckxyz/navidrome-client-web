// Inbound Jellyfin remote control: another client driving playback *here*.
//
// Registering capabilities and holding a socket is what makes a Jellyfin client
// appear in the "Play On" list and in Dashboard → Sessions, and lets a phone or
// the web dashboard pause, skip, seek, set volume, or push a queue over. Every
// full-featured Jellyfin client does this; without it the app is invisible to
// the rest of the Jellyfin ecosystem.
//
// The connection itself lives in jellyfinSocket, shared with remoteSessions —
// the outbound half, where this app drives someone else.

import { JellyfinClient } from "~/api/jellyfin";
import { onSocketMessage, socketClient, type SocketMessage } from "./jellyfinSocket";
import { player } from "./store";

interface PlaystateData {
  Command?: string;
  SeekPositionTicks?: number;
}

interface GeneralCommandData {
  Name?: string;
  Arguments?: Record<string, string>;
}

interface PlayData {
  ItemIds?: string[];
  PlayCommand?: string;
  StartIndex?: number;
  StartPositionTicks?: number;
}

const TICKS_PER_SECOND = 10_000_000;

function handlePlaystate(data: PlaystateData | undefined): void {
  switch (data?.Command) {
    case "PlayPause":
      player.togglePlay();
      break;
    case "Pause":
      if (player.state.isPlaying) player.togglePlay();
      break;
    case "Unpause":
      if (!player.state.isPlaying) player.togglePlay();
      break;
    case "NextTrack":
      player.next();
      break;
    case "PreviousTrack":
      player.previous();
      break;
    case "Stop":
      player.stop();
      break;
    case "Seek":
      if (data.SeekPositionTicks != null) {
        player.seek(data.SeekPositionTicks / TICKS_PER_SECOND);
      }
      break;
    case "Rewind":
      player.seekBy(-15);
      break;
    case "FastForward":
      player.seekBy(15);
      break;
  }
}

function handleGeneralCommand(data: GeneralCommandData | undefined): void {
  const args = data?.Arguments ?? {};
  switch (data?.Name) {
    case "VolumeUp":
      player.changeVolume(0.05);
      break;
    case "VolumeDown":
      player.changeVolume(-0.05);
      break;
    case "SetVolume": {
      const v = Number(args.Volume);
      if (Number.isFinite(v)) player.setVolume(v / 100);
      break;
    }
    case "Mute":
      if (!player.state.muted) player.toggleMute();
      break;
    case "Unmute":
      if (player.state.muted) player.toggleMute();
      break;
    case "ToggleMute":
      player.toggleMute();
      break;
    case "SetRepeatMode": {
      // Jellyfin sends RepeatNone/RepeatAll/RepeatOne; cycle until we match.
      const want =
        args.RepeatMode === "RepeatAll" ? "all" : args.RepeatMode === "RepeatOne" ? "one" : "off";
      for (let i = 0; i < 3 && player.state.repeat !== want; i++) player.cycleRepeat();
      break;
    }
    case "SetShuffleQueue": {
      const want = args.ShuffleMode === "Shuffle";
      if (player.state.shuffle !== want) player.toggleShuffle();
      break;
    }
  }
}

// "Play On": another client pushed us a set of items to play.
async function handlePlay(jf: JellyfinClient, data: PlayData | undefined): Promise<void> {
  const ids = data?.ItemIds ?? [];
  if (ids.length === 0) return;
  // One request for the whole push — a per-id fetch made a 50-track "Play On"
  // fifty round-trips before the first note.
  const songs = await jf.getSongsByIds(ids);
  if (songs.length === 0) return;

  switch (data?.PlayCommand) {
    case "PlayNext":
      player.playNext(songs);
      break;
    case "PlayLast":
      player.addToQueue(songs);
      break;
    default:
      player.playNow(songs, data?.StartIndex ?? 0);
      if (data?.StartPositionTicks) player.seek(data.StartPositionTicks / TICKS_PER_SECOND);
      break;
  }
}

export function installJellyfinRemote(): void {
  onSocketMessage((msg: SocketMessage) => {
    switch (msg.MessageType) {
      case "Playstate":
        handlePlaystate(msg.Data as PlaystateData);
        return;
      case "GeneralCommand":
        handleGeneralCommand(msg.Data as GeneralCommandData);
        return;
      case "Play": {
        const jf = socketClient();
        if (jf) void handlePlay(jf, msg.Data as PlayData);
        return;
      }
      default:
        // Library/user/session notifications handled elsewhere or ignored.
        return;
    }
  });
}
