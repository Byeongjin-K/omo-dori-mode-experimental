import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimDone, closeLane } from "../src/done-flow.ts";
import { footer } from "../src/launch-footer.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// dori-superagent #252 (lane rule 9): a lane's scratch checkouts live under ~/.cache/dori-scratch/<key>/, never /tmp, and
// are gone before the lane says done; claim-done and close name a folder still there and never remove it.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 3_600_000).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
let home: string;
const savedHome = process.env["HOME"];
const at = () => depsFor(world, fakeClock(T0), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const scratch = () => join(home, ".cache", "dori-scratch", lane.key);

beforeEach(async () => {
  state = withState();
  world = newWorld();
  home = join(state.dir, "home");
  mkdirSync(home);
  process.env["HOME"] = home;
  await at().registry.write(lane);
});
afterEach(() => {
  process.env["HOME"] = savedHome;
  state.done();
});

test("the lane footer puts scratch checkouts in the lane's own folder, not /tmp, gone before done", () => {
  const line = footer(lane, "lead:p1").split("\n").find((l) => l.startsWith("- Never clone")) ?? "";
  expect(line).toContain("~/.cache/dori-scratch/demo-lane/");
  expect(line).toContain("/tmp");
});

test("close names a scratch folder the lane left, with its size, and keeps it", async () => {
  mkdirSync(join(scratch(), "clone"), { recursive: true });
  writeFileSync(join(scratch(), "clone", "big"), Buffer.alloc(3 * 1024 * 1024));
  const r = await closeLane(at(), lane, "manual", "Done.");
  expect(r.closed).toBe(true);
  expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^DORI_SCRATCH_LEFT demo-lane 3\\.0M ${scratch()}`)));
  expect(Bun.file(join(scratch(), "clone", "big")).size).toBe(3 * 1024 * 1024);
});

test("close says nothing about scratch when the lane removed its folder", async () => {
  const r = await closeLane(at(), lane, "manual", "Done.");
  expect(r.closed).toBe(true);
  expect(r.lines.filter((l) => l.startsWith("DORI_SCRATCH_LEFT"))).toEqual([]);
});

test("claim-done names a scratch folder still there, while the lane can still remove it", async () => {
  mkdirSync(scratch(), { recursive: true });
  writeFileSync(join(scratch(), "a"), "x".repeat(2048));
  const out = await claimDone(at(), lane, "merged acme/app#1");
  expect(out.split("\n")).toContainEqual(expect.stringMatching(/^DORI_SCRATCH_LEFT demo-lane 2\.0K /));
  expect(await claimDone(at(), { ...lane, key: "other-lane" }, "merged acme/app#1")).not.toContain("DORI_SCRATCH_LEFT");
});
