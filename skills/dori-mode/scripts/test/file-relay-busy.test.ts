import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { takeLock } from "../src/checkpoint-lock.ts";

setDefaultTimeout(30_000); // load-proof: the relay runs in python3 for three cycles and walks /proc each scan, as in file-relay.test.ts

const SCRIPT = join(import.meta.dir, "../../setups/discord-aoe/dori-file-relay");
let root = "";
let homes = "";

// Three fake Dori accounts as folders; helpers run as the test user without sudo (DORI_FILE_RELAY_TEST_HOMES).
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dori-file-relay-busy-"));
  homes = join(root, "homes");
  for (const a of ["za", "yo", "mo"]) mkdirSync(join(homes, a, `.${a}`), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "tmp"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (extra: Record<string, string>) => ({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  TMPDIR: join(root, "tmp"),
  DORI_FILE_RELAY_TEST_HOMES: homes,
  DORI_FILE_RELAY_STATE: join(root, "state"),
  DORI_FILE_RELAY_DORIS: "zzangdori=za:~/.za/inbox.jsonl yoodori=yo:~/.yo/inbox.jsonl moodori=mo:~/.mo/inbox.jsonl",
  DORI_FILE_RELAY_SETTLE_SEC: "0",
  DORI_FILE_RELAY_INTERVAL: "0",
  ...extra,
});
const home = (a: string, ...p: string[]) => join(homes, a, ...p);
const put = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
};
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const inbox = (a: string): { readonly path: string; readonly replaced: boolean }[] => {
  const p = home(a, `.${a}`, "inbox.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const run = async (cycles: number, extra: Record<string, string> = {}) => {
  const p = Bun.spawn(["/usr/bin/python3", "-I", SCRIPT, "--serve", "--cycles", String(cycles)], { env: env(extra), stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { err, code };
};
// a reader's text up to mark, or to its end with mark ""
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

// review 9 of #509: one recipient's inbox lock held by a stuck writer stopped the whole relay. The relay waits for it a
// short while (DORI_FILE_RELAY_INBOX_WAIT), then leaves that file in the outbox with one RELAY_INBOX_BUSY line and goes on;
// the next cycle wakes the recipient with the copy already made, so no row is lost and no file goes twice. The held
// recipient's file comes from mo, whose outbox is scanned last, so the other delivery (from za) is done while it is held.
test("a recipient whose inbox lock is held waits in the outbox while the others are delivered and woken, then is woken once", async () => {
  put(home("mo", "outbox", "to-yoodori", "a.txt"), "for yo");
  put(home("za", "outbox", "to-moodori", "b.txt"), "for mo");
  const lock = home("yo", ".yo", "inbox.jsonl.lock");
  const release = takeLock(lock, Date.now(), "inbox append", lock);
  const p = Bun.spawn(["/usr/bin/python3", "-I", SCRIPT, "--serve", "--cycles", "3"], { env: env({ DORI_FILE_RELAY_INBOX_WAIT: "3" }), stdout: "pipe", stderr: "pipe" });
  const err = p.stderr.getReader();
  const said = await until(err, "RELAY_INBOX_BUSY");
  // Then, with yo's lock still held: mo has its file and its row; yo's file is still in mo's outbox and yo has no row
  expect(said).toContain("RELAY_INBOX_BUSY yoodori");
  expect(inbox("mo").map((r) => r.path)).toEqual(["from-zzangdori/b.txt"]);
  expect(readFileSync(home("mo", "inbox", "from-zzangdori", "b.txt"), "utf8")).toBe("for mo");
  expect([existsSync(home("mo", "outbox", "to-yoodori", "a.txt")), inbox("yo")]).toEqual([true, []]);
  release();
  expect(await p.exited).toBe(0);
  expect((said + (await until(err, ""))).split("\n").filter((l) => l.startsWith("RELAY_INBOX_BUSY"))).toHaveLength(1);
  expect(inbox("yo").map((r) => [r.path, r.replaced])).toEqual([["from-moodori/a.txt", false]]);
  expect(readFileSync(home("yo", "inbox", "from-moodori", "a.txt"), "utf8")).toBe("for yo");
  expect(existsSync(home("mo", "outbox", "sent", kst(), "to-yoodori", "a.txt"))).toBe(true);
});

// review 10 of #509: a wait the helper's 120 s kill cut short moved the file to sent without its row; the wait is 1 to 60 s
test("the relay refuses to start with an inbox wait outside 1 to 60 seconds, saying why", async () => {
  for (const wait of ["61", "0", "x"]) {
    const r = await run(1, { DORI_FILE_RELAY_INBOX_WAIT: wait });
    expect([r.code, r.err]).toEqual([2, `dori-file-relay --serve: DORI_FILE_RELAY_INBOX_WAIT must be whole seconds from 1 to 60 (the inbox helper is stopped at 120 s), not ${wait}\n`]);
  }
});

// review 10 of #509: any failed inbox call (an error, a stopped helper) keeps the file in the outbox for a later cycle
test("a receiver whose inbox cannot be written keeps the file in the outbox, and a later run wakes it once", async () => {
  put(home("mo", "outbox", "to-yoodori", "a.txt"), "for yo");
  mkdirSync(home("yo", ".yo", "inbox.jsonl")); // a folder where the inbox file belongs: the helper's write fails
  const first = await run(2);
  expect(first.code).toBe(0);
  expect(first.err).toContain("RELAY_INBOX_FAILED yoodori");
  expect([existsSync(home("mo", "outbox", "to-yoodori", "a.txt")), existsSync(home("mo", "outbox", "sent"))]).toEqual([true, false]);
  rmSync(home("yo", ".yo", "inbox.jsonl"), { recursive: true });
  expect((await run(2)).code).toBe(0);
  expect(inbox("yo").map((r) => r.path)).toEqual(["from-moodori/a.txt"]);
  expect(existsSync(home("mo", "outbox", "sent", kst(), "to-yoodori", "a.txt"))).toBe(true);
});
