// The Jellyfin WebSocket channel, shared by both directions of remote control.
//
// Jellyfin's /socket is bidirectional and there is only ever one per device:
//   - inbound  (player/jellyfinRemote) — another client drives playback here
//   - outbound (player/remoteSessions) — this app drives another client, and
//     subscribes to Sessions pushes so it can mirror that device's state
//
// Opening a second connection would register a second session against the same
// device id and make the app flicker in and out of Jellyfin's device list, so
// this module owns the one socket and fans messages out to both.
//
// Everything here is best-effort: a dropped connection retries with backoff and
// anything unparseable is ignored. Nothing is load-bearing for local playback.

import { createEffect, createRoot, createSignal, on } from "solid-js";
import { JellyfinClient } from "~/api/jellyfin";
import { client } from "~/auth/session";
import { log } from "~/lib/log";

export interface SocketMessage {
  MessageType?: string;
  Data?: unknown;
}

// Reconnect backoff, capped so a server that's down doesn't get hammered.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const KEEPALIVE_MS = 30_000;

type MessageHandler = (msg: SocketMessage) => void;
type OpenHandler = () => void;

const messageHandlers = new Set<MessageHandler>();
const openHandlers = new Set<OpenHandler>();

const [connected, setConnected] = createSignal(false);
// The client the live socket belongs to. Null whenever the signed-in backend
// isn't Jellyfin, which is what gates the whole remote-control feature.
const [socketClient, setSocketClient] = createSignal<JellyfinClient | null>(null);

export { connected as socketConnected, socketClient };

class SocketChannel {
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
    setConnected(false);
  }

  send(type: string, data?: unknown): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify({ MessageType: type, Data: data ?? "" }));
      return true;
    } catch {
      // Socket died between the check and the send — the close handler retries.
      return false;
    }
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
      setConnected(true);
      log.info("jellyfin-socket", "connected");
      // Jellyfin expects periodic keep-alives; without them it drops the
      // session and the device disappears from the dashboard.
      this.keepAlive = setInterval(() => this.send("KeepAlive"), KEEPALIVE_MS);
      // Subscriptions (e.g. Sessions) live on the connection, not the server,
      // so every reconnect has to re-establish them.
      for (const handler of openHandlers) {
        try {
          handler();
        } catch {
          // A broken subscriber must not take the socket down with it.
        }
      }
    });

    socket.addEventListener("message", (ev) => {
      let msg: SocketMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SocketMessage;
      } catch {
        return;
      }
      // Answer the server's liveness probes here so no subscriber has to.
      if (msg.MessageType === "ForceKeepAlive" || msg.MessageType === "KeepAlive") {
        this.send("KeepAlive");
        return;
      }
      for (const handler of messageHandlers) {
        try {
          handler(msg);
        } catch {
          // Same: one subscriber's failure is not the channel's problem.
        }
      }
    });

    const drop = () => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.keepAlive = undefined;
      if (this.socket === socket) {
        this.socket = null;
        setConnected(false);
      }
      this.scheduleRetry();
    };
    socket.addEventListener("close", drop);
    socket.addEventListener("error", drop);
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retries, RETRY_MAX_MS);
    this.retries++;
    log.warn("jellyfin-socket", `disconnected; retrying in ${delay}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }
}

let channel: SocketChannel | null = null;

// Subscribe to every message the server pushes. Returns an unsubscribe.
export function onSocketMessage(handler: MessageHandler): () => void {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

// Run on every (re)connect, to re-establish connection-scoped subscriptions.
// Fires immediately if the socket is already open.
export function onSocketOpen(handler: OpenHandler): () => void {
  openHandlers.add(handler);
  if (connected()) handler();
  return () => openHandlers.delete(handler);
}

// Send a message. False means the socket wasn't open, so the caller should fall
// back to REST rather than assume it landed.
export function sendSocket(type: string, data?: unknown): boolean {
  return channel?.send(type, data) ?? false;
}

// Keep exactly one channel alive, following whichever client is signed in.
export function installJellyfinSocket(): void {
  createRoot(() => {
    createEffect(
      on(client, (c) => {
        channel?.stop();
        channel = null;
        setSocketClient(c instanceof JellyfinClient ? c : null);
        if (c instanceof JellyfinClient) {
          channel = new SocketChannel(c);
          void channel.start();
        }
      }),
    );
  });
}
