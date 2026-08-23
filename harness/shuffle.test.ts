// Pure test for the artist-spreading shuffle. The property that matters most is
// that it is still a *permutation* — a shuffle that silently drops tracks would
// be far worse than one that clumps.
import { installShims } from "./shims";
installShims();

const { player } = await import("~/player/store");
const { settings, updateSettings } = await import("~/settings/store");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

function song(id: string, artist: string) {
  return { id, title: id, artist, duration: 100 } as never;
}

// Drive it through the public API: playNow with shuffle on is the only way in.
updateSettings((s) => (s.playback.resumeQueueOnLaunch = false));
if (!settings.playback.autoplay) { /* leave as configured */ }
if (!player.state.shuffle) player.toggleShuffle();

function run(input: ReturnType<typeof song>[]) {
  player.playNow(input);
  return player.state.queue as unknown as { id: string; artist: string }[];
}

// --- permutation safety ---------------------------------------------------
const heavy = [
  ...Array.from({ length: 8 }, (_, i) => song(`a${i}`, "Alpha")),
  ...Array.from({ length: 3 }, (_, i) => song(`b${i}`, "Beta")),
  ...Array.from({ length: 2 }, (_, i) => song(`c${i}`, "Gamma")),
  song("d0", "Delta"),
];
console.log("1. It is still a permutation");
for (let trial = 0; trial < 40; trial++) {
  const out = run(heavy);
  if (out.length !== heavy.length) { check("length preserved", false, out.length); break; }
  const ids = new Set(out.map((s) => s.id));
  if (ids.size !== heavy.length) { check("no duplicates or drops", false, [...ids].length); break; }
  if (trial === 39) {
    check("length preserved over 40 trials", true);
    check("no duplicates or drops over 40 trials", true);
  }
}

// --- clumping -------------------------------------------------------------
function adjacentRepeats(list: { artist: string }[]): number {
  let n = 0;
  for (let i = 1; i < list.length; i++) if (list[i].artist === list[i - 1].artist) n++;
  return n;
}

console.log("\n2. Same-artist tracks get spread out");
let spread = 0;
const TRIALS = 60;
for (let i = 0; i < TRIALS; i++) spread += adjacentRepeats(run(heavy));
const spreadAvg = spread / TRIALS;

// Baseline: the uniform shuffle this replaced.
function uniform<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let plain = 0;
for (let i = 0; i < TRIALS; i++) plain += adjacentRepeats(uniform(heavy) as unknown as { artist: string }[]);
const plainAvg = plain / TRIALS;

console.log(`     uniform shuffle: ${plainAvg.toFixed(2)} adjacent repeats per queue`);
console.log(`     spreading shuffle: ${spreadAvg.toFixed(2)} adjacent repeats per queue`);
check("fewer adjacent same-artist pairs than a uniform shuffle", spreadAvg < plainAvg, {
  plainAvg, spreadAvg,
});

// 8 of 14 tracks are one artist, so *some* adjacency is unavoidable —
// ceil(8/(14-8+1)) style pigeonholing. Assert it's near that floor, not zero.
// 8 of 14 tracks are one artist, so pigeonholing forces max(0, 8-6-1) = 1
// adjacent repeat. Anything near that means the spreading is working.
check("reaches the theoretical minimum for a dominant artist", spreadAvg <= 1.2, spreadAvg);

console.log("\n3. All-distinct artists are untouched in character");
const distinct = Array.from({ length: 10 }, (_, i) => song(`x${i}`, `Artist ${i}`));
const out = run(distinct);
check("all tracks survive", new Set(out.map((s) => s.id)).size === 10);
check("no adjacent repeats when every artist differs", adjacentRepeats(out) === 0);

console.log("\n4. Degenerate inputs");
check("single track", run([song("solo", "One")]).length === 1);
check("two tracks", run([song("p", "A"), song("q", "A")]).length === 2);
const allSame = Array.from({ length: 5 }, (_, i) => song(`s${i}`, "Same"));
check("every track the same artist still returns all of them", run(allSame).length === 5);

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
