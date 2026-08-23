// Outbound Jellyfin remote control: this app driving *another* device.
//
// The mirror of jellyfinRemote. Every Jellyfin client that holds a socket —
// the phone app, a TV, another browser tab, this app on the desktop — shows up
// in /Sessions, and any of them can be driven by posting commands against its
// session id. That's what makes "playing on the living room speakers, queued
// from this laptop" work.
//
// This module owns three things and deliberately nothing else:
//   - the live list of controllable devices
//   - which one is currently the target (null = play here)
//   - the outbound command senders
//
// It knows nothing about the player store; the store imports *this* and does
// the mirroring, so the dependency stays one-way and there's no import cycle.

import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import type { JfSessionInfo } from "~/api/jellyfin";
import type { Song } from "~/api/types";
import { onSocketMessage, onSocketOpen, sendSocket, socketClient } from "./jellyfinSocket";

const TARGET_KEY = "nd:remote-target";

// How often the server pushes Sessions updates over the socket, and the floor
// under which a device that has gone quiet is treated as gone. Jellyfin keeps
// dead sessions listed for a while, which would leave ghosts in the picker.
const SESSIONS_PUSH_MS = 1_500;
const STALE_AFTER_MS = 5 * 60_000;

export interface RemoteDevice {
  sessionId: string;
  deviceId: string;
  name: string;
  client: string;
  userName: string;
  supportedCommands: string[];
  nowPlaying?: Song;
  positionSeconds: number;
  isPaused: boolean;
  isMuted: boolean;
  volume: number; // 0..1
  canSeek: boolean;
  repeat: "off" | "all" | "one";
  shuffle: boolean;
  queueIds: string[];
}

const [devices, setDevices] = createSignal<RemoteDevice[]>([]);
const [targetId, setTargetId] = createSignal<string | null>(loadTarget());
// True once a Sessions payload has arrived, so the picker can tell "no other
// devices" apart from "haven't looked yet".
const [loaded, setLoaded] = createSignal(false);

export { devices as remoteDevices, loaded as remoteDevicesLoaded };

// The device being driven right now, or null when playback is local. Derived
// from the live list so it refreshes with every push — and so a device that
// disappears resolves to null on its own.
export const remoteTarget = createMemo<RemoteDevice | null>(() => {
  const id = targetId();
  if (!id) return null;
  return devices().find((d) => d.sessionId === id) ?? null;
});

// Whether remote control is available at all: Jellyfin only, since the Subsonic
// API has no concept of a session or another device to hand off to.
export const remoteControlAvailable = createMemo(() => socketClient() !== null);

function loadTarget(): string | null {
  try {
    return localStorage.getItem(TARGET_KEY) || null;
  } catch {
    return null;
  }
}

// Pick a device to play on, or null to come back to this computer. The player
// store watches this and performs the actual handoff.
export function selectRemoteDevice(sessionId: string | null): void {
  setTargetId(sessionId);
  try {
    if (sessionId) localStorage.setItem(TARGET_KEY, sessionId);
    else localStorage.removeItem(TARGET_KEY);
  } catch {
    // Private mode — the choice just won't survive a refresh.
  }
}

function repeatFrom(mode: string | undefined): "off" | "all" | "one" {
  return mode === "RepeatAll" ? "all" : mode === "RepeatOne" ? "one" : "off";
}

const TICKS_PER_SECOND = 10_000_000;

function toDevice(s: JfSessionInfo): RemoteDevice | null {
  const jf = socketClient();
  if (!s.Id || !jf) return null;
  const state = s.PlayState ?? {};
  return {
    sessionId: s.Id,
    deviceId: s.DeviceId ?? "",
    name: s.DeviceName || s.Client || "Unknown device",
    client: s.Client ?? "",
    userName: s.UserName ?? "",
    supportedCommands: s.SupportedCommands ?? [],
    nowPlaying: s.NowPlayingItem ? jf.songFromItem(s.NowPlayingItem) : undefined,
    positionSeconds: (state.PositionTicks ?? 0) / TICKS_PER_SECOND,
    isPaused: state.IsPaused ?? false,
    isMuted: state.IsMuted ?? false,
    volume: (state.VolumeLevel ?? 100) / 100,
    canSeek: state.CanSeek ?? false,
    repeat: repeatFrom(state.RepeatMode),
    shuffle: state.PlaybackOrder === "Shuffle",
    queueIds: (s.NowPlayingQueue ?? []).map((q) => q.Id ?? "").filter(Boolean),
  };
}

// A session is worth showing when it isn't us, can actually be driven, and
// plays audio. Video-only clients would accept the command and do nothing.
function isControllable(s: JfSessionInfo, myDeviceId: string): boolean {
  if (!s.Id || !s.SupportsRemoteControl) return false;
  if (s.DeviceId && s.DeviceId === myDeviceId) return false;
  if (!(s.SupportedCommands ?? []).length) return false;
  const types = s.PlayableMediaTypes ?? [];
  if (types.length && !types.some((t) => t.toLowerCase() === "audio")) return false;
  if (s.LastActivityDate) {
    const age = Date.now() - new Date(s.LastActivityDate).getTime();
    if (Number.isFinite(age) && age > STALE_AFTER_MS) return false;
  }
  return true;
}

function ingest(sessions: JfSessionInfo[]): void {
  const jf = socketClient();
  if (!jf) return;
  const mine = jf.myDeviceId;
  const list = sessions
    .filter((s) => isControllable(s, mine))
    .map(toDevice)
    .filter((d): d is RemoteDevice => d !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  setDevices(list);
  setLoaded(true);
}

// Fetch the list over REST. Used when the picker opens so it fills instantly
// rather than waiting up to SESSIONS_PUSH_MS for the next socket push.
export async function refreshRemoteDevices(): Promise<void> {
  const jf = socketClient();
  if (!jf) return;
  try {
    ingest(await jf.getSessions());
  } catch {
    // Server down or user lacks permission — leave the last known list.
  }
}

// --- Command senders ---------------------------------------------------------
//
// All of these no-op when there is no target, which is what lets the player
// store call them unconditionally on the remote path.

function target(): RemoteDevice | null {
  return remoteTarget();
}

// Commands are fire-and-forget requests, so two issued close together — a
// volume slider being dragged, a double-tapped skip — can reach the server out
// of order and leave the device in a state the user never asked for. Chaining
// them costs nothing at human speed and guarantees the device sees the
// sequence that was actually performed.
let commandChain: Promise<unknown> = Promise.resolve();

function enqueue(send: () => Promise<unknown>): void {
  commandChain = commandChain.then(
    () => send().catch(() => {}),
    () => send().catch(() => {}),
  );
}

export function remotePlaystate(command: string, seekPositionTicks?: number): void {
  const jf = socketClient();
  const t = target();
  if (!jf || !t) return;
  enqueue(() => jf.sessionPlaystate(t.sessionId, command, seekPositionTicks));
}

export function remoteCommand(name: string, args?: Record<string, string>): void {
  const jf = socketClient();
  const t = target();
  if (!jf || !t) return;
  // Advertising is honest on Jellyfin clients: if a device didn't list the
  // command, sending it anyway just produces a silent no-op on that device.
  if (t.supportedCommands.length && !t.supportedCommands.includes(name)) return;
  enqueue(() => jf.sessionCommand(t.sessionId, name, args));
}

export function remotePlay(
  songs: Song[],
  playCommand: "PlayNow" | "PlayNext" | "PlayLast",
  opts: { startIndex?: number } = {},
): void {
  const jf = socketClient();
  const t = target();
  if (!jf || !t) return;
  // Only library tracks can be pushed: a device resolves them from the server
  // by id, so live radio (which carries its own stream URL) can't travel.
  const ids = songs.filter((s) => !s.isRadio).map((s) => s.id);
  if (ids.length === 0) return;
  enqueue(() => jf.sessionPlay(t.sessionId, ids, playCommand, opts));
}

// Whether the target advertises a command, for greying out controls it would
// silently ignore.
export function remoteSupports(command: string): boolean {
  const t = target();
  if (!t) return false;
  return t.supportedCommands.length === 0 || t.supportedCommands.includes(command);
}

export function installRemoteSessions(): void {
  createRoot(() => {
    // Sessions updates are a socket subscription, not a server setting, so they
    // have to be re-armed on every reconnect.
    onSocketOpen(() => {
      sendSocket("SessionsStart", `0,${SESSIONS_PUSH_MS}`);
      void refreshRemoteDevices();
    });

    onSocketMessage((msg) => {
      if (msg.MessageType !== "Sessions") return;
      if (Array.isArray(msg.Data)) ingest(msg.Data as JfSessionInfo[]);
    });

    // Signing out of Jellyfin (or into Navidrome) invalidates everything here.
    createEffect(
      on(socketClient, (jf) => {
        if (!jf) {
          setDevices([]);
          setLoaded(false);
          selectRemoteDevice(null);
        }
      }),
    );

    // A target that vanishes — device closed, went to sleep, lost the network —
    // must not leave the app silently pointed at nothing. Once the list has
    // loaded and the id isn't in it, fall back to local playback.
    createEffect(() => {
      const id = targetId();
      if (!id || !loaded()) return;
      if (!devices().some((d) => d.sessionId === id)) selectRemoteDevice(null);
    });
  });
}
