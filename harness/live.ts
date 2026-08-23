// Live check against a real Jellyfin server, using credentials from .env.
//
//   bun run test:live            observe only — list devices, watch state
//   bun run test:live --drive    also send transport commands to the target
//
// Runs the real app modules, so what goes over the wire is exactly what the
// browser would send. Nothing here is part of the app build.

import { installShims } from "./shims";
installShims();

const env = Bun.env;
const SERVER = (env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const USER = env.JELLYFIN_USERNAME ?? env.JELLYFIN_USER ?? "";
const PASS = env.JELLYFIN_PASSWORD ?? "";
const DRIVE = process.argv.includes("--drive");

if (!SERVER || !USER || !PASS) {
  console.error("Set JELLYFIN_URL, JELLYFIN_USERNAME and JELLYFIN_PASSWORD in .env");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms: number, label: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(200);
  }
  console.log(`  … timed out waiting for ${label}`);
  return false;
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const { loginJellyfin } = await import("~/api/credentials");
  const { switchServer } = await import("~/auth/session");
  const { installJellyfinSocket, socketConnected } = await import("~/player/jellyfinSocket");
  const { installJellyfinRemote } = await import("~/player/jellyfinRemote");
  const remote = await import("~/player/remoteSessions");
  const { player } = await import("~/player/store");

  console.log(`Signing in to ${SERVER} as ${USER}…`);
  const creds = await loginJellyfin(SERVER, USER, PASS);
  console.log(`  ✓ authenticated (userId ${creds.userId}, device ${creds.deviceId})`);

  installJellyfinRemote();
  remote.installRemoteSessions();
  installJellyfinSocket();
  switchServer(creds);

  const connected = await until(() => socketConnected(), 15_000, "socket");
  console.log(connected ? "  ✓ socket open" : "  ✗ socket did not open");
  if (!connected) process.exit(1);

  await until(() => remote.remoteDevicesLoaded(), 10_000, "session list");

  // Wait for another device to show up — the point of the exercise.
  console.log("\nLooking for other devices (up to 60s — start playing somewhere)…");
  await until(() => remote.remoteDevices().length > 0, 60_000, "another device");

  const devices = remote.remoteDevices();
  console.log(`\nControllable devices: ${devices.length}`);
  for (const d of devices) {
    const np = d.nowPlaying;
    console.log(
      `  • ${d.name}  [${d.client}]  user=${d.userName}\n` +
        `      ${np ? `${d.isPaused ? "paused" : "playing"}: ${np.title} — ${np.artist} (${fmt(d.positionSeconds)}/${fmt(np.duration)})` : "idle"}\n` +
        `      queue=${d.queueIds.length} vol=${Math.round(d.volume * 100)}% seek=${d.canSeek} repeat=${d.repeat} shuffle=${d.shuffle}\n` +
        `      commands=${d.supportedCommands.join(",") || "(none)"}`,
    );
  }
  if (devices.length === 0) {
    console.log("\nNothing to control. Start playback on another Jellyfin client and rerun.");
    process.exit(0);
  }

  // Prefer a device that's actually playing something.
  const pick = devices.find((d) => d.nowPlaying) ?? devices[0];
  console.log(`\nSelecting "${pick.name}" as the playback target…`);
  remote.selectRemoteDevice(pick.sessionId);
  await until(() => player.state.queue.length > 0 || !!remote.remoteTarget(), 10_000, "mirror");
  await sleep(2500); // let a couple of pushes land and the queue metadata resolve

  console.log("\nMirrored into the player store:");
  console.log(`  now playing : ${player.current()?.title ?? "(nothing)"} — ${player.current()?.artist ?? ""}`);
  console.log(`  position    : ${fmt(player.state.currentTime)} / ${fmt(player.state.duration)}`);
  console.log(`  isPlaying   : ${player.state.isPlaying}`);
  console.log(`  queue       : ${player.state.queue.length} tracks, index ${player.state.index}`);
  console.log(`  volume      : ${Math.round(player.state.volume * 100)}%  muted=${player.state.muted}`);
  console.log(`  shuffle     : ${player.state.shuffle}   repeat: ${player.state.repeat}`);
  console.log(`  seekable    : ${player.isSeekable()}`);
  if (player.state.queue.length > 1) {
    console.log("  queue contents:");
    player.state.queue.slice(0, 8).forEach((s, i) => {
      console.log(`    ${i === player.state.index ? "▶" : " "} ${i + 1}. ${s.title} — ${s.artist}`);
    });
  }

  const t0 = player.state.currentTime;
  await sleep(1200);
  console.log(
    `  scrubber advances between pushes: ${t0.toFixed(1)}s → ${player.state.currentTime.toFixed(1)}s`,
  );

  if (!DRIVE) {
    console.log("\n(observe-only; rerun with --drive to send commands)");
    remote.selectRemoteDevice(null);
    await sleep(300);
    process.exit(0);
  }

  // --- Drive it -------------------------------------------------------------
  const startedPlaying = player.state.isPlaying;
  const startVolume = player.state.volume;

  console.log("\nDriving the device (each change is reverted afterwards):");

  console.log("  → pause");
  player.togglePlay();
  await sleep(3000);
  console.log(`     device reports isPlaying=${player.state.isPlaying}`);

  console.log("  → resume");
  player.togglePlay();
  await sleep(3000);
  console.log(`     device reports isPlaying=${player.state.isPlaying}`);

  const target = Math.max(1, Math.min(player.state.currentTime + 20, (player.state.duration || 60) - 5));
  console.log(`  → seek to ${fmt(target)}`);
  player.seek(target);
  await sleep(4000);
  console.log(`     device reports ${fmt(player.state.currentTime)}`);

  const newVol = startVolume > 0.5 ? 0.3 : 0.7;
  console.log(`  → volume ${Math.round(startVolume * 100)}% → ${Math.round(newVol * 100)}%`);
  player.setVolume(newVol);
  await sleep(3000);
  console.log(`     device reports ${Math.round(player.state.volume * 100)}%`);

  console.log(`  ← restoring volume to ${Math.round(startVolume * 100)}%`);
  player.setVolume(startVolume);
  await sleep(2000);
  console.log(`     device reports ${Math.round(player.state.volume * 100)}%`);

  if (!startedPlaying && player.state.isPlaying) {
    console.log("  ← re-pausing (it was paused when we started)");
    player.togglePlay();
    await sleep(1500);
  }

  console.log("\nHanding back to local.");
  remote.selectRemoteDevice(null);
  await sleep(500);
  console.log(`  target=${remote.remoteTarget()}  local queue=${player.state.queue.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nlive harness error:", err?.message ?? err);
  process.exit(1);
});
