import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { publishWorklog, renderUntilStable, Worklog, WORKLOG_MARKER, WorklogError } from "../src/worklog.ts";
import { withState } from "./fakes.ts";

// Upstream test from https://github.com/sisyphuslabs/dori-superagent/pull/96 (commit 067b70f).

setDefaultTimeout(30_000); // load-proof: the CLI tests here start the dori CLI (bun src/cli.ts) as child processes, some at once; a loaded host (40-67 on 20 cores) slows them several times over, so this file, not the suite, gets 30 s

const cli = join(import.meta.dir, "../src/cli.ts");

const T0 = Date.parse("2026-11-04T00:00:00Z");

const cliIn = (dir: string) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  return (...args: string[]) => run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, cli, ...args]);
};

test("add, next, note and close build one markdown heading per item with Source, Next, Notes and Result", () => {
  // Given a worklog with one item taken through its whole life and one still open.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const done = log.add("Rotate the bot token", "slack:D1/100.1", T0);
    log.next(done.id, "ask the owner for the new token", T0 + 1);
    log.note(done.id, "owner: rotate before Friday", T0 + 2);
    const closed = log.close(done.id, "rotated; inbound reads back", T0 + 3);
    const open = log.add("Fix the flaky upload test", "slack:D1/100.2", T0 + 4);
    // Then the returned item, the reread record and the rendered file agree.
    expect(closed).toEqual({
      id: done.id, title: "Rotate the bot token", source: "slack:D1/100.1", openedAt: new Date(T0).toISOString(),
      next: "ask the owner for the new token", notes: [{ at: new Date(T0 + 2).toISOString(), text: "owner: rotate before Friday" }],
      closedAt: new Date(T0 + 3).toISOString(), result: "rotated; inbound reads back",
    });
    expect(log.open().map((item) => item.id)).toEqual([open.id]);
    expect(readFileSync(log.markdownPath, "utf8")).toBe(`${WORKLOG_MARKER}
# Worklog

## Open

### ${open.id} Fix the flaky upload test
- Source: slack:D1/100.2
- Opened: 2026-11-04T00:00:00.004Z
- Next: (none yet)

## Closed

### ${done.id} Rotate the bot token
- Source: slack:D1/100.1
- Opened: 2026-11-04T00:00:00.000Z
- Next: ask the owner for the new token
- Notes:
  - 2026-11-04T00:00:00.002Z owner: rotate before Friday
- Closed: 2026-11-04T00:00:00.003Z
- Result: rotated; inbound reads back
`);
  } finally { state.done(); }
});

test("an unknown or closed item, or a multi-line text, is refused and writes nothing", () => {
  // Given one closed item.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const item = log.add("Done already", "slack:D1/1.1", T0);
    log.close(item.id, "shipped", T0 + 1);
    const before = [readFileSync(log.path, "utf8"), readFileSync(log.markdownPath, "utf8")];
    // When changing it, an unknown id, or adding a two-line title; then each is refused and both files are unchanged.
    expect(() => log.next(item.id, "more", T0 + 2)).toThrow(`worklog item ${item.id} is closed: shipped`);
    expect(() => log.note("0000beef", "x", T0 + 2)).toThrow("worklog item not found: 0000beef");
    expect(() => log.add("two\nlines", "slack:D1/1.2", T0 + 2)).toThrow(WorklogError);
    expect([readFileSync(log.path, "utf8"), readFileSync(log.markdownPath, "utf8")]).toEqual(before);
  } finally { state.done(); }
});

test("a worklog.md the command did not write is never replaced, and the record is not touched", () => {
  // Given hand-written notes at the path the command renders to.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    writeFileSync(log.markdownPath, "# My notes\n- keep me\n");
    // When adding an item; then it is refused, the notes are intact, and no record was appended.
    expect(() => log.add("New request", "slack:D1/2.1", T0)).toThrow("was not written by dori worklog; move it aside");
    expect(readFileSync(log.markdownPath, "utf8")).toBe("# My notes\n- keep me\n");
    expect(existsSync(log.path)).toBe(false);
  } finally { state.done(); }
});

test("a hand-written worklog.md that appears between the ownership check and the rename is kept", () => {
  // Given a worklog.md we rendered, and someone who replaces it while our next publish is in flight.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    log.add("First", "slack:D1/2.2", T0);
    const files = () => readdirSync(state.dir).sort();
    const before = files();
    // When the publish runs; then it is skipped, the hand-written file is intact, and no temp file is left.
    expect(publishWorklog(log.markdownPath, `${WORKLOG_MARKER}\nnewer view\n`, () => writeFileSync(log.markdownPath, "# My notes\n"))).toBe(false);
    expect(readFileSync(log.markdownPath, "utf8")).toBe("# My notes\n");
    expect(files()).toEqual(before);
    // And with no one in the way, the same publish replaces our own file.
    writeFileSync(log.markdownPath, `${WORKLOG_MARKER}\nold view\n`);
    expect(publishWorklog(log.markdownPath, `${WORKLOG_MARKER}\nnewer view\n`)).toBe(true);
    expect(readFileSync(log.markdownPath, "utf8")).toBe(`${WORKLOG_MARKER}\nnewer view\n`);
  } finally { state.done(); }
});

test("concurrent CLI adds from separate processes lose no item, in the record or in worklog.md", async () => {
  // Given an empty state dir and 12 processes adding at once.
  const state = withState();
  try {
    const invoke = cliIn(state.dir);
    const count = 12;
    const results = await Promise.all(Array.from({ length: count }, (_, i) => invoke("worklog", "add", `request ${i}`, "--source", `slack:D1/9.${i}`)));
    // Then every process succeeded, every item is in the record once, and the last render holds all of them.
    expect(results.map((r) => [r.code, r.err])).toEqual(Array.from({ length: count }, () => [0, ""]));
    const ids = results.map((r) => (JSON.parse(r.out) as { id: string }).id);
    const log = new Worklog(state.dir);
    const read = log.read();
    expect(read.problems).toEqual([]);
    expect(read.items.map((item) => item.id).sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(count);
    const markdown = readFileSync(log.markdownPath, "utf8");
    for (const id of ids) expect(markdown).toContain(`### ${id} request `);
  } finally { state.done(); }
});

test("a render that raced another writer's append publishes again, so the last view holds every record", () => {
  // Given another writer that appends after our read and publishes its full view before our stale one lands.
  let record = "a\n";
  const published: string[] = [];
  // When we publish; then our stale view is followed by a full one, so the last view holds both records.
  const final = renderUntilStable(() => Buffer.from(record), (view) => {
    if (!published.length) {
      record += "b\n";
      published.push(record);
    }
    published.push(view);
  }, () => Buffer.byteLength(record));
  expect(published).toEqual(["a\nb\n", "a\n", "a\nb\n"]);
  expect(final).toBe("a\nb\n");
});

test("close refuses an item whose note or next reads as a promise still owed, names each such line, and closes only with --ack-promise", async () => {
  // Given an open item whose note holds the old lead's promise to another dori (worklog da078c1a), and one whose note promises nothing.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const owed = log.add("Wrist lane for gongdori", "discord:1/2", T0);
    log.note(owed.id, "told gongdori: the wrist lane opens after #56 merges", T0 + 1);
    log.note(owed.id, "#56 is in review", T0 + 2);
    const plain = log.add("Rename the bot", "discord:1/3", T0 + 3);
    log.note(plain.id, "owner picked the name dori-bot", T0 + 4);
    const invoke = cliIn(state.dir);
    // When closing the promised item without the flag; then it is refused with one warning line for the promise and stays open.
    const refused = await invoke("worklog", "close", owed.id, "--result", "done");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`WORKLOG_CLOSE_PROMISE ${owed.id} note 2026-11-04T00:00:00.001Z "told gongdori: the wrist lane opens after #56 merges"`);
    expect(refused.err).not.toContain("#56 is in review");
    expect(refused.err).toContain("--ack-promise");
    expect(log.open().map((item) => item.id)).toContain(owed.id);
    // When closing it with --ack-promise; then it closes.
    const acked = await invoke("worklog", "close", owed.id, "--result", "wrist lane opened", "--ack-promise");
    expect([acked.code, acked.err]).toEqual([0, ""]);
    // When closing the item whose note promises nothing; then it closes as before, without the flag.
    const quiet = await invoke("worklog", "close", plain.id, "--result", "renamed");
    expect([quiet.code, quiet.err]).toEqual([0, ""]);
    expect(log.open()).toEqual([]);
  } finally { state.done(); }
});

test("a promise in Korean, or in the Next line, also stops close", () => {
  // Given two open items: one with a Korean promise note, one whose Next line is the promise.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const ko = log.add("손목 레인", "discord:1/4", T0);
    log.note(ko.id, "공돌에게 #56 머지 뒤 손목 레인 연다고 약속함", T0 + 1);
    const next = log.add("Release notes", "discord:1/5", T0 + 2);
    log.next(next.id, "will post them to gongdori once CI is green", T0 + 3);
    // Then closing either throws with the line, and --ack-promise (ackPromise) closes both.
    expect(() => log.close(ko.id, "x", T0 + 4)).toThrow(`WORKLOG_CLOSE_PROMISE ${ko.id} note 2026-11-04T00:00:00.001Z "공돌에게 #56 머지 뒤 손목 레인 연다고 약속함"`);
    expect(() => log.close(next.id, "x", T0 + 4)).toThrow(`WORKLOG_CLOSE_PROMISE ${next.id} next "will post them to gongdori once CI is green"`);
    log.close(ko.id, "opened", T0 + 5, { ackPromise: true });
    log.close(next.id, "posted", T0 + 5, { ackPromise: true });
    expect(log.open()).toEqual([]);
  } finally { state.done(); }
});

test("a promise note another writer appends between close's check and its append still stops the close (review 1 of #483)", () => {
  // Given an item with no promise yet, and a lane that adds the promise right before this close appends.
  const state = withState();
  try {
    const item = new Worklog(state.dir).add("Wrist lane for gongdori", "discord:1/6", T0);
    const racing = new Worklog(state.dir, () => { new Worklog(state.dir).note(item.id, "told gongdori: opens after #56 merges", T0 + 1); });
    // When closing without --ack-promise; then it is refused with the racing note, and the item stays open.
    expect(() => racing.close(item.id, "done", T0 + 2)).toThrow(`WORKLOG_CLOSE_PROMISE ${item.id} note 2026-11-04T00:00:00.001Z "told gongdori: opens after #56 merges"`);
    expect(new Worklog(state.dir).open().map((open) => open.id)).toEqual([item.id]);
    expect(new Worklog(state.dir).read().warnings.join("\n")).toContain(`worklog item ${item.id} close without --ack-promise ignored`);
    // When closing it with ackPromise; then it closes.
    expect(new Worklog(state.dir).close(item.id, "opened", T0 + 3, { ackPromise: true }).closedAt).toBe(new Date(T0 + 3).toISOString());
  } finally { state.done(); }
});

test("a close written before --ack-promise existed (no ack field) stays closed, promise words or not", () => {
  // Given a record as earlier dori wrote it: an item with a promise note, closed by a record without ack.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const item = log.add("Wrist lane for gongdori", "discord:1/7", T0);
    log.note(item.id, "told gongdori: opens after #56 merges", T0 + 1);
    writeFileSync(log.path, `${readFileSync(log.path, "utf8")}${JSON.stringify({ op: "close", id: item.id, at: new Date(T0 + 2).toISOString(), result: "closed by the old lead" })}\n`);
    // Then it reads as closed, with no warning.
    expect(log.read()).toMatchObject({ items: [{ id: item.id, closedAt: new Date(T0 + 2).toISOString() }], problems: [], warnings: [] });
  } finally { state.done(); }
});
