// Infinite radio queue behaviour. The bug this pins down: seeding the next
// batch from the end of the queue meant that once radio had appended anything,
// every later batch was a recommendation of a recommendation, and the queue
// drifted away from what the user actually chose.
import { installShims } from "./shims";
installShims();

const { nextRadioBatch } = await import("~/lib/recommendations");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), a);

const song = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, artist: "A", duration: 100, ...extra }) as never;
const ids = (list: { id: string }[]) => list.map((s) => s.id);

console.log("1. Dedupe against the queue");
eq(
  "tracks already queued are dropped",
  ids(nextRadioBatch([song("a"), song("b")], [song("b"), song("c"), song("d")])),
  ["c", "d"],
);

console.log("\n2. Dedupe against recent history");
eq(
  "recently played tracks are dropped",
  ids(nextRadioBatch([song("a")], [song("b"), song("c"), song("d")], new Set(["c"]))),
  ["b", "d"],
);
// getSimilarSongs is deterministic per seed, so without this every session from
// the same anchor replays the same handful and the queue looks stuck.
eq(
  "but never to nothing — a repeat beats stalling playback",
  ids(nextRadioBatch([song("a")], [song("b"), song("c")], new Set(["b", "c"]))),
  ["b", "c"],
);

console.log("\n3. The seed never drifts onto an auto-added track");
// Mirrors radioSeed(): walk back from the current index to the last track the
// user actually chose.
function radioSeed(queue: { id: string; autoQueued?: boolean }[], index: number) {
  for (let i = Math.min(index, queue.length - 1); i >= 0; i--) {
    const s = queue[i];
    if (s && !s.autoQueued) return s;
  }
  return queue[index];
}

const chosen = [song("mine1"), song("mine2")] as unknown as { id: string; autoQueued?: boolean }[];
const afterRadio = [
  ...chosen,
  song("radio1", { autoQueued: true }),
  song("radio2", { autoQueued: true }),
  song("radio3", { autoQueued: true }),
] as unknown as { id: string; autoQueued?: boolean }[];

eq("playing my own track: seeds from it", radioSeed(afterRadio, 1).id, "mine2");
eq("playing a radio track: still seeds from my last chosen one", radioSeed(afterRadio, 3).id, "mine2");
eq("deep into a radio run: STILL anchored to my choice", radioSeed(afterRadio, 4).id, "mine2");

// The old behaviour, for contrast: seed = last item in the queue.
const oldSeed = (q: { id: string }[]) => q[q.length - 1];
check(
  "the old end-of-queue seed drifted onto an auto-added track",
  oldSeed(afterRadio).id === "radio3" && radioSeed(afterRadio, 4).id === "mine2",
  { old: oldSeed(afterRadio).id, fixed: radioSeed(afterRadio, 4).id },
);

console.log("\n4. An all-radio queue still finds a seed");
const allAuto = [
  song("r1", { autoQueued: true }),
  song("r2", { autoQueued: true }),
] as unknown as { id: string; autoQueued?: boolean }[];
check("falls back rather than returning nothing", !!radioSeed(allAuto, 1));

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
