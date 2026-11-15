// From upstream dori-superagent #230 test/adopt-guard.test.ts (https://github.com/sisyphuslabs/dori-superagent/pull/230), fitted to the fork:
// the pane names its runtime (hc:t<n> is hc, else herdr), and the aoe backend checks aoe's live sessions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { adoptLane, LaunchError } from "../src/launch.ts";
import { terminal as hcTerm } from "./fake-hc.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const briefWithDone = (name = "brief.md"): string => {
  const path = join(state.dir, name);
  writeFileSync(path, "# task\n- Done = closed acme/app#3. The lane closes only when every signal reads back live.\n");
  return path;
};
const input = (pane: string, brief = briefWithDone(), key = "demo") => ({ key, title: "t", brief, done: "closed acme/app#3", pane });
const lanesWritten = (): string[] => readdirSync(state.dir).filter((f) => f.endsWith(".json"));

test("adopt refuses a herdr pane the herdr server does not have and registers nothing", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const err = await adoptLane(deps, input("w:p2")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LaunchError);
  expect((err as Error).message).toContain("does not own");
  expect(await deps.registry.read("demo")).toBeNull();
  expect(lanesWritten()).toEqual([]);
});

test("adopt refuses a missing brief and a brief without a Done line", async () => {
  world.panes.push({ pane_id: "w:p2", workspace_id: "w" });
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, input("w:p2", join(state.dir, "gone.md")))).rejects.toThrow("brief not found");
  const plain = join(state.dir, "plain.md");
  writeFileSync(plain, "# task\nno done line here\n");
  await expect(adoptLane(deps, input("w:p2", plain))).rejects.toThrow("no Done line");
  expect(await deps.registry.read("demo")).toBeNull();
});

test("on herdr, adopt takes a pane of the server, and with laneWorkspace only one in that workspace", async () => {
  world.panes.push({ pane_id: "w:p2", workspace_id: "w" }, { pane_id: "x:p1", workspace_id: "x" });
  const lane = await adoptLane(depsFor(world, fakeClock(T0), state.dir), input("w:p2"));
  expect(lane.pane).toBe("w:p2");
  const scoped = depsFor(world, fakeClock(T0), state.dir, { laneWorkspace: "x" });
  await expect(adoptLane(scoped, input("w:p2", briefWithDone("b2.md"), "other"))).rejects.toThrow("does not own");
  expect((await adoptLane(scoped, input("x:p1", briefWithDone("b3.md"), "third"))).pane).toBe("x:p1");
});

test("on hc, adopt only takes a terminal labelled into the lane group: laneWorkspace, else dori", async () => {
  world.terminals = { t7: hcTerm({ labels: { "dori.group": "lanes" } }), t8: hcTerm({ labels: { "dori.group": "dori" } }), t9: hcTerm({ title: "swarm worker" }) };
  const scoped = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", laneWorkspace: "lanes" });
  expect((await adoptLane(scoped, input("hc:t7"))).pane).toBe("hc:t7");
  await expect(adoptLane(scoped, input("hc:t8", briefWithDone("b2.md"), "other"))).rejects.toThrow("does not own");
  const plain = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc" });
  expect((await adoptLane(plain, input("hc:t8", briefWithDone("b3.md"), "third"))).pane).toBe("hc:t8");
  await expect(adoptLane(plain, input("hc:t9", briefWithDone("b4.md"), "fourth"))).rejects.toThrow("does not own");
  expect(await plain.registry.read("fourth")).toBeNull();
});

test("a tmux name must be a live aoe agent session: a plain terminal with the same id suffix and a name tmux lacks are refused", async () => {
  world.aoe = [{ id: "abcdef1234", title: "x", path: "/w", tool: "omo" }];
  world.tmux = ["aoe_x_abcdef12", "aoe_term_fix-a_abcdef12"];
  const deps = depsFor(world, fakeClock(T0), state.dir, { backend: "aoe" });
  expect((await adoptLane(deps, input("aoe_x_abcdef12"))).pane).toBe("aoe_x_abcdef12");
  await expect(adoptLane(deps, input("aoe_term_fix-a_abcdef12", briefWithDone("b2.md"), "other"))).rejects.toThrow("does not own");
  world.tmux = ["aoe_x_abcdef12"];
  await expect(adoptLane(deps, input("aoe_y_abcdef12", briefWithDone("b3.md"), "third"))).rejects.toThrow("does not own");
});

test("the pane's own address picks the listing: on the aoe backend a herdr pane of laneWorkspace is adopted, one outside it refused", async () => {
  world.panes.push({ pane_id: "w1:p2", workspace_id: "w1" }, { pane_id: "w9:p1", workspace_id: "w9" });
  const deps = depsFor(world, fakeClock(T0), state.dir, { backend: "aoe", laneWorkspace: "w1" });
  expect((await adoptLane(deps, input("w1:p2"))).pane).toBe("w1:p2");
  await expect(adoptLane(deps, input("w9:p1", briefWithDone("b2.md"), "other"))).rejects.toThrow("does not own");
});

test("a failing session listing refuses the adopt with the listing's reason", async () => {
  world.aoeListError = "aoe down";
  const deps = depsFor(world, fakeClock(T0), state.dir, { backend: "aoe" });
  await expect(adoptLane(deps, input("aoe_x_abcdef12"))).rejects.toThrow("cannot list");
  delete world.aoeListError;
  world.aoe = [{ id: "abcdef1234", title: "x", path: "/w", tool: "omo" }];
  world.tmuxLsError = "no server running";
  await expect(adoptLane(deps, input("aoe_x_abcdef12"))).rejects.toThrow("tmux ls failed: no server running");
  expect(await deps.registry.read("demo")).toBeNull();
});
