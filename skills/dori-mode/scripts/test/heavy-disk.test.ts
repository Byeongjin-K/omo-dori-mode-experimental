import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { linesOf } from "../src/heavy-queue.ts";
import { acquire, acquireSlot, admitOnce, releaseSlot, type SlotDeps } from "../src/heavy-slot.ts";
import { startExec } from "../src/heavy-spread.ts";
import { withState } from "./fakes.ts";

setDefaultTimeout(30_000); // load-proof: each case starts the real CLI, and the running job a systemd scope, as child processes

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

const CLI = join(import.meta.dir, "../src/cli.ts");

// a df on PATH that answers the free KB written in <dir>/avail, so no test fills a real disk
const setup = () => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  const avail = join(state.dir, "avail");
  writeFileSync(join(bin, "df"), `#!/bin/sh\nprintf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/fake 1000000000 1 %s 1%% /\\n' "$(cat ${avail})"\n`);
  chmodSync(join(bin, "df"), 0o755);
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "state"), heavyHoldDir: join(state.dir, "hold"), heavyMaxLoad: 100000 }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_") && k !== "SSH_ORIGINAL_COMMAND"));
  const env = { ...own, PATH: `${bin}:${process.env["PATH"] ?? ""}`, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") };
  const freeGb = (gb: number) => writeFileSync(avail, String(gb * 1_048_576));
  return { env, freeGb, config };
};

test("under guard.diskFreeCritGb dori heavy takes no new job and says why, while a job already running goes on to its end", async () => {
  const { env, freeGb } = setup();
  const fifo = join(state.dir, "fifo");
  expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
  // Given: a job started while the disk had room, now waiting on the fifo
  freeGb(100);
  const running = Bun.spawn([process.execPath, CLI, "heavy", "first", "--", "sh", "-c", `echo up; cat ${fifo} > /dev/null`], { env, stdout: "pipe", stderr: "pipe" });
  expect((await linesOf(running.stdout).next()).value).toBe("up");
  // When: the disk goes under the critical floor and a new job asks
  freeGb(5);
  const next = Bun.spawn([process.execPath, CLI, "heavy", "second", "--", "true"], { env, stdout: "pipe", stderr: "pipe" });
  const [code, err] = [await next.exited, await new Response(next.stderr).text()];
  // Then: refused with its reason; the running one is not touched and ends with its own exit code
  expect(code).toBe(2);
  expect(err).toContain("HEAVY_REFUSED second: disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host; no new heavy job starts until there is room (jobs already running go on)");
  writeFileSync(fifo, "go\n");
  expect(await running.exited).toBe(0);
});

test("a dori heavy that a running job starts under guard.diskFreeCritGb is part of that job and runs", async () => {
  const { env, freeGb } = setup();
  freeGb(100);
  // the outer job lowers the disk, then starts its own dori heavy: refused as a new job would be, it would cut the job
  const inner = `echo $((5 * 1048576)) > ${join(state.dir, "avail")}; ${process.execPath} ${CLI} heavy inner -- sh -c 'echo inner ran'`;
  const outer = Bun.spawn([process.execPath, CLI, "heavy", "outer", "--", "sh", "-c", inner], { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = [await outer.exited, await new Response(outer.stdout).text(), await new Response(outer.stderr).text()];
  expect([code, out]).toEqual([0, "inner ran\n"]);
  expect(err).toContain("HEAVY_NESTED inner");
  expect(err).not.toContain("HEAVY_REFUSED");
});

test("a helper under guard.diskFreeCritGb is busy for another host's job, so the caller tries again later or elsewhere", async () => {
  const { env, freeGb, config } = setup();
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), heavyQueue: { exec: true, jobDir: join(state.dir, "jobs") } }));
  const ask = async () => {
    const worker = Bun.spawn([process.execPath, CLI, "heavy-worker", "--caller", "zzangdori"], { env: { ...env, SSH_ORIGINAL_COMMAND: "exec build cpu 100" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: await worker.exited, err: await new Response(worker.stderr).text() };
  };
  freeGb(5);
  const low = await ask();
  expect(low.code).toBe(75);
  expect(low.err).toContain("WORKER_BUSY disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host");
  // with room again it is admitted (and then finds no job sent on its stdin)
  freeGb(100);
  const ok = await ask();
  expect(ok.err).toContain("WORKER_ADMIT");
  expect(ok.err).not.toContain("diskFreeCritGb");
});

test("a job already waiting in line does not start while the disk is under the floor, and starts once there is room", async () => {
  const lines: string[] = [];
  let full: string | undefined = "disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host";
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { if (++polls === 3) full = undefined; } };
  const deps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock, pid: process.pid, load: async () => 1, alive: () => true, log: (l: string) => lines.push(l), disk: async () => full };
  // admitOnce, the admission of a batch item or another host's job, is busy for the disk
  expect(await admitOnce(deps, "item")).toEqual({ wait: "disk", why: "disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host" });
  const slot = await acquireSlot(deps, "waiting", 1);
  expect(lines[0]).toBe("HEAVY_WAIT waiting: disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host");
  expect(lines.at(-1)).toStartWith("HEAVY_ADMIT waiting slot.1");
  expect(polls).toBe(3);
  releaseSlot(slot);
});

const FULL = "disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host";
const slotDeps = (disk: () => Promise<string | undefined>, sleep: () => Promise<void> = () => new Promise((r) => setImmediate(r))): SlotDeps => ({ dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep }, pid: process.pid, load: async () => 1, alive: () => true, disk });

test("under guard.diskFreeCritGb a waiting job is not sent to a helper either, and no job goes out through startExec", async () => {
  let full: string | undefined = FULL;
  let polls = 0;
  let offered = 0;
  const deps = slotDeps(async () => full, async () => { if (++polls === 3) full = undefined; });
  // a held slot here, so with room the job goes elsewhere
  const held = await acquireSlot({ ...deps, disk: async () => undefined }, "holder");
  const got = await acquire(deps, "spread", { pollMs: 1, elsewhere: async () => { offered++; return full ? "sent while full" : "sent"; } });
  expect(got).toEqual({ elsewhere: "sent" });
  expect(offered).toBe(1);
  releaseSlot(held);
  // the remote dispatch of --kind jobs and batch items says busy before it stages anything
  const job = { label: "x", kind: "cpu" as const, cmd: ["true"], cwd: state.dir, sync: [], env: {} };
  expect(await startExec({ q: { jobs: {}, helpers: [], queue: [], rl: true, jobDir: state.dir, exec: true, execMaxMin: 5 }, deps: slotDeps(async () => FULL) }, { name: "h", ssh: ["false"] }, job, { ok: true, sync: [], needs: [], which: [] }, 100)).toEqual({ kind: "busy", why: FULL });
});

test("the owner's transcription passes the disk floor: at dori heavy --job and past jobs that wait for room", async () => {
  const { env, freeGb } = setup();
  freeGb(5);
  const cli = Bun.spawn([process.execPath, CLI, "heavy", "voice", "--job", "transcribe"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [, err] = [await cli.exited, await new Response(cli.stderr).text()];
  expect(err).not.toContain("diskFreeCritGb");
  // Given: a job waiting in line for room; When: the transcription asks; Then: it takes the slot first
  let full: string | undefined = FULL;
  const deps = slotDeps(async () => full);
  const waiting = acquire(deps, "waiting", { pollMs: 1 });
  const queue = join(state.dir, "heavy", "queue");
  while (!existsSync(queue) || !readdirSync(queue).length) await new Promise((r) => setImmediate(r));
  const owner = await acquire(deps, "voice", { pollMs: 1, holdExempt: true });
  expect("slot" in owner).toBe(true);
  if ("slot" in owner) releaseSlot(owner.slot);
  full = undefined;
  const w = await waiting;
  if ("slot" in w) releaseSlot(w.slot);
  expect("slot" in w).toBe(true);
});
