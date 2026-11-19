import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
