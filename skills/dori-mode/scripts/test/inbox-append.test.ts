import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { takeLock } from "../src/checkpoint-lock.ts";
import { appendInboxRow, inboxRows } from "../src/inbox-append.ts";
import { withState } from "./fakes.ts";

setDefaultTimeout(20_000); // the wait tests below hold the lock past the 5 s after which a writer says it is waiting

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

// review 7 of #509: the setup writers outside src appended without <inbox>.lock, so an append taken back to its size
// (above) cut off a row one of them had written whole after its bytes. Each Python writer is run while this process holds
// the lock with half an append written; once it comes to the lock (its flock prints AT_LOCK first) or has written without
// it and left, the append is taken back and the lock let go. The relay's inbox helper runs here as the relay boots it.
const SETUPS = join(import.meta.dir, "../../setups/discord-aoe");
const LOAD = "import fcntl, importlib.machinery as m, importlib.util as u, io, json, sys; flock = fcntl.flock; said = []; fcntl.flock = lambda fd, op: (said or (said.append(1), print('AT_LOCK', flush=True)), flock(fd, op))[1]; l = m.SourceFileLoader('w', sys.argv[1]); mod = u.module_from_spec(u.spec_from_loader('w', l)); l.exec_module(mod); row = json.loads(sys.argv[2]); ";
const setupWriters: Record<string, (inbox: string, row: unknown) => { cmd: string[]; env: Record<string, string> }> = {
  "upstream-watch.py": (inbox, row) => ({ cmd: ["/usr/bin/python3", "-I", "-B", "-c", `${LOAD}mod.append_inbox(row)`, join(SETUPS, "upstream-watch.py"), JSON.stringify(row)], env: { UPSTREAM_WATCH_INBOX: inbox } }),
  "dori-file-relay": (inbox, row) => ({
    cmd: ["/usr/bin/python3", "-I", "-B", "-c", `${LOAD}sys.argv = ['boot', '0', 'inbox', sys.argv[3], sys.argv[4], '30']; sys.stdin = io.TextIOWrapper(io.BytesIO((json.dumps(row) + '\\n').encode())); exec(compile(mod.INBOX.replace('@MAX_PARTS@', '2').replace('@MAX_DEPTH@', '0'), 'inbox', 'exec'), {})`, join(SETUPS, "dori-file-relay"), JSON.stringify(row), dirname(dirname(inbox)), inbox],
    env: {},
  }),
};
// the child's output up to mark, or all of it once it has left (mark "" reads to the end); the pipe stays open for the child
const until = async (reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> }, mark: string): Promise<string> => {
  const dec = new TextDecoder();
  let seen = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += dec.decode(value, { stream: true });
    if (mark && seen.includes(mark)) break;
  }
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
  expect(await until(p.stdout.getReader(), "AT_LOCK")).toContain("AT_LOCK");
  truncateSync(inbox, before); // the append is taken back, as appendInboxRow does when its write fails part way
  release();
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
  expect(rows(inbox)).toEqual([B, C]);
});

// review 8 of #509: a wait with a deadline turned a row away while another writer held the lock, and every caller had
// marked its message seen by then, so the row was lost. An append now waits for as long as the lock is held; past 5 s it
// says so once on stderr (a holder that is stuck, not dead, stops every writer) and goes on waiting. The listener's writer
// and upstream-watch.py, each held past 5 s by this process (the relay keeps the file instead: file-relay.test.ts).
const probeWriter = (inbox: string, row: unknown) => {
  const probe = join(dirname(inbox), "append.ts");
  writeFileSync(probe, `import { appendInboxRow } from ${JSON.stringify(join(import.meta.dir, "../src/inbox-append.ts"))};\nappendInboxRow(${JSON.stringify(inbox)}, ${JSON.stringify(row)});\n`);
  return { cmd: [process.execPath, probe], env: {} };
};
const heldWriters = { "inbox-append.ts": probeWriter, "upstream-watch.py": setupWriters["upstream-watch.py"]! };

test.each(Object.keys(heldWriters))("%s waits past 5 s for a held lock with one INBOX_LOCK_WAIT line, writes nothing meanwhile, and its row goes in once when the lock is let go", async (name) => {
  const inbox = join(state.dir, "za", ".za", "inbox.jsonl");
  mkdirSync(join(state.dir, "za", ".za"), { recursive: true });
  appendInboxRow(inbox, B);
  const release = takeLock(`${inbox}.lock`, Date.now(), "inbox append", inbox);
  const w = heldWriters[name as keyof typeof heldWriters](inbox, C);
  const p = Bun.spawn(w.cmd, { env: { PATH: "/usr/bin:/bin", ...w.env }, stdout: "pipe", stderr: "pipe" });
  const err = p.stderr.getReader();
  const said = await until(err, "INBOX_LOCK_WAIT");
  expect(rows(inbox)).toEqual([B]);
  release();
  const [code, rest] = [await p.exited, await until(err, "")];
  expect({ code, waits: (said + rest).split("\n").filter((l) => l.startsWith("INBOX_LOCK_WAIT")) }).toEqual({ code: 0, waits: [`INBOX_LOCK_WAIT ${inbox} 5`] });
  expect(rows(inbox)).toEqual([B, C]);
});

// review 9 of #509: a release removes the lock file, so another writer can remove the file a waiter just locked while that
// waiter checks it; the check must then take the lock again, not fail the append. The lock file is removed at the first,
// then at the second look the writer takes at the lock path after its flock.
test.each(Object.keys(setupWriters).flatMap((name) => [[name, 1], [name, 2]] as const))("%s takes the lock again when the lock file is removed at its look number %i", async (name, nth) => {
  const inbox = join(state.dir, "za", ".za", "inbox.jsonl");
  mkdirSync(join(state.dir, "za", ".za"), { recursive: true });
  appendInboxRow(inbox, B);
  const w = setupWriters[name]!(inbox, C);
  const gone = `import os; stat = os.stat; looks = [0]\ndef look(p, *a, **k):\n    if str(p).endswith('.lock'):\n        looks[0] += 1\n        if looks[0] == ${nth}: os.unlink(p)\n    return stat(p, *a, **k)\nos.stat = look\n`;
  const cmd = [...w.cmd];
  cmd[4] = gone + cmd[4]!.replaceAll("; ", "\n");
  const p = Bun.spawn(cmd, { env: { PATH: "/usr/bin:/bin", ...w.env }, stdout: "pipe", stderr: "pipe" });
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  expect({ code, err: err.replace("APPENDED\n", "") }).toEqual({ code: 0, err: "" });
  expect(rows(inbox)).toEqual([B, C]);
});
