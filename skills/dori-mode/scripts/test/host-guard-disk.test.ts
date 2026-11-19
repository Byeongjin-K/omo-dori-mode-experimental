import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { diskTops, type GuardDeps, guardPass, readGuardState } from "../src/host-guard.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

// 2026-11-19: 0a83's root filled to 21M free and writes failed with ENOSPC at 05:32Z; the guard had printed
// "HOST_GUARD ALERT disk free 48 GB < 50 GB" at 04:29Z into lanes.log only, and no lead heard of it for 75 minutes.
const t = defaultConfig("/home/test").guard;
const sample = (diskFreeGb: number, load1 = 1) => ({ load1, memFreePct: 50, diskFreeGb, swapFreeGb: 2, panes: 3 });
const guardLines = (lines: readonly string[]): string[] => lines.filter((l) => !l.startsWith("HOST_GUARD COMPUTE_"));
const TOPS = "largest under /tmp /var/tmp /home: /tmp/e2e-run3 (gongdori) 165G";

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => {
  chmodSync(state.dir, 0o700);
  state.done();
});

const harness = () => {
  const rows: { kind: string; id: string; content: string }[] = [];
  let tops = 0;
  let fail = 0;
  const deps: GuardDeps = {
    statePath: join(state.dir, "guard.json"),
    now: () => Date.parse("2026-11-19T04:29:00Z"),
    tops: async () => {
      tops++;
      return TOPS;
    },
    inbox: (kind, id, content) => {
      if (fail-- > 0) throw new Error("ENOSPC: no space left on device, write");
      rows.push({ kind, id, content });
    },
  };
  return { rows, deps, tops: () => tops, failNext: (n: number) => (fail = n) };
};

test("a disk alert puts one row in the lead's inbox, no more until it clears, and one again when the disk runs low anew", async () => {
  const h = harness();
  const st = readGuardState(h.deps.statePath);
  // Given/When: the disk goes under guard.diskFreeMinGb
  const first = guardLines(await guardPass(sample(48), t, st, h.deps));
  // Then: the alert line names where the disk went, and the same line is the lead's inbox row
  expect(first[0]).toBe(`HOST_GUARD ALERT disk free 48 GB < 50 GB | ${TOPS}`);
  expect(h.rows).toEqual([{ kind: "host-guard", id: "host-guard-2026-11-19T04:29:00.000Z", content: first[0] ?? "" }]);
  // the same alert again, and after the guard restarts (state read back from its file): no second row
  expect((await guardPass(sample(47), t, st, h.deps)).filter((l) => l.startsWith("HOST_GUARD ALERT"))).toEqual([]);
  expect(guardLines(await guardPass(sample(46), t, readGuardState(h.deps.statePath), h.deps))).toEqual([]);
  // load crossing while the disk alert holds is a new reason on the watch log, but not a new wake
  const loadUp = await guardPass(sample(46, 200), t, readGuardState(h.deps.statePath), h.deps);
  expect(loadUp.some((l) => l.startsWith("HOST_GUARD ALERT") && l.includes("load 200 > 150"))).toBe(true);
  expect(h.rows).toHaveLength(1);
  // the disk has room again: CLEAR, and the lead hears it is over
  const clear = guardLines(await guardPass(sample(200), t, readGuardState(h.deps.statePath), h.deps));
  expect(clear[0]).toStartWith("HOST_GUARD CLEAR ");
  expect(h.rows.map((r) => r.content.split(" ").slice(0, 2).join(" "))).toEqual(["HOST_GUARD ALERT", "HOST_GUARD CLEAR"]);
  // it runs low again: a new row
  await guardPass(sample(30), t, readGuardState(h.deps.statePath), h.deps);
  expect(h.rows).toHaveLength(3);
  expect(h.rows[2]?.content).toStartWith("HOST_GUARD ALERT disk free 30 GB < 50 GB | largest under");
  expect(h.tops()).toBe(2);
});

test("an inbox row that cannot be written is said, and written on the next pass", async () => {
  const h = harness();
  const st = readGuardState(h.deps.statePath);
  h.failNext(1);
  const first = guardLines(await guardPass(sample(10), t, st, h.deps));
  expect(first[1]).toStartWith("HOST_GUARD WAKE_FAIL the lead's inbox row was not written (ENOSPC: no space left on device, write)");
  expect(h.rows).toEqual([]);
  expect(guardLines(await guardPass(sample(10), t, readGuardState(h.deps.statePath), h.deps))).toEqual([]);
  expect(h.rows.map((r) => r.content)).toEqual([first[0] ?? ""]);
});

test("an ALERT row that could not be written is not lost when the disk recovers before the next pass", async () => {
  const h = harness();
  h.failNext(1);
  await guardPass(sample(10), t, readGuardState(h.deps.statePath), h.deps);
  // Given: the ALERT row is owed; When: the next pass is already healthy
  await guardPass(sample(200), t, readGuardState(h.deps.statePath), h.deps);
  // Then: both rows reach the lead, in order
  expect(h.rows.map((r) => r.content.split(" ").slice(0, 2).join(" "))).toEqual(["HOST_GUARD ALERT", "HOST_GUARD CLEAR"]);
  expect(readGuardState(h.deps.statePath).pending).toBeUndefined();
});

test("a state file that could not be written is written on a later pass even when nothing changed, so a restart does not tell the lead again", async () => {
  const h = harness();
  const dir = join(state.dir, "ro");
  mkdirSync(dir);
  const deps = { ...h.deps, statePath: join(dir, "guard.json") };
  const st = readGuardState(deps.statePath);
  chmodSync(dir, 0o500);
  const first = guardLines(await guardPass(sample(10), t, st, deps));
  expect(first.some((l) => l.startsWith(`HOST_GUARD STATE_FAIL ${deps.statePath}`))).toBe(true);
  chmodSync(dir, 0o700);
  // the same alert, nothing new: the file is written now
  expect(guardLines(await guardPass(sample(10), t, st, deps))).toEqual([]);
  expect(readGuardState(deps.statePath)).toEqual({ alerting: true, kinds: ["disk"], told: true });
  // a restarted guard reads it and does not tell the same alert again
  await guardPass(sample(10), t, readGuardState(deps.statePath), deps);
  expect(h.rows).toHaveLength(1);
});

test("the largest folders come with their account and size, biggest first, and what cannot be read is named", async () => {
  // Given: two roots and one that is not there; a folder with a part nobody but root reads
  const a = join(state.dir, "tmp");
  const b = join(state.dir, "var-tmp");
  mkdirSync(join(a, "big"), { recursive: true });
  mkdirSync(join(a, "small"), { recursive: true });
  mkdirSync(join(b, "locked", "inner"), { recursive: true });
  writeFileSync(join(a, "big", "blob"), Buffer.alloc(3 * 1024 * 1024, 1));
  writeFileSync(join(a, "small", "note"), "x");
  chmodSync(join(b, "locked", "inner"), 0o000);
  const me = userInfo().username;
  // When
  const line = await diskTops(run, [a, b, join(state.dir, "gone")]);
  const one = await diskTops(run, [a, b, join(state.dir, "gone")], 1);
  chmodSync(join(b, "locked", "inner"), 0o700);
  // Then
  expect(line).toStartWith(`largest under ${a} ${b} ${join(state.dir, "gone")}: ${join(a, "big")} (${me}) 3M, `);
  expect(line.indexOf(join(a, "big"))).toBeLessThan(line.indexOf(join(a, "small")));
  expect(line).toEndWith(`; 못 읽음 2곳: ${join(state.dir, "gone")} (ENOENT), ${join(b, "locked")} (일부만 셈)`);
  // past n examples only the count grows
  expect(one).toEndWith(`; 못 읽음 2곳: ${join(state.dir, "gone")} (ENOENT), ...`);
});
