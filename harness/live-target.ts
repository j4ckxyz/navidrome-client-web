// Stands up a real Tonearm session against the live server and plays a few
// real tracks, so another instance can discover and drive it. Prints every
// state change so inbound commands are visible as they land.
import { installShims } from "./shims";
installShims();

const SERVER = (Bun.env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const HANDOFF = Bun.env.HARNESS_HANDOFF ?? "/tmp/tonearm-target.json";
const LIFETIME_MS = Number(Bun.env.HARNESS_LIFETIME ?? 120_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
console.log(`[target] socket=${socketConnected()} device=${creds.deviceId}`);

const { JellyfinClient } = await import("~/api/jellyfin");
const jf = new JellyfinClient(creds);
const songs = await jf.getRandomSongs(4);
console.log(`[target] loaded ${songs.length} tracks: ${songs.map((s) => s.title).join(" | ")}`);

player.playNow(songs);
await sleep(3000);
console.log(`[target] playing="${player.current()?.title}" isPlaying=${player.state.isPlaying}`);

await Bun.write(HANDOFF, JSON.stringify({ deviceId: creds.deviceId, ready: true }));

// Report every change so the controller's effect on this process is visible.
let last = "";
const deadline = Date.now() + LIFETIME_MS;
while (Date.now() < deadline) {
  const snap = `${player.current()?.title ?? "-"} | playing=${player.state.isPlaying} | vol=${Math.round(player.state.volume * 100)} | muted=${player.state.muted} | repeat=${player.state.repeat} | shuffle=${player.state.shuffle} | idx=${player.state.index} | q=${player.state.queue.length}`;
  if (snap !== last) {
    console.log(`[target] ${snap}`);
    last = snap;
  }
  await sleep(300);
}
console.log("[target] done");
process.exit(0);
