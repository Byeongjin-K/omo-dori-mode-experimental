import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { type GuardDeps, guardPass, readGuardState } from "../src/host-guard.ts";
import type { HcGuardDeps } from "../src/host-guard-hc.ts";
import { type Runner, run } from "../src/run.ts";
import { withState } from "./fakes.ts";

// 2026-11-19: after the disk filled (ENOSPC 05:40Z), hc cores answered every call with "cannot save terminals: registry
// writer stopped" and stayed so when the disk had room again: OkDori's for 3 h 43 min (1342 LANE_WATCH_WARN lines in its
// lanes.log, two update ANNOUNCE_FAIL) and ZzangDori's default core for about 18 h, found only when doriface-host failed to
// restart (omo-update-5179). No lead heard of either.
const t = defaultConfig("/home/test").guard;
const sample = (diskFreeGb = 200) => ({ load1: 1, memFreePct: 50, diskFreeGb, swapFreeGb: 2, panes: 3 });
const STUCK = JSON.stringify({ error: { hint: "", kind: "internal", message: "cannot save terminals: registry writer stopped" } });
const hcLines = (lines: readonly string[]): string[] => lines.filter((l) => l.startsWith("HOST_GUARD HC_"));

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

// a fake hc per core (HC_SESSION, unset: the default core): ls fails as a stopped registry writer does while the core is
// stuck, and as an unreachable core does while it is silent; server restart leaves the core well, still stuck, or silent
const UNAVAILABLE = JSON.stringify({ error: { kind: "unavailable", message: "the core restarted while this ran (an update?)" } });
const fakeHc = (stuck: Set<string>, restartLeaves: "well" | "stuck" | "silent" = "well", silent = new Set<string>()) => {
  const calls: string[] = [];
  const run: Runner = async (argv, opts = {}) => {
    const core = opts.env?.["HC_SESSION"] ?? "default";
    const cmd = argv.join(" ");
    calls.push(`${core}: ${cmd}`);
    if (cmd === "hc --json ls") {
      if (silent.has(core)) return { code: 5, out: "", err: UNAVAILABLE };
      return stuck.has(core) ? { code: 1, out: "", err: STUCK } : { code: 0, out: '{"hidden_finished":0,"terminals":[]}', err: "" };
    }
    if (cmd === "hc --json server restart") {
      if (restartLeaves !== "stuck") stuck.delete(core);
      if (restartLeaves === "silent") silent.add(core);
      return { code: 0, out: '{"live":3,"uptime_ms":9}', err: "" };
    }
    return { code: 127, out: "", err: `no fake for ${cmd}` };
  };
  return { run, calls, restarts: () => calls.filter((c) => c.endsWith("server restart")) };
};

const harness = (hc: HcGuardDeps) => {
  const rows: string[] = [];
  const deps: GuardDeps = {
    statePath: join(state.dir, "guard.json"),
    now: () => Date.parse("2026-11-19T05:41:00Z"),
    tops: async () => "largest under /tmp: nothing read",
    inbox: (_kind, _id, content) => void rows.push(content),
    hc,
  };
  // each pass reads the state back from its file, as a restarted guard would
  const pass = async (diskFreeGb = 200) => hcLines(await guardPass(sample(diskFreeGb), t, readGuardState(deps.statePath), deps));
  return { rows, pass };
};

test("its own stuck core is told to the lead once, restarted on the next pass, and its CLEAR told when hc answers again", async () => {
  // Given: this Dori's core (HC_SESSION=okdori) answers with a stopped registry writer
  const hc = fakeHc(new Set(["okdori"]));
  const h = harness({ cores: [{ name: "okdori", own: true }], up: async () => true, run: hc.run });
  // When: the first pass sees it
  const first = await h.pass();
  // Then: one HC_STUCK line, the lead's inbox row, no restart yet (a single answer may be a core going down)
  expect(first).toHaveLength(1);
  expect(first[0]).toStartWith('HOST_GUARD HC_STUCK okdori: hc ls fails with "cannot save terminals: registry writer stopped"');
  expect(h.rows).toEqual(first);
  expect(hc.restarts()).toEqual([]);
  // When: the next pass still sees it
  const second = await h.pass();
  // Then: the core is restarted (programs and terminal addresses stay), and the lead hears the restart and the CLEAR
  expect(hc.restarts()).toEqual(["okdori: hc --json server restart"]);
  expect(second.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["HOST_GUARD HC_RESTART okdori", "HOST_GUARD HC_CLEAR okdori:"]);
  expect(h.rows).toEqual([...first, ...second]);
  // a later pass with hc well says nothing more
  expect(await h.pass()).toEqual([]);
  expect(h.rows).toHaveLength(3);
});

test("a core it does not own (the doriterm host's default core) is told with the command that revives it, never restarted", async () => {
  const stuck = new Set(["default"]);
  const hc = fakeHc(stuck);
  const h = harness({ cores: [{ name: "zzangdori", own: true }, { name: "default", own: false }], up: async () => true, run: hc.run });
  const first = await h.pass();
  expect(first).toHaveLength(1);
  expect(first[0]).toStartWith('HOST_GUARD HC_STUCK default: hc ls fails with "cannot save terminals: registry writer stopped"');
  expect(first[0]).toContain("hc server restart");
  // three more passes: no second row, no restart
  for (let i = 0; i < 3; i++) expect(await h.pass()).toEqual([]);
  expect(hc.restarts()).toEqual([]);
  expect(h.rows).toEqual(first);
  // someone restarted it: the lead hears it is over, once
  stuck.delete("default");
  const clear = await h.pass();
  expect(clear).toEqual(["HOST_GUARD HC_CLEAR default: hc ls answers again"]);
  expect(h.rows).toEqual([...first, ...clear]);
});

test("a stuck own core is not restarted while the disk is still under guard.diskFreeMinGb, and is once it has room", async () => {
  const hc = fakeHc(new Set(["default"]));
  const h = harness({ cores: [{ name: "default", own: true }], up: async () => true, run: hc.run });
  await h.pass(10);
  const waiting = await h.pass(10);
  expect(waiting).toHaveLength(1);
  expect(waiting[0]).toStartWith("HOST_GUARD HC_RESTART_WAIT default: disk free 10 GB < 50 GB");
  expect(await h.pass(10)).toEqual([]);
  expect(hc.restarts()).toEqual([]);
  const roomy = await h.pass(200);
  expect(hc.restarts()).toEqual(["default: hc --json server restart"]);
  expect(roomy.map((l) => l.split(" ")[1])).toEqual(["HC_RESTART", "HC_CLEAR"]);
});

test("a restart that does not help is told once and not tried again while the core stays stuck", async () => {
  const hc = fakeHc(new Set(["default"]), "stuck");
  const h = harness({ cores: [{ name: "default", own: true }], up: async () => true, run: hc.run });
  await h.pass();
  const second = await h.pass();
  expect(second).toHaveLength(1);
  expect(second[0]).toStartWith("HOST_GUARD HC_RESTART default failed: hc ls still fails after hc server restart");
  for (let i = 0; i < 3; i++) expect(await h.pass()).toEqual([]);
  expect(hc.restarts()).toHaveLength(1);
  expect(h.rows).toHaveLength(2);
});

test("a core that is not running is not asked (an hc call would start it), and another hc failure is not this alert", async () => {
  const notRunning = fakeHc(new Set(["default"]));
  const off = harness({ cores: [{ name: "default", own: true }], up: async () => false, run: notRunning.run });
  expect(await off.pass()).toEqual([]);
  expect(notRunning.calls).toEqual([]);
  const other = fakeHc(new Set(), "well", new Set(["default"]));
  const h = harness({ cores: [{ name: "default", own: true }], up: async () => true, run: other.run });
  expect(await h.pass()).toEqual([]);
  expect(await h.pass()).toEqual([]);
  expect(h.rows).toEqual([]);
});

test("another hc failure during a stuck episode neither clears it nor starts it again, and one after a restart is no success", async () => {
  // Given: a stuck own core, told on the first pass
  const stuck = new Set(["default"]);
  const silent = new Set<string>();
  const hc = fakeHc(stuck, "silent", silent);
  const h = harness({ cores: [{ name: "default", own: true }], up: async () => true, run: hc.run });
  expect((await h.pass()).map((l) => l.split(" ")[1])).toEqual(["HC_STUCK"]);
  // When: the next answer is a timeout-like failure, then the stopped writer again
  silent.add("default");
  expect(await h.pass()).toEqual([]);
  silent.delete("default");
  // Then: no CLEAR, no second HC_STUCK; the episode goes on and the core is restarted, but it does not answer after it
  const restarted = await h.pass();
  expect(hc.restarts()).toHaveLength(1);
  expect(restarted).toHaveLength(1);
  expect(restarted[0]).toStartWith("HOST_GUARD HC_RESTART default failed: hc ls did not answer after hc server restart");
  expect(await h.pass()).toEqual([]);
  // it answers again later: CLEAR once, and no second restart was tried
  silent.delete("default");
  expect(await h.pass()).toEqual(["HOST_GUARD HC_CLEAR default: hc ls answers again"]);
  expect(hc.restarts()).toHaveLength(1);
  expect(h.rows.map((l) => l.split(" ")[1])).toEqual(["HC_STUCK", "HC_RESTART", "HC_CLEAR"]);
});

test("an inherited HC_SOCKET does not point the guard's hc calls at another core", async () => {
  // Given: a guard whose environment carries another core's HC_SOCKET, and an hc that is stuck only when HC_SOCKET is set
  const bin = join(state.dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nif [ -n "$HC_SOCKET" ]; then echo '${STUCK}' >&2; exit 1; fi\necho '{"terminals":[]}'\n`);
  chmodSync(join(bin, "hc"), 0o755);
  const saved = { PATH: process.env["PATH"], HC_SOCKET: process.env["HC_SOCKET"] };
  process.env["PATH"] = `${bin}:${saved.PATH ?? ""}`;
  process.env["HC_SOCKET"] = "/run/user/1/herdr-core/another.sock";
  try {
    const h = harness({ cores: [{ name: "okdori", own: true }], up: async () => true, run });
    // When/Then: the real runner asks the named core with HC_SOCKET removed, so the core answers and nothing is told
    expect(await h.pass()).toEqual([]);
    expect(h.rows).toEqual([]);
  } finally {
    process.env["PATH"] = saved.PATH;
    if (saved.HC_SOCKET === undefined) delete process.env["HC_SOCKET"];
    else process.env["HC_SOCKET"] = saved.HC_SOCKET;
  }
});
