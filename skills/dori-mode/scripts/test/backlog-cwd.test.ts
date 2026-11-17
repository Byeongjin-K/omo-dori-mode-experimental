// dori backlog add --cwd: a directory that is not there is refused at add, not hours later when a pass starts the lane in it
// (upstream #245, https://github.com/sisyphuslabs/dori-superagent/pull/245).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItem, BacklogError, readItem } from "../src/backlog.ts";

let root: string;
let state: string;
let brief: string;

const add = (id: string, cwd?: string) => addItem(state, { id, title: id, brief, done: "file /tmp/x", ...(cwd === undefined ? {} : { cwd }) }, { registered: false, at: "2026-11-17T00:00:00Z" }).item;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backlog-cwd-"));
  state = join(root, "state");
  brief = join(root, "brief.md");
  writeFileSync(brief, "ulw\n\n[목표] read a file\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("add refuses a --cwd that is missing or a file and stores nothing; a real directory is kept; no --cwd stays without one", () => {
  // Given / When / Then
  expect(() => add("c1", join(root, "gone"))).toThrow(BacklogError);
  expect(() => add("c1", join(root, "gone"))).toThrow(`--cwd ${join(root, "gone")} is not a directory`);
  expect(() => add("c1", brief)).toThrow(`--cwd ${brief} is not a directory`);
  expect(() => add("c1", join(brief, "child"))).toThrow(`--cwd ${join(brief, "child")} is not a directory`);
  expect(readItem(state, "c1")).toBeUndefined();
  mkdirSync(join(root, "repo"));
  expect(add("c2", join(root, "repo", "..", "repo")).cwd).toBe(join(root, "repo"));
  expect(add("c3").cwd).toBeUndefined();
});
