// Multi-select semantics. Shift/ctrl behaviour is fiddly enough that the edge
// cases (backwards ranges, cross-list clicks, deselecting the last track) are
// worth pinning down.
import { installShims } from "./shims";
installShims();

const sel = await import("~/features/selection");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), a);

const songs = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `T${i}` })) as never[];
const ev = (mods: Partial<MouseEvent> = {}) =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as MouseEvent;
const ids = () => sel.selectedSongs(songs).map((s: { id: string }) => s.id);

console.log("1. Plain clicks are not selection gestures");
check("plain click is not consumed", sel.handleRowClick("L", 2, songs, ev()) === false);
eq("nothing selected", sel.selectionCount(), 0);

console.log("\n2. Ctrl-click");
check("consumed", sel.handleRowClick("L", 2, songs, ev({ ctrlKey: true })) === true);
eq("selects one", ids(), ["t2"]);
sel.handleRowClick("L", 5, songs, ev({ ctrlKey: true }));
eq("adds another", ids(), ["t2", "t5"]);
sel.handleRowClick("L", 2, songs, ev({ metaKey: true }));
eq("cmd-click removes an already-selected track", ids(), ["t5"]);
sel.handleRowClick("L", 5, songs, ev({ ctrlKey: true }));
eq("removing the last one clears the selection", sel.selectionCount(), 0);
check("list ownership released", sel.selectionListId() === null);

console.log("\n3. Shift-click ranges");
sel.handleRowClick("L", 1, songs, ev({ ctrlKey: true }));
sel.handleRowClick("L", 4, songs, ev({ shiftKey: true }));
eq("forward range is inclusive", ids(), ["t1", "t2", "t3", "t4"]);
sel.handleRowClick("L", 6, songs, ev({ shiftKey: true }));
eq("re-ranging from the same anchor replaces, not appends", ids(), ["t1", "t2", "t3", "t4", "t5", "t6"]);

sel.clearSelection();
sel.handleRowClick("L", 5, songs, ev({ ctrlKey: true }));
sel.handleRowClick("L", 2, songs, ev({ shiftKey: true }));
eq("backwards range works", ids(), ["t2", "t3", "t4", "t5"]);

console.log("\n4. Selection belongs to one list");
sel.clearSelection();
sel.handleRowClick("A", 0, songs, ev({ ctrlKey: true }));
sel.handleRowClick("A", 1, songs, ev({ ctrlKey: true }));
eq("two selected in list A", sel.selectionCount(), 2);
sel.handleRowClick("B", 4, songs, ev({ ctrlKey: true }));
check("clicking another list takes ownership", sel.selectionListId() === "B");
eq("and starts fresh there", ids(), ["t4"]);
check("list A reports nothing selected", sel.isSelected("A", "t0") === false);

console.log("\n5. Shift-click as the first gesture in a list");
sel.clearSelection();
check("consumed", sel.handleRowClick("C", 3, songs, ev({ shiftKey: true })) === true);
eq("with no anchor it selects just that track", ids(), ["t3"]);

console.log("\n6. Order follows the list, not click order");
sel.clearSelection();
sel.handleRowClick("L", 6, songs, ev({ ctrlKey: true }));
sel.handleRowClick("L", 1, songs, ev({ ctrlKey: true }));
sel.handleRowClick("L", 4, songs, ev({ ctrlKey: true }));
eq("play order is list order", ids(), ["t1", "t4", "t6"]);

console.log("\n7. Select all");
sel.selectAll("L", songs);
eq("everything", sel.selectionCount(), 8);
sel.clearSelection();
eq("cleared", sel.selectionCount(), 0);

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
