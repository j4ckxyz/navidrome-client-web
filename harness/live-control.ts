// Drives the live-target instance through the real Jellyfin server, using the
// app's own outbound remote-control path. Proves the full round trip:
// controller → server → target's socket → target's player.
import { installShims } from "./shims";
installShims();

const SERVER = (Bun.env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const HANDOFF = Bun.env.HARNESS_HANDOFF ?? "/tmp/tonearm-target.json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}
async function until(pred: () => boolean, ms: number, label: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(200); }
  console.log(`     (timed out waiting for ${label})`);
  return false;
}

const targetInfo = JSON.parse(await Bun.file(HANDOFF).text()) as { deviceId: string };

const { loginJellyfin } = await import("~/api/credentials");
const { switchServer } = await import("~/auth/session");
const { installJellyfinSocket, socketConnected } = await import("~/player/jellyfinSocket");
const { installJellyfinRemote } = await import("~/player/jellyfinRemote");
const remote = await import("~/player/remoteSessions");
const { player } = await import("~/player/store");

const creds = await loginJellyfin(SERVER, Bun.env.JELLYFIN_USERNAME!, Bun.env.JELLYFIN_PASSWORD!);
installJellyfinRemote();
remote.installRemoteSessions();
installJellyfinSocket();
switchServer(creds);
for (let i = 0; i < 60 && !socketConnected(); i++) await sleep(250);
console.log(`[control] socket=${socketConnected()} device=${creds.deviceId}\n`);

console.log("1. Discovery");
await until(() => remote.remoteDevices().some((d) => d.deviceId === targetInfo.deviceId), 25_000, "target device");
const target = remote.remoteDevices().find((d) => d.deviceId === targetInfo.deviceId);
check("the other instance appears in the device list", !!target);
check("our own device is not listed", !remote.remoteDevices().some((d) => d.deviceId === creds.deviceId));
if (!target) { console.log("\nFAIL — target never appeared"); process.exit(1); }
console.log(`     found "${target.name}" [${target.client}] playing: ${target.nowPlaying?.title ?? "nothing"}`);

console.log("\n2. Mirror");
remote.selectRemoteDevice(target.sessionId);
await until(() => player.state.queue.length > 0, 15_000, "queue mirror");
await sleep(2500);
check("now-playing mirrored", !!player.current(), player.current()?.title);
check("queue mirrored with metadata", player.state.queue.length > 0, player.state.queue.length);
check("isPlaying mirrored", player.state.isPlaying === true);
console.log(`     "${player.current()?.title}" — ${player.current()?.artist}  (${player.state.queue.length} in queue, index ${player.state.index})`);

console.log("\n3. Transport");
player.togglePlay();
const paused = await until(() => player.state.isPlaying === false, 12_000, "pause to round-trip");
check("pause reaches the device and comes back in the mirror", paused);
await sleep(1500);
player.togglePlay();
check("resume reaches the device", await until(() => player.state.isPlaying === true, 12_000, "resume"));

console.log("\n4. Volume");
const before = player.state.volume;
const want = before > 0.5 ? 0.3 : 0.8;
player.setVolume(want);
// The mirror is optimistic, so watch the *device's* reported volume, not ours.
const deviceVol = () => remote.remoteDevices().find((d) => d.deviceId === targetInfo.deviceId)?.volume ?? -1;
check("volume change reaches the device", await until(() => Math.abs(deviceVol() - want) < 0.02, 15_000, "volume"), deviceVol());

// A dragged slider: several commands back-to-back. The device must end on the
// last value, which only holds if they arrive in order.
console.log("     rapid sequence 0.2 → 0.5 → 0.9 → 0.45 (simulating a slider drag)");
for (const v of [0.2, 0.5, 0.9, 0.45]) player.setVolume(v);
const settled = await until(() => Math.abs(deviceVol() - 0.45) < 0.02, 20_000, "final volume");
check("device ends on the LAST value of a rapid sequence", settled, deviceVol());

player.setVolume(before);
check("volume restored", await until(() => Math.abs(deviceVol() - before) < 0.02, 15_000, "restore"), deviceVol());

console.log("\n5. Repeat / shuffle");
const repeatBefore = player.state.repeat;
player.cycleRepeat();
check("repeat mode round-trips", await until(() => player.state.repeat !== repeatBefore, 12_000, "repeat"), player.state.repeat);
const shuffleBefore = player.state.shuffle;
player.toggleShuffle();
check("shuffle round-trips", await until(() => player.state.shuffle !== shuffleBefore, 12_000, "shuffle"), player.state.shuffle);

console.log("\n6. Skip");
const trackBefore = player.current()?.id;
player.next();
check("next track round-trips", await until(() => player.current()?.id !== trackBefore, 15_000, "next"), player.current()?.title);
console.log(`     now "${player.current()?.title}"`);

console.log("\n7. Pushing a queue from the library");
const { JellyfinClient } = await import("~/api/jellyfin");
const jf = new JellyfinClient(creds);
const fresh = await jf.getRandomSongs(3);
const pushedIds = fresh.map((s) => s.id);
console.log(`     pushing: ${fresh.map((s) => s.title).join(" | ")}`);
player.playNow(fresh);
const landed = await until(() => !!player.current() && pushedIds.includes(player.current()!.id), 20_000, "pushed track");
check("a library Play action lands on the device", landed, player.current()?.title);
console.log(`     device is now playing "${player.current()?.title}"`);

console.log("\n8. Handing back");
remote.selectRemoteDevice(null);
await sleep(1000);
check("target cleared", remote.remoteTarget() === null);

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
