// The test-hygiene ratchet (src/lint/ratchet.ts, from upstream https://github.com/sisyphuslabs/dori-superagent/pull/250)
// run as `bun run lint:ratchet` runs it: the real CLI in a throwaway tree with its own lint-ratchet-baseline.json.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "../src/lint/ratchet.ts");
const MOCK = "dori-testing/no-module-mock";
const SLEEP = "dori-testing/no-fixed-sleep";
const FLAKE = "dori-testing/no-flake-masking";

const moduleMock = 'import { mock } from "bun:test";\nmock.module("../src/a.ts", () => ({}));\n';
const fixedSleep = 'import { test } from "bun:test";\ntest("x", async () => { await Bun.sleep(100); });\n';
const retried = 'import { test } from "bun:test";\ntest("x", { retry: 2 }, async () => {});\n';
const clean = 'import { expect, test } from "bun:test";\ntest("x", () => { expect(1).toBe(1); });\n';

const tree = (files: Record<string, string>, baseline?: Record<string, Record<string, number>>) => {
  const root = mkdtempSync(join(tmpdir(), "lint-ratchet-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  if (baseline) writeFileSync(join(root, "lint-ratchet-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
};

const ratchet = async (root: string, ...args: string[]) => {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
};

const baselineOf = (root: string): unknown => JSON.parse(readFileSync(join(root, "lint-ratchet-baseline.json"), "utf8"));

test("a tree with no finding passes with an empty baseline", async () => {
  const t = tree({ "test/a.test.ts": clean, "src/a.ts": "export const a = 1;\n" }, {});
  try {
    expect(await ratchet(t.root)).toEqual({ code: 0, out: "lint-ratchet: every count matches the baseline\n" });
  } finally {
    t.done();
  }
});

test("a new module mock, fixed sleep or retry in a file the baseline does not list fails, naming file and rule", async () => {
  const t = tree({ "test/a.test.ts": moduleMock, "test/b.test.ts": fixedSleep, "test/c.test.ts": retried }, {});
  try {
    const { code, out } = await ratchet(t.root);
    expect(code).toBe(1);
    expect(out).toContain(`test/a.test.ts: ${MOCK} went up from 0 to 1`);
    expect(out).toContain(`test/b.test.ts: ${SLEEP} went up from 0 to 1`);
    expect(out).toContain(`test/c.test.ts: ${FLAKE} went up from 0 to 1`);
    expect(out).toContain("test/a.test.ts:2 ");
  } finally {
    t.done();
  }
});

test("a finding already pinned in the baseline passes; one more than the baseline fails", async () => {
  const t = tree({ "test/a.test.ts": moduleMock }, { "test/a.test.ts": { [MOCK]: 1 } });
  try {
    expect((await ratchet(t.root)).code).toBe(0);
    writeFileSync(join(t.root, "test/a.test.ts"), `${moduleMock}mock.module("../src/b.ts", () => ({}));\n`);
    const grown = await ratchet(t.root);
    expect(grown.code).toBe(1);
    expect(grown.out).toContain(`test/a.test.ts: ${MOCK} went up from 1 to 2`);
  } finally {
    t.done();
  }
});

test("a drop fails until --update lowers the baseline, and the lowered baseline then passes", async () => {
  const t = tree({ "test/a.test.ts": clean }, { "test/a.test.ts": { [MOCK]: 1 } });
  try {
    const dropped = await ratchet(t.root);
    expect(dropped.code).toBe(1);
    expect(dropped.out).toContain(`test/a.test.ts: ${MOCK} went down from 1 to 0; lower the baseline in this change`);
    expect((await ratchet(t.root, "--update")).code).toBe(0);
    expect(baselineOf(t.root)).toEqual({});
    expect((await ratchet(t.root)).code).toBe(0);
  } finally {
    t.done();
  }
});

test("--update refuses to raise a count unless --allow-increase is passed", async () => {
  const t = tree({ "test/a.test.ts": moduleMock }, {});
  try {
    const refused = await ratchet(t.root, "--update");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("--update only lowers counts");
    expect(baselineOf(t.root)).toEqual({});
    expect((await ratchet(t.root, "--update", "--allow-increase")).code).toBe(0);
    expect(baselineOf(t.root)).toEqual({ "test/a.test.ts": { [MOCK]: 1 } });
  } finally {
    t.done();
  }
});

test("a file that does not parse fails, because its findings cannot be counted", async () => {
  const t = tree({ "test/a.test.ts": "test(\"x\", () => {\n" }, {});
  try {
    const { code, out } = await ratchet(t.root);
    expect(code).toBe(1);
    expect(out).toContain("test/a.test.ts");
    expect(out).toContain("fails to parse");
  } finally {
    t.done();
  }
});
