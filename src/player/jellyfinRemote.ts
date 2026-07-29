// Jellyfin remote control.
//
// Registering capabilities and holding a WebSocket to /socket is what makes a
// Jellyfin client appear in the "Play On" list and in Dashboard → Sessions, and
// lets a phone or the web dashboard drive playback here — pause, skip, seek,
// set volume, or push a queue over. Every full-featured Jellyfin client does
// this; without it the app is invisible to the rest of the Jellyfin ecosystem.
//
// The socket is best-effort throughout: a dropped connection retries with
// backoff, and anything unparseable is ignored. Nothing here is load-bearing
// for local playback.

import { createEffect, createRoot, on } from "solid-js";
import { JellyfinClient } from "~/api/jellyfin";
import { client } from "~/auth/session";
import { player } from "./store";

interface SocketMessage {
  MessageType?: string;
  Data?: unknown;
}

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

// Reconnect backoff, capped so a server that's down doesn't get hammered.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

class RemoteChannel {
  private socket: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private jf: JellyfinClient) {}

  async start(): Promise<void> {
    this.closed = false;
    // Tell the server what we can do before opening the channel, so commands
    // sent immediately after connecting are ones we actually support.
    await this.jf.registerCapabilities();
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.retryTimer = undefined;
    this.keepAlive = undefined;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed || typeof WebSocket === "undefined") return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.jf.remoteControlUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retries = 0;
      // Jellyfin expects periodic keep-alives; without them it drops the
      // session and the device disappears from the dashboard.
      this.keepAlive = setInterval(() => this.send("KeepAlive"), 30_000);
    });

    socket.addEventListener("message", (ev) => {
      let msg: SocketMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SocketMessage;
      } catch {
        return;
      }
      this.handle(msg);
    });

    const drop = () => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.keepAlive = undefined;
      if (this.socket === socket) this.socket = null;
      this.scheduleRetry();
    };
    socket.addEventListener("close", drop);
    socket.addEventListener("error", drop);
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retries, RETRY_MAX_MS);
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private send(type: string, data?: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ MessageType: type, Data: data ?? "" }));
    } catch {
      // socket died between the check and the send — the close handler retries
    }
  }

  private handle(msg: SocketMessage): void {
    switch (msg.MessageType) {
      case "ForceKeepAlive":
      case "KeepAlive":
        this.send("KeepAlive");
        return;
      case "Playstate":
        this.handlePlaystate(msg.Data as PlaystateData);
        return;
      case "GeneralCommand":
        this.handleGeneralCommand(msg.Data as GeneralCommandData);
        return;
      case "Play":
        void this.handlePlay(msg.Data as PlayData);
        return;
      default:
        // Library/user/session notifications we don't act on.
        return;
    }
  }

  private handlePlaystate(data: PlaystateData | undefined): void {
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

  private handleGeneralCommand(data: GeneralCommandData | undefined): void {
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
  private async handlePlay(data: PlayData | undefined): Promise<void> {
    const ids = data?.ItemIds ?? [];
    if (ids.length === 0) return;
    const songs = [];
    for (const id of ids) {
      try {
        songs.push(await this.jf.getSong(id));
      } catch {
        // Skip anything we can't resolve (deleted, or not audio).
      }
    }
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
}

// Keep exactly one channel alive, following whichever client is signed in.
export function installJellyfinRemote(): void {
  createRoot(() => {
    let channel: RemoteChannel | null = null;
    createEffect(
      on(client, (c) => {
        channel?.stop();
        channel = null;
        if (c instanceof JellyfinClient) {
          channel = new RemoteChannel(c);
          void channel.start();
        }
      }),
    );
  });
}
