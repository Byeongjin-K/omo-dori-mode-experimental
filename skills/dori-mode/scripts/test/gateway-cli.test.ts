// The fork's flag shape for upstream dori-superagent #255 (https://github.com/sisyphuslabs/dori-superagent/pull/255):
// --question takes the question text (the fork's --question is a string flag), and --status start|update|stop is the
// gateway's own, not discord's working|done.
import { expect, setDefaultTimeout, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";
setDefaultTimeout(30_000); // load-proof: each test starts the dori CLI (bun src/cli.ts) as a child process, as send-cli.test.ts does

type Reply = (frame: Record<string, unknown>, connection: number) => readonly Record<string, unknown>[];
const okReply: Reply = (frame) => [{ op: "result", re: frame["op"], code: "ok", op_id: frame["op_id"] }];
const withSocket = async (body: (path: string, frames: Record<string, unknown>[], dir: string) => Promise<void>, reply: Reply = okReply) => {
  const state = withState();
  const path = join(state.dir, "dori.sock");
  const frames: Record<string, unknown>[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    const connection = ++connections;
    socket.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        for (const answer of reply(frame, connection)) socket.write(`${JSON.stringify(answer)}\n`);
      }
    });
  });
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

test("inbound gateway whose stdout refuses the line acks nothing, so the gateway keeps the message to resend (review 1 of #511)", async () => {
  // Given a gateway that pushes one message on the first subscription and refuses any later one, and answers an ack
  // with a refusal, so the CLI ends either way.
  const reply: Reply = (frame, connection) =>
    frame["op"] !== "subscribe"
      ? [{ op: "result", re: "subscribe", code: "invalid" }]
      : connection > 1
        ? [{ op: "result", re: "subscribe", code: "invalid" }]
        : [{ op: "result", re: "subscribe", code: "ok" }, { op: "inbound", seq: 1, session_id: "lead-1", id: "m1", created_at: 1, kind: "message", text: "hello" }];
  await withSocket(async (path, frames, dir) => {
    // When the monitor's stdout refuses every write (/dev/full, as a pipe whose reader is gone does; a closed fd 1 is
    // reopened on /dev/null by bun, where no writer can tell).
    const env = viaEnvFile(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${join(dir, "state")}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, `DORI_GATEWAY_SOCKET=${path}`]);
    const result = await run(["sh", "-c", 'exec "$@" > /dev/full', "sh", ...env, "bun", join(import.meta.dir, "../src/cli.ts"), "inbound", "gateway", "--session", "lead-1"]);
    // Then it fails, and no ack went out for the message nobody saw.
    expect(result.code).not.toBe(0);
    expect(frames.filter((f) => f["op"] === "ack")).toEqual([]);
  }, reply);
});

test("the same gateway message twice is sent once, also when both start together; --again sends it once more (review 2 of #511)", async () => {
  await withSocket(async (path, frames, dir) => {
    // Given one state dir; when the same text is sent twice in a row, then twice at the same moment, then with --again.
    const first = await dori(path, dir, "--text", "the tests pass");
    const second = await dori(path, dir, "--text", "the tests pass");
    const together = await Promise.all([dori(path, dir, "--question", "Merge?", "--option", "Yes", "--option", "No"), dori(path, dir, "--question", "Merge?", "--option", "Yes", "--option", "No")]);
    const again = await dori(path, dir, "--text", "the tests pass", "--again");
    // Then the repeat names the first message and exits 3, one of the two together posts, and --again posts.
    expect(first.code).toBe(0);
    expect([second.code, second.out.split(" ")[0]]).toEqual([3, "SEND_DUPLICATE"]);
    expect(together.map((r) => r.code).sort()).toEqual([0, 3]);
    expect(again.code).toBe(0);
    expect(frames.map((f) => f["kind"])).toEqual(["post", "question", "post"]);
  });
});
