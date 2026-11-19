import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { takeLock } from "../src/checkpoint-lock.ts";
import { appendInboxRow, inboxRows } from "../src/inbox-append.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

const rows = (file: string): unknown[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// review 5 of #509: an inbox the guard made first was 0755/0644, and the listener only sets 0700/0600 when it makes them
test("an inbox the first writer makes is private: folder 0700, file 0600", () => {
  const inbox = join(state.dir, "discord", "inbox.jsonl");
  appendInboxRow(inbox, { id: "1" });
  expect([statSync(join(state.dir, "discord")).mode & 0o777, statSync(inbox).mode & 0o777]).toEqual([0o700, 0o600]);
});

// review 5 of #509: a write cut off part way on a full disk left half a JSON row, the next row ran on from it, and the
// listener's restart could not parse the inbox. A child with room for only part of the row (ulimit -f 1: 1024 bytes, the
// row crosses it; SIGXFSZ ignored, the write ends short then fails as on a full disk) appends one.
test("a row the disk had room for only part of is taken back whole, and the next row reads", async () => {
  const inbox = join(state.dir, "inbox.jsonl");
  const before = `${JSON.stringify({ id: "old", content: "x".repeat(900) })}\n`;
  writeFileSync(inbox, before);
  const probe = join(state.dir, "probe.ts");
  writeFileSync(probe, `import { appendInboxRow } from ${JSON.stringify(join(import.meta.dir, "../src/inbox-append.ts"))};
try {
  appendInboxRow(${JSON.stringify(inbox)}, { id: "new", content: "y".repeat(400) });
  console.log("written");
} catch (e) {
  console.log((e as NodeJS.ErrnoException).code);
}`);
  const p = Bun.spawn(["bash", "-c", 'trap "" XFSZ; ulimit -f 1; exec "$0" "$1"', process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
  const [out] = [await new Response(p.stdout).text(), await p.exited];
  // Then: the write failed, and the file is as it was, to the byte
  expect(out.trim()).toBe("EFBIG");
  expect(readFileSync(inbox, "utf8")).toBe(before);
  // with room again the row goes in, and every line is a row
  appendInboxRow(inbox, { id: "new" });
  expect(rows(inbox)).toEqual([{ id: "old", content: "x".repeat(900) }, { id: "new" }]);
});

const B = { id: "7002", ts: "x", scope: "channel" };
const C = { id: "7003", ts: "x", scope: "channel" };

// oh-my-pi #8596 and the challenge of 2026-11-19: a writer killed mid-row leaves a torn prefix, and the next writer's whole
// row runs on from it on one line; skipping that line would lose a row that was written whole
test("a whole row on the end of a torn one is kept, a torn last line is left out, and the reader says so once", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, `{"id":"7001","ts":"x","content":"cut ${JSON.stringify(B)}\n${JSON.stringify(C)}\n{"id":"7004","ts`);
  const notes: string[] = [];
  expect(inboxRows(inbox, (l) => notes.push(l))).toEqual([B, C]);
  expect(notes).toEqual([`INBOX_SKIPPED ${inbox}: 2 line(s) were not whole rows (a write cut off part way) and were left out; every whole row is kept`]);
});

// two writers at once: an append waits for the one that holds <inbox>.lock, so none lands between another's bytes or its
// cut back (a separate open of the lock conflicts in one process too, so this process is the other writer)
test("an append waits for another append's lock, writes nothing while it is held, and goes in once it is let go", () => {
  const inbox = join(state.dir, "inbox.jsonl");
  appendInboxRow(inbox, B);
  const release = takeLock(`${inbox}.lock`, Date.now(), "inbox append", inbox);
  expect(() => appendInboxRow(inbox, C, 20)).toThrow("inbox append locked");
  expect(rows(inbox)).toEqual([B]);
  release();
  appendInboxRow(inbox, C, 20);
  expect(rows(inbox)).toEqual([B, C]);
});

// the same across processes, as the guard, the listener and backlog are: a child's append while this process holds the
// lock fails and writes nothing, and goes in once the lock is let go
test("another process's append waits for the lock this one holds and writes nothing meanwhile", async () => {
  const inbox = join(state.dir, "inbox.jsonl");
  appendInboxRow(inbox, B);
  const probe = join(state.dir, "append.ts");
  writeFileSync(probe, `import { appendInboxRow } from ${JSON.stringify(join(import.meta.dir, "../src/inbox-append.ts"))};
try {
  appendInboxRow(${JSON.stringify(inbox)}, ${JSON.stringify(C)}, 50);
  console.log("written");
} catch (e) {
  console.log((e as Error).message.split(":")[0]);
}`);
  const child = async () => {
    const p = Bun.spawn([process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
    const [out] = [await new Response(p.stdout).text(), await p.exited];
    return out.trim();
  };
  const release = takeLock(`${inbox}.lock`, Date.now(), "inbox append", inbox);
  expect(await child()).toBe("inbox append locked");
  expect(rows(inbox)).toEqual([B]);
  release();
  expect(await child()).toBe("written");
  expect(rows(inbox)).toEqual([B, C]);
});

// review 7 of #509: the setup writers outside src appended without <inbox>.lock, so an append taken back to its size
// (above) cut off a row one of them had written whole after its bytes. Each Python writer is run while this process holds
// the lock with half an append written; once it comes to the lock (its flock prints AT_LOCK first) or has written without
// it and left, the append is taken back and the lock let go. The relay's inbox helper runs here as the relay boots it.
const SETUPS = join(import.meta.dir, "../../setups/discord-aoe");
const LOAD = "import fcntl, importlib.machinery as m, importlib.util as u, io, json, sys; flock = fcntl.flock; said = []; fcntl.flock = lambda fd, op: (said or (said.append(1), print('AT_LOCK', flush=True)), flock(fd, op))[1]; l = m.SourceFileLoader('w', sys.argv[1]); mod = u.module_from_spec(u.spec_from_loader('w', l)); l.exec_module(mod); row = json.loads(sys.argv[2]); ";
const setupWriters: Record<string, (inbox: string, row: unknown) => { cmd: string[]; env: Record<string, string> }> = {
  "upstream-watch.py": (inbox, row) => ({ cmd: ["/usr/bin/python3", "-I", "-B", "-c", `${LOAD}mod.append_inbox(row)`, join(SETUPS, "upstream-watch.py"), JSON.stringify(row)], env: { UPSTREAM_WATCH_INBOX: inbox } }),
  "dori-file-relay": (inbox, row) => ({
    cmd: ["/usr/bin/python3", "-I", "-B", "-c", `${LOAD}sys.argv = ['boot', '0', 'inbox', sys.argv[3], sys.argv[4]]; sys.stdin = io.TextIOWrapper(io.BytesIO((json.dumps(row) + '\\n').encode())); exec(compile(mod.INBOX.replace('@MAX_PARTS@', '2').replace('@MAX_DEPTH@', '0'), 'inbox', 'exec'), {})`, join(SETUPS, "dori-file-relay"), JSON.stringify(row), dirname(dirname(inbox)), inbox],
    env: {},
  }),
};
// the child's output up to AT_LOCK, or all of it once it has left; the pipe stays open for the child
const untilLock = async (out: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = out.getReader();
  const dec = new TextDecoder();
  let seen = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += dec.decode(value, { stream: true });
    if (seen.includes("AT_LOCK")) break;
  }
  reader.releaseLock();
  return seen;
};

test.each(Object.keys(setupWriters))("%s appends under <inbox>.lock: it waits while an append is cut back, and its row then goes in whole", async (name) => {
  const inbox = join(state.dir, "za", ".za", "inbox.jsonl");
  mkdirSync(join(state.dir, "za", ".za"), { recursive: true });
  appendInboxRow(inbox, B);
  const before = statSync(inbox).size;
  const release = takeLock(`${inbox}.lock`, Date.now(), "inbox append", inbox);
  appendFileSync(inbox, '{"id":"7009","content":"cut'); // an append's bytes half written when the disk filled
  const w = setupWriters[name]!(inbox, C);
  const p = Bun.spawn(w.cmd, { env: { PATH: "/usr/bin:/bin", ...w.env }, stdout: "pipe", stderr: "pipe" });
  // the writer comes to the lock, or (without it) has already written and left
  expect(await untilLock(p.stdout)).toContain("AT_LOCK");
  truncateSync(inbox, before); // the append is taken back, as appendInboxRow does when its write fails part way
  release();
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
  expect(rows(inbox)).toEqual([B, C]);
});
