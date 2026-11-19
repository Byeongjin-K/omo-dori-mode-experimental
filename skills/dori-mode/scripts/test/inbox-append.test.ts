import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendInboxRow } from "../src/inbox-append.ts";
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
