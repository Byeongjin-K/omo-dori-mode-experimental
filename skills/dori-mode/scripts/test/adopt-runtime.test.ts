// From upstream dori-superagent #223 test/adopt-runtime.test.ts (https://github.com/sisyphuslabs/dori-superagent/pull/223,
// issue #222), fitted to the fork: a lane's pane names its runtime as hc:<id>, <ws>:<pane> (herdr) or an aoe tmux name,
// and the ownership check of upstream #230 (adopt-guard.test.ts) still runs on the address the pane is recorded under.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "../src/config.ts";
import { adoptLane } from "../src/launch.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.terminals = { t4q: hcTerm({ labels: { "dori.group": "dori" } }), t7: hcTerm({ labels: { "dori.group": "dori" } }), t9: hcTerm({ title: "swarm worker" }) };
  world.panes.push({ pane_id: "w1:p3", workspace_id: "w1" });
  world.aoe = [{ id: "abcdef1234", title: "x", path: "/w", tool: "omo" }];
  world.tmux = ["aoe_x_abcdef12"];
});
afterEach(() => state.done());

const adopted = async (patch: Partial<DoriConfig>, pane: string) => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# task\n- Done = closed acme/app#3.\n");
  const deps = depsFor(world, fakeClock(T0), state.dir, patch);
  const key = `adopted-${Object.values(patch).join("-")}-${pane.replace(/[^a-z0-9]/g, "")}`;
  const pinned = process.env["DORI_RUNTIME"];
  delete process.env["DORI_RUNTIME"]; // the preload pins herdr; here the config's runtime picks, as on a Dori
  try {
    await adoptLane(deps, { key, title: "t", brief, done: "closed acme/app#3", pane });
  } finally {
    if (pinned !== undefined) process.env["DORI_RUNTIME"] = pinned;
  }
  return (await deps.registry.read(key))?.pane;
};

test("a bare pane id adopted on an hc config is recorded as an hc terminal (#222)", async () => {
  expect(await adopted({ runtime: "hc" }, "t4q")).toBe("hc:t4q");
});

test("a bare id on hc is checked as an hc terminal: one outside the lane group is refused", async () => {
  await expect(adopted({ runtime: "hc" }, "t9")).rejects.toThrow("is not one of dori's sessions (hc dori.group=dori)");
});

test("an address that names its runtime wins over the configured runtime", async () => {
  expect(await adopted({ runtime: "hc" }, "w1:p3")).toBe("w1:p3");
  expect(await adopted({ runtime: "herdr" }, "hc:t7")).toBe("hc:t7");
});

test("an aoe tmux name stays an aoe session on hc, and a bare id on herdr or the aoe backend keeps the tmux reading", async () => {
  expect(await adopted({ runtime: "hc" }, "aoe_x_abcdef12")).toBe("aoe_x_abcdef12");
  await expect(adopted({ runtime: "herdr" }, "t4q")).rejects.toThrow("(aoe live agent sessions)");
  await expect(adopted({ runtime: "hc", backend: "aoe" }, "t4q")).rejects.toThrow("(aoe live agent sessions)");
});
