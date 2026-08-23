// LRCLIB integration. Hits the real API — it's public, unauthenticated and the
// whole point is that the contract holds against the live service.
import { installShims } from "./shims";
installShims();

const { parseLrc, fetchLyricsFromLrclib } = await import("~/features/lyrics/lrclib");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), a);

console.log("1. LRC parsing");
const lrc = [
  "[ar: Queen]",            // metadata tag, not a line
  "[00:00.67] First line",
  "[00:04.52] Second line",
  "[01:05.10] After a minute",
  "[02:03.456] Millisecond precision",
  "[00:12.00]",             // an instrumental gap
  "not a timestamped line",
].join("\n");
const lines = parseLrc(lrc);
eq("metadata tags are not lyrics", lines.length, 5);
eq("first timestamp in ms", lines[0].start, 670);
eq("text is trimmed", lines[0].value, "First line");
eq("minutes carry", lines[2].start, 65_100);
eq("3-digit fractions are milliseconds", lines[3].start, 123_456);
eq("blank gap lines are kept", lines[4].value, "");
check("untimed trailing text is dropped", !lines.some((l) => l.value === "not a timestamped line"));

console.log("\n2. Two-digit vs three-digit fractions");
eq("'.5' is 500ms not 5ms", parseLrc("[00:01.5] x")[0].start, 1_500);
eq("'.05' is 50ms", parseLrc("[00:01.05] x")[0].start, 1_050);

console.log("\n3. Live lookup — exact match");
const exact = await fetchLyricsFromLrclib({
  id: "1", title: "A Kind of Magic", artist: "Queen",
  album: "A Kind of Magic", duration: 262,
} as never);
check("found", !!exact);
check("synced", exact?.synced === true);
check("has many lines", (exact?.line.length ?? 0) > 10, exact?.line.length);
check("timestamps ascend", (exact?.line ?? []).every((l, i, a) => i === 0 || (l.start ?? 0) >= (a[i - 1].start ?? 0)));
console.log(`     "${exact?.line[0]?.value}" @ ${exact?.line[0]?.start}ms`);

console.log("\n4. Live lookup — falls back to search when tags don't match");
// Wrong album and a slightly-off duration: /get will 404, /search must rescue it.
const fuzzy = await fetchLyricsFromLrclib({
  id: "2", title: "A Kind of Magic", artist: "Queen",
  album: "Some Compilation Nobody Has", duration: 264,
} as never);
check("still found via search", !!fuzzy, fuzzy?.displayTitle);
check("and it's synced", fuzzy?.synced === true);

console.log("\n5. A wrong-length match is rejected");
// Same title and artist, but nowhere near the real duration.
const wrongLength = await fetchLyricsFromLrclib({
  id: "3", title: "A Kind of Magic", artist: "Queen",
  album: "", duration: 30,
} as never);
check("30s 'track' does not match the 4-minute song", wrongLength === null, wrongLength?.displayTitle);

console.log("\n6. Misses and bad input");
check("unknown track returns null", (await fetchLyricsFromLrclib({
  id: "4", title: "Zzzzq Nonexistent Track 12345", artist: "Nobody At All 98765", duration: 100,
} as never)) === null);
check("no artist returns null without a request", (await fetchLyricsFromLrclib({
  id: "5", title: "Something", artist: "", duration: 100,
} as never)) === null);

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
