// Raw /Sessions dump — shows what the server actually returns, and why each
// session does or doesn't pass the picker's filter.
import { installShims } from "./shims";
installShims();

const SERVER = (Bun.env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const USER = Bun.env.JELLYFIN_USERNAME ?? "";
const PASS = Bun.env.JELLYFIN_PASSWORD ?? "";

const { loginJellyfin } = await import("~/api/credentials");
const creds = await loginJellyfin(SERVER, USER, PASS);
const auth = { "X-Emby-Token": creds.accessToken!, "Content-Type": "application/json" };

for (const [label, url] of [
  ["ALL sessions", `${SERVER}/Sessions`],
  ["ControllableByUserId (what the app asks for)", `${SERVER}/Sessions?ControllableByUserId=${creds.userId}`],
] as const) {
  const res = await fetch(url, { headers: auth });
  const list = (await res.json()) as Record<string, any>[];
  console.log(`\n=== ${label} — HTTP ${res.status}, ${list.length} session(s) ===`);
  for (const s of list) {
    const ageMin = s.LastActivityDate
      ? Math.round((Date.now() - new Date(s.LastActivityDate).getTime()) / 60000)
      : null;
    console.log(
      `\n  Id=${s.Id}\n` +
        `  DeviceName=${JSON.stringify(s.DeviceName)}  Client=${JSON.stringify(s.Client)}\n` +
        `  DeviceId=${s.DeviceId}${s.DeviceId === creds.deviceId ? "   <-- THIS HARNESS" : ""}\n` +
        `  UserName=${s.UserName}\n` +
        `  SupportsRemoteControl=${s.SupportsRemoteControl}\n` +
        `  SupportsMediaControl=${s.SupportsMediaControl}\n` +
        `  PlayableMediaTypes=${JSON.stringify(s.PlayableMediaTypes)}\n` +
        `  SupportedCommands=${JSON.stringify(s.SupportedCommands)}\n` +
        `  LastActivityDate=${s.LastActivityDate} (${ageMin} min ago)\n` +
        `  NowPlayingItem=${s.NowPlayingItem ? `${s.NowPlayingItem.Name} [${s.NowPlayingItem.Type}]` : "none"}\n` +
        `  NowPlayingQueue=${(s.NowPlayingQueue ?? []).length} item(s)`,
    );
  }
}
process.exit(0);
