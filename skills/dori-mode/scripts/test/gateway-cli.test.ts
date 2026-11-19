// The fork's flag shape for upstream dori-superagent #255 (https://github.com/sisyphuslabs/dori-superagent/pull/255):
// --question takes the question text (the fork's --question is a string flag), and --status start|update|stop is the
// gateway's own, not discord's working|done.
import { expect, setDefaultTimeout, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";
setDefaultTimeout(30_000); // load-proof: each test starts the dori CLI (bun src/cli.ts) as a child process, as send-cli.test.ts does

const withSocket = async (body: (path: string, frames: Record<string, unknown>[], dir: string) => Promise<void>) => {
  const state = withState();
  const path = join(state.dir, "dori.sock");
  const frames: Record<string, unknown>[] = [];
  const server = createServer((socket) =>
    socket.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        socket.write(`${JSON.stringify({ op: "result", re: frame["op"], code: "ok", op_id: frame["op_id"] })}\n`);
      }
    }),
  );
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    await body(path, frames, state.dir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    state.done();
  }
};
const dori = (path: string, dir: string, ...args: string[]) =>
  run(viaEnvFile(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${join(dir, "state")}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, `DORI_GATEWAY_SOCKET=${path}`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "gateway", ...args]));

test("send gateway --question TEXT asks with numbered options, and --status start opens a status row", async () => {
  await withSocket(async (path, frames, dir) => {
    const asked = await dori(path, dir, "--question", "Pay 12,000 KRW?", "--option", "Yes", "--option", "No");
    const started = await dori(path, dir, "--status", "start", "--text", "Working", "--row", "running:Build");
    expect(asked.code).toBe(0);
    expect(asked.out).toMatch(/^QUESTION [\w-]+$/);
    expect(started.code).toBe(0);
    expect(started.out).toMatch(/^STATUS [\w-]+$/);
    expect(frames.map(({ op_id: _, ...frame }) => frame)).toEqual([
      { op: "send", kind: "question", text: "Pay 12,000 KRW?", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] },
      { op: "send", kind: "status", status_id: frames[1]?.["op_id"], phase: "start", text: "Working", rows: [{ id: "r1", label: "Build", state: "running" }] },
    ]);
  });
});

test("a gateway send with an option of another messenger or a discord status is refused before anything is written", async () => {
  await withSocket(async (path, frames, dir) => {
    const results = [await dori(path, dir, "--to", "x", "--text", "hi"), await dori(path, dir, "--status", "working", "--text", "hi"), await dori(path, dir, "--question", "One?", "--option", "Only")];
    expect(results.map((r) => r.code)).toEqual([2, 1, 1]);
    expect(frames).toEqual([]);
  });
});
