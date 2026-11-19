import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { linesOf } from "../src/heavy-queue.ts";
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
  return { env, freeGb };
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

test("a helper under guard.diskFreeCritGb refuses another host's job before it reads anything", async () => {
  const { env, freeGb } = setup();
  freeGb(5);
  const worker = Bun.spawn([process.execPath, CLI, "heavy-worker", "--caller", "zzangdori"], { env: { ...env, SSH_ORIGINAL_COMMAND: "exec build cpu /tmp/x" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, err] = [await worker.exited, await new Response(worker.stderr).text()];
  expect(code).toBe(3);
  expect(err).toContain("WORKER_REFUSED disk free 5.0 GB < guard.diskFreeCritGb 10 GB on this host");
  // with room again the same request is not refused for the disk
  freeGb(100);
  const ok = Bun.spawn([process.execPath, CLI, "heavy-worker", "--caller", "zzangdori"], { env: { ...env, SSH_ORIGINAL_COMMAND: "exec build cpu /tmp/x" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await ok.exited;
  expect(await new Response(ok.stderr).text()).not.toContain("diskFreeCritGb");
});
