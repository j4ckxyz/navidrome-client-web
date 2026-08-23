// Old vs new radio, on the real library. Same seeds, same batch size.
import { installShims } from "./shims";
installShims();

const SERVER = (Bun.env.JELLYFIN_URL ?? "").replace(/\/+$/, "");
const { loginJellyfin } = await import("~/api/credentials");
const { switchServer } = await import("~/auth/session");
const { JellyfinClient } = await import("~/api/jellyfin");
const { buildRadioBatch } = await import("~/lib/radio");

const creds = await loginJellyfin(SERVER, Bun.env.JELLYFIN_USERNAME!, Bun.env.JELLYFIN_PASSWORD!);
switchServer(creds);
const jf = new JellyfinClient(creds);

const N = 8;
function genreOf(s: { genre?: string }) { return (s.genre ?? "—").split(/[;,/|]/)[0].trim(); }

// Fraction of picks sharing a genre with the seed — the crude proxy for
// "does this run hold together".
function coherence(seed: { genre?: string }, picks: { genre?: string }[]) {
  const g = genreOf(seed).toLowerCase();
  if (!g || g === "—" || picks.length === 0) return 0;
  return picks.filter((p) => genreOf(p).toLowerCase() === g).length / picks.length;
}

const albums = await jf.getAlbumList("random", 30);
const seeds = [];
for (const a of albums) {
  const full = await jf.getAlbum(a.id);
  const track = full.song?.find((s) => s.genre);
  if (track) seeds.push(track);
  if (seeds.length >= 4) break;
}

let oldTotal = 0, newTotal = 0;
for (const seed of seeds) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`SEED: ${seed.title} — ${seed.artist}   [${genreOf(seed)}, ${seed.year ?? "?"}]`);

  const old = (await jf.getSimilarSongs(seed.id, N * 3))
    .filter((s) => s.id !== seed.id).slice(0, N);
  const fresh = await buildRadioBatch(jf, seed, N, new Set());

  const oc = coherence(seed, old), nc = coherence(seed, fresh);
  oldTotal += oc; newTotal += nc;

  console.log(`\n  BEFORE — server InstantMix (${(oc * 100).toFixed(0)}% genre match)`);
  for (const s of old) console.log(`    · ${s.title} — ${s.artist}  [${genreOf(s)}, ${s.year ?? "?"}]`);
  console.log(`\n  AFTER — ranked pool (${(nc * 100).toFixed(0)}% genre match)`);
  for (const s of fresh) console.log(`    · ${s.title} — ${s.artist}  [${genreOf(s)}, ${s.year ?? "?"}]`);
}

console.log(`\n${"=".repeat(72)}`);
console.log(`Average genre coherence across ${seeds.length} seeds:`);
console.log(`  before: ${((oldTotal / seeds.length) * 100).toFixed(0)}%`);
console.log(`  after:  ${((newTotal / seeds.length) * 100).toFixed(0)}%`);
process.exit(0);
