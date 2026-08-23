// Does *this app* register as a controllable device on the real server?
// Logs in, opens the socket exactly as the browser does, then reads its own
// session back and reports whether Jellyfin considers it drivable.
import { installShims } from "./shims";
installShims();

const SERVER = (Bun.env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { loginJellyfin } = await import("~/api/credentials");
const { switchServer } = await import("~/auth/session");
const { installJellyfinSocket, socketConnected } = await import("~/player/jellyfinSocket");
const { installJellyfinRemote } = await import("~/player/jellyfinRemote");
const remote = await import("~/player/remoteSessions");

const creds = await loginJellyfin(SERVER, Bun.env.JELLYFIN_USERNAME!, Bun.env.JELLYFIN_PASSWORD!);
installJellyfinRemote();
remote.installRemoteSessions();
installJellyfinSocket();
switchServer(creds);

for (let i = 0; i < 60 && !socketConnected(); i++) await sleep(250);
console.log(`socket open: ${socketConnected()}`);
await sleep(2500); // let capabilities land

const res = await fetch(`${SERVER}/Sessions`, { headers: { "X-Emby-Token": creds.accessToken! } });
const all = (await res.json()) as Record<string, any>[];
const me = all.find((s) => s.DeviceId === creds.deviceId);

console.log(`\nOur own session (device ${creds.deviceId}):`);
if (!me) {
  console.log("  NOT FOUND — the server never registered this device");
} else {
  console.log(`  DeviceName            = ${JSON.stringify(me.DeviceName)}`);
  console.log(`  Client                = ${JSON.stringify(me.Client)}`);
  console.log(`  SupportsRemoteControl = ${me.SupportsRemoteControl}`);
  console.log(`  SupportsMediaControl  = ${me.SupportsMediaControl}`);
  console.log(`  PlayableMediaTypes    = ${JSON.stringify(me.PlayableMediaTypes)}`);
  console.log(`  SupportedCommands     = ${JSON.stringify(me.SupportedCommands)}`);
}

const ctrl = await fetch(`${SERVER}/Sessions?ControllableByUserId=${creds.userId}`, {
  headers: { "X-Emby-Token": creds.accessToken! },
});
const list = (await ctrl.json()) as Record<string, any>[];
console.log(`\nControllable-by-you sessions now: ${list.length}`);
for (const s of list) console.log(`  • ${s.DeviceName} [${s.Client}]${s.DeviceId === creds.deviceId ? "  <-- us" : ""}`);
process.exit(0);
