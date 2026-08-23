// End-to-end harness for Jellyfin remote control, both directions.
//
// Runs the real app modules (jellyfinSocket, remoteSessions, player store,
// JellyfinClient) headless against a mock Jellyfin server, so the protocol —
// what actually goes over the wire — is what's under test.

import { installShims } from "./shims";
installShims();

import { MockJellyfin, makeItem } from "./mockJellyfin";

const TICKS = 10_000_000;
const MY_DEVICE = "harness-device-id";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: "sess-tv",
    DeviceId: "device-tv",
    DeviceName: "Living Room TV",
    Client: "Jellyfin Android TV",
    UserId: "user-1",
    UserName: "jack",
    SupportsRemoteControl: true,
    PlayableMediaTypes: ["Audio", "Video"],
    SupportedCommands: [
      "PlayState", "Play", "SetVolume", "Mute", "Unmute", "ToggleMute",
      "SetRepeatMode", "SetShuffleQueue",
    ],
    LastActivityDate: new Date().toISOString(),
    ...over,
  };
}

async function main(): Promise<void> {
  const jf = new MockJellyfin();
  jf.start();
  jf.addItems([
    makeItem("t1", "First Light", "Alpha", 200),
    makeItem("t2", "Second Wind", "Beta", 180),
    makeItem("t3", "Third Rail", "Gamma", 240),
    makeItem("local-a", "Local A", "Home", 120),
    makeItem("local-b", "Local B", "Home", 130),
  ]);

  // Import after the shims and the server exist: module top-level code runs on
  // import and immediately reads storage / opens the socket.
  const { switchServer } = await import("~/auth/session");
  const { installJellyfinSocket, socketConnected } = await import("~/player/jellyfinSocket");
  const { installJellyfinRemote } = await import("~/player/jellyfinRemote");
  const remote = await import("~/player/remoteSessions");
  const { player } = await import("~/player/store");

  installJellyfinRemote();
  remote.installRemoteSessions();
  installJellyfinSocket();

  switchServer({
    serverType: "jellyfin",
    serverUrl: jf.url,
    username: "jack",
    authMethod: "jellyfin",
    subsonicSalt: "",
    subsonicToken: "",
    accessToken: "token-abc",
    userId: "user-1",
    deviceId: MY_DEVICE,
    savedAt: Date.now(),
  });

  // --- 1. Connection ---------------------------------------------------------
  console.log("\n1. Socket + capabilities");
  await until(() => socketConnected(), 3000, "socket connect");
  check("socket connected", socketConnected());
  const caps = jf.find("POST", "/Sessions/Capabilities/Full");
  check("capabilities registered before connecting", caps.length === 1);
  const capBody = caps[0]?.body as { SupportsMediaControl?: boolean; SupportedCommands?: string[] };
  check("capabilities advertise media control", capBody?.SupportsMediaControl === true);

  await until(
    () => jf.socketMessages.some((m) => m.MessageType === "SessionsStart"),
    3000,
    "SessionsStart",
  );
  const start = jf.socketMessages.find((m) => m.MessageType === "SessionsStart");
  // The interval comes from the "Other devices refresh rate" setting.
  const { settings } = await import("~/settings/store");
  eq(
    "SessionsStart subscribes at the configured refresh rate",
    start?.Data,
    `0,${settings.power.polling.nowPlayingMs}`,
  );

  // --- 2. Device discovery ---------------------------------------------------
  console.log("\n2. Device discovery and filtering");
  jf.pushSessions([
    session(),
    // Us: must never be offered as a target.
    session({ Id: "sess-self", DeviceId: MY_DEVICE, DeviceName: "This browser" }),
    // Cannot be driven.
    session({ Id: "sess-nocontrol", DeviceId: "d2", DeviceName: "Old Client", SupportsRemoteControl: false }),
    // Video-only client: would accept an audio command and do nothing.
    session({ Id: "sess-video", DeviceId: "d3", DeviceName: "Video Only", PlayableMediaTypes: ["Video"] }),
    // Long dead; Jellyfin keeps listing it.
    session({
      Id: "sess-stale", DeviceId: "d4", DeviceName: "Ghost",
      LastActivityDate: new Date(Date.now() - 30 * 60_000).toISOString(),
    }),
    session({ Id: "sess-phone", DeviceId: "device-phone", DeviceName: "Pixel 8", Client: "Jellyfin Android" }),
  ]);
  await until(() => remote.remoteDevices().length > 0, 2000, "devices ingested");
  eq(
    "only controllable audio devices are listed",
    remote.remoteDevices().map((d) => d.name),
    ["Living Room TV", "Pixel 8"],
  );
  check("own device filtered out", !remote.remoteDevices().some((d) => d.deviceId === MY_DEVICE));

  // --- 3. Handoff ------------------------------------------------------------
  console.log("\n3. Handoff to a device");
  player.playNow([
    { id: "local-a", title: "Local A", artist: "Home", duration: 120 },
    { id: "local-b", title: "Local B", artist: "Home", duration: 130 },
  ] as never[]);
  await sleep(120);
  eq("local queue playing before handoff", player.state.queue.map((s) => s.id), ["local-a", "local-b"]);

  jf.clear();
  jf.pushSessions([
    session({
      NowPlayingItem: makeItem("t2", "Second Wind", "Beta", 180),
      PlayState: {
        PositionTicks: 42 * TICKS,
        CanSeek: true,
        IsPaused: false,
        IsMuted: false,
        VolumeLevel: 65,
        RepeatMode: "RepeatAll",
        PlaybackOrder: "Shuffle",
      },
      NowPlayingQueue: [
        { Id: "t1", PlaylistItemId: "p1" },
        { Id: "t2", PlaylistItemId: "p2" },
        { Id: "t3", PlaylistItemId: "p3" },
      ],
    }),
  ]);
  await sleep(150);
  remote.selectRemoteDevice("sess-tv");
  await until(() => player.state.queue.length === 3, 2000, "remote queue mirrored");

  check("target is the TV", remote.remoteTarget()?.name === "Living Room TV");
  eq("queue mirrors the device, in its order", player.state.queue.map((s) => s.id), ["t1", "t2", "t3"]);
  eq("index points at the device's current track", player.state.index, 1);
  check("duration comes from the remote track", player.state.duration === 180);
  check("isPlaying mirrors the device", player.state.isPlaying === true);
  check("volume mirrors the device", Math.abs(player.state.volume - 0.65) < 0.001, player.state.volume);
  check("repeat mirrors the device", player.state.repeat === "all", player.state.repeat);
  check("shuffle mirrors the device", player.state.shuffle === true);
  check("position mirrors the device", Math.abs(player.state.currentTime - 42) < 1.5, player.state.currentTime);
  check("seekable reflects CanSeek", player.isSeekable() === true);

  const stops = jf.find("POST", "/Sessions/Playing/Stopped");
  check("local playback was ended server-side on handoff", stops.length >= 1);

  // --- 4. Interpolation ------------------------------------------------------
  console.log("\n4. Scrubber between pushes");
  const before = player.state.currentTime;
  await sleep(900);
  check(
    "position advances between pushes",
    player.state.currentTime > before + 0.5,
    { before, after: player.state.currentTime },
  );

  // --- 5. Transport routing --------------------------------------------------
  console.log("\n5. Transport commands go to the device");
  jf.clear();
  player.togglePlay();
  await sleep(80);
  eq("pause hits the device session", jf.find("POST", "/Sessions/sess-tv/Playing/Pause").length, 1);
  check("pause is optimistic locally", player.state.isPlaying === false);

  jf.clear();
  player.togglePlay();
  await sleep(80);
  eq("unpause hits the device session", jf.find("POST", "/Sessions/sess-tv/Playing/Unpause").length, 1);

  jf.clear();
  player.next();
  player.previous();
  await sleep(80);
  eq("next → NextTrack", jf.find("POST", "/Sessions/sess-tv/Playing/NextTrack").length, 1);
  eq("previous → PreviousTrack", jf.find("POST", "/Sessions/sess-tv/Playing/PreviousTrack").length, 1);

  jf.clear();
  player.seek(90);
  await sleep(80);
  const seek = jf.find("POST", "/Sessions/sess-tv/Playing/Seek")[0];
  eq("seek sends ticks, not seconds", seek?.query.seekPositionTicks, String(90 * TICKS));
  check("seek updates the scrubber immediately", Math.abs(player.state.currentTime - 90) < 0.01);

  jf.clear();
  player.setVolume(0.4);
  player.toggleMute();
  player.cycleRepeat();
  player.toggleShuffle();
  await sleep(120);
  // Fire-and-forget requests, so match by command name — arrival order isn't
  // guaranteed and doesn't matter.
  const cmds = jf.find("POST", "/Sessions/sess-tv/Command")
    .map((r) => r.body as { Name?: string; Arguments?: Record<string, string> });
  const cmd = (name: string) => cmds.find((c) => c.Name === name);
  eq("SetVolume sent as 0-100", cmd("SetVolume")?.Arguments?.Volume, "40");
  check("mute sent", !!cmd("Mute"));
  eq("repeat cycles all → one", cmd("SetRepeatMode")?.Arguments?.RepeatMode, "RepeatOne");
  eq("shuffle turned off", cmd("SetShuffleQueue")?.Arguments?.ShuffleMode, "Sorted");

  console.log("\n5b. Rapid commands keep their order");
  jf.clear();
  // A dragged volume slider: the device must end up where the user left it, not
  // wherever the last request happened to land.
  for (const v of [0.2, 0.5, 0.9, 0.35]) player.setVolume(v);
  await sleep(400);
  eq(
    "volume commands arrive in the order they were issued",
    jf.find("POST", "/Sessions/sess-tv/Command")
      .map((r) => (r.body as { Arguments?: Record<string, string> })?.Arguments?.Volume),
    ["20", "50", "90", "35"],
  );

  jf.clear();
  player.next();
  player.next();
  player.previous();
  await sleep(400);
  eq(
    "transport commands arrive in order",
    jf.find("POST", "/Sessions/sess-tv/Playing").map((r) => r.path.split("/").pop()),
    ["NextTrack", "NextTrack", "PreviousTrack"],
  );

  // --- 6. Pushing music ------------------------------------------------------
  console.log("\n6. Library actions push to the device");
  jf.clear();
  player.playNow([
    { id: "t3", title: "Third Rail", artist: "Gamma", duration: 240 },
    { id: "t1", title: "First Light", artist: "Alpha", duration: 200 },
  ] as never[], 1);
  await sleep(100);
  const play = jf.find("POST", "/Sessions/sess-tv/Playing")[0];
  eq("playNow → PlayNow", play?.query.playCommand, "PlayNow");
  eq("item ids are sent", play?.query.itemIds, "t3,t1");
  eq("start index is preserved", play?.query.startIndex, "1");
  check("local queue was NOT replaced by the push", player.state.queue.length === 3);

  jf.clear();
  player.addToQueue([{ id: "t1", title: "First Light", artist: "Alpha", duration: 200 }] as never[]);
  player.playNext([{ id: "t2", title: "Second Wind", artist: "Beta", duration: 180 }] as never[]);
  await sleep(100);
  const pushes = jf.find("POST", "/Sessions/sess-tv/Playing");
  eq("addToQueue → PlayLast", pushes[0]?.query.playCommand, "PlayLast");
  eq("playNext → PlayNext", pushes[1]?.query.playCommand, "PlayNext");

  jf.clear();
  player.playNow([{ id: "radio-1", title: "Some Station", isRadio: true, duration: 0 }] as never[]);
  await sleep(80);
  eq("live radio is not pushed (no server item to resolve)", jf.find("POST", "/Sessions/sess-tv/Playing").length, 0);

  // --- 7. Local queue is untouched ------------------------------------------
  console.log("\n7. The local queue survives");
  // The queue is namespaced per server now, so a switch can't restore another
  // server's track ids.
  const stored = JSON.parse(localStorage.getItem(`nd:queue:${jf.url}`) ?? "{}");
  eq("remote queue never overwrote the persisted local queue",
     (stored.queue ?? []).map((s: { id: string }) => s.id), ["local-a", "local-b"]);

  const localShuffle = false;
  const localRepeat = "off";
  remote.selectRemoteDevice(null);
  await sleep(150);
  eq("returning home restores the local queue", player.state.queue.map((s) => s.id), ["local-a", "local-b"]);
  check("restored paused", player.state.isPlaying === false);
  // The mirror overwrote these with the device's modes while remote; local
  // playback must not inherit them.
  eq("local shuffle restored, not inherited from the device", player.state.shuffle, localShuffle);
  eq("local repeat restored, not inherited from the device", player.state.repeat, localRepeat);
  check("target cleared", remote.remoteTarget() === null);

  jf.clear();
  player.togglePlay();
  await sleep(80);
  eq("transport is local again", jf.find("POST", "/Sessions/sess-tv/Playing/Unpause").length, 0);

  // --- 8. Device disappears --------------------------------------------------
  console.log("\n8. A device that goes away");
  remote.selectRemoteDevice("sess-tv");
  await until(() => remote.remoteTarget() !== null, 2000, "re-target");
  jf.pushSessions([session({ Id: "sess-phone", DeviceId: "device-phone", DeviceName: "Pixel 8" })]);
  await until(() => remote.remoteTarget() === null, 2000, "fallback to local");
  check("target falls back to local when the device vanishes", remote.remoteTarget() === null);
  check("persisted target was cleared", localStorage.getItem("nd:remote-target") === null);

  // --- 9. Inbound control (the other direction) ------------------------------
  console.log("\n9. Being controlled from another device");
  player.playNow([{ id: "t1", title: "First Light", artist: "Alpha", duration: 200 }] as never[]);
  await sleep(120);
  jf.push("Playstate", { Command: "Pause" });
  await sleep(120);
  check("an inbound Pause pauses local playback", player.state.isPlaying === false);

  jf.push("GeneralCommand", { Name: "SetVolume", Arguments: { Volume: "25" } });
  await sleep(120);
  check("an inbound SetVolume applies", Math.abs(player.state.volume - 0.25) < 0.001, player.state.volume);

  jf.push("GeneralCommand", { Name: "SetRepeatMode", Arguments: { RepeatMode: "RepeatOne" } });
  await sleep(120);
  check("an inbound SetRepeatMode applies", player.state.repeat === "one", player.state.repeat);

  jf.clear();
  if (player.state.shuffle) player.toggleShuffle(); // order assertion below
  jf.push("Play", { ItemIds: ["t3", "t1", "t2"], PlayCommand: "PlayNow", StartIndex: 0 });
  await until(() => player.state.queue.length === 3, 2000, "inbound Play resolves");
  eq('an inbound "Play On" resolves ids in the pushed order',
     player.state.queue.map((s) => s.id), ["t3", "t1", "t2"]);
  // Only the batch endpoint: /Items/{id}/Similar and /InstantMix also match a
  // bare "/Items" prefix, and those come from autoplay, not this push.
  const batches = jf.find("GET", "/Items").filter((r) => r.path === "/Items" && r.query.ids);
  eq("the whole push is one metadata request", batches.length, 1);
  eq("...asking for every id at once", batches[0]?.query.ids, "t3,t1,t2");

  // --- 10. Backend switch ----------------------------------------------------
  console.log("\n10. Leaving Jellyfin");
  check("remote control available on Jellyfin", remote.remoteControlAvailable() === true);
  switchServer({
    serverType: "navidrome",
    serverUrl: jf.url,
    username: "jack",
    authMethod: "native",
    subsonicSalt: "s",
    subsonicToken: "t",
    savedAt: Date.now(),
  });
  await sleep(200);
  check("remote control unavailable on Navidrome", remote.remoteControlAvailable() === false);
  eq("device list cleared", remote.remoteDevices().length, 0);
  await until(() => jf.socketCount === 0, 2000, "socket closed");
  check("socket closed on backend switch", jf.socketCount === 0);

  jf.stop();
  console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\nharness error:", err);
  process.exit(1);
});
