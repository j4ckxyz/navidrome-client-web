// Inspect what Infinite radio actually queues, against a real library.
import { installShims } from "./shims";
installShims();

const SERVER = (Bun.env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { loginJellyfin } = await import("~/api/credentials");
const { switchServer } = await import("~/auth/session");
const { JellyfinClient } = await import("~/api/jellyfin");
const { player } = await import("~/player/store");
const { updateSettings } = await import("~/settings/store");

const creds = await loginJellyfin(SERVER, Bun.env.JELLYFIN_USERNAME!, Bun.env.JELLYFIN_PASSWORD!);
switchServer(creds);
const jf = new JellyfinClient(creds);
updateSettings((s) => {
  s.playback.autoplay = true;
  s.playback.resumeQueueOnLaunch = false;
});

const label = (s: { title: string; artist?: string; autoQueued?: boolean }) =>
  `${s.autoQueued ? "  radio │ " : "  MINE  │ "}${s.title} — ${s.artist ?? "?"}`;

// Seed from a real album so the queue starts as something deliberate.
const albums = await jf.getAlbumList("random", 6);
const album = await jf.getAlbum(albums[0].id);
console.log(`Seed album: ${album.name} — ${album.artist}  (${album.song.length} tracks)\n`);

console.log("=== What the seed track's similar-songs actually returns ===");
const seed = album.song[0];
const similar = await jf.getSimilarSongs(seed.id, 15);
console.log(`Seed: ${seed.title} — ${seed.artist}`);
console.log(`InstantMix returned ${similar.length}:`);
for (const s of similar.slice(0, 12)) console.log(`   • ${s.title} — ${s.artist}`);

// How much of the mix is just the same artist / same album?
const sameArtist = similar.filter((s) => (s.artist ?? "") === (seed.artist ?? "")).length;
const sameAlbum = similar.filter((s) => s.albumId && s.albumId === seed.albumId).length;
const distinctArtists = new Set(similar.map((s) => s.artist)).size;
console.log(`\n   same artist as seed: ${sameArtist}/${similar.length}`);
console.log(`   same album as seed:  ${sameAlbum}/${similar.length}`);
console.log(`   distinct artists:    ${distinctArtists}`);

console.log("\n=== Playing the album, letting radio top up ===");
player.playNow(album.song.slice(0, 3));
await sleep(1500);
// Jump to the last track so the top-up condition is met.
player.next();
player.next();
await sleep(4000);

console.log(`Queue is now ${player.state.queue.length} tracks (started as 3):`);
for (const s of player.state.queue) console.log(label(s as never));

const auto = player.state.queue.filter((s) => (s as { autoQueued?: boolean }).autoQueued);
console.log(`\nAdded by radio: ${auto.length}`);
console.log(`Distinct artists among them: ${new Set(auto.map((s) => s.artist)).size}`);
process.exit(0);
