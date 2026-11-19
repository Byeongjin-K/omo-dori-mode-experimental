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

// review 9 of #509: one recipient's inbox lock held by a stuck writer stopped the whole relay. The relay waits for it a
// short while (DORI_FILE_RELAY_INBOX_WAIT), then leaves that file in the outbox with one RELAY_INBOX_BUSY line and goes on;
// the next cycle wakes the recipient with the copy already made, so no row is lost and no file goes twice.
test("a recipient whose inbox lock is held waits in the outbox while the others are delivered and woken, then is woken once", async () => {
  put(home("mo", "outbox", "to-yoodori", "a.txt"), "for yo");
  put(home("mo", "outbox", "to-zzangdori", "b.txt"), "for za");
  const lock = home("yo", ".yo", "inbox.jsonl.lock");
  const release = takeLock(lock, Date.now(), "inbox append", lock);
  const p = Bun.spawn(["/usr/bin/python3", "-I", SCRIPT, "--serve", "--cycles", "3"], { env: env({ DORI_FILE_RELAY_INBOX_WAIT: "3" }), stdout: "pipe", stderr: "pipe" });
  const err = p.stderr.getReader();
  const dec = new TextDecoder();
  let said = "";
  while (!said.includes("RELAY_INBOX_BUSY")) {
    const { done, value } = await err.read();
    if (done) break;
    said += dec.decode(value, { stream: true });
  }
  // Then: yo's file is still in mo's outbox and yo has no row, while za has its file and its row
  expect(said).toContain("RELAY_INBOX_BUSY yoodori");
  expect([existsSync(home("mo", "outbox", "to-yoodori", "a.txt")), inbox("yo")]).toEqual([true, []]);
  release();
  expect(await p.exited).toBe(0);
  let rest = "";
  for (;;) {
    const { done, value } = await err.read();
    if (done) break;
    rest += dec.decode(value, { stream: true });
  }
  expect((said + rest).split("\n").filter((l) => l.startsWith("RELAY_INBOX_BUSY"))).toHaveLength(1);
  expect(inbox("za").map((r) => r.path)).toEqual(["from-moodori/b.txt"]);
  expect(inbox("yo").map((r) => [r.path, r.replaced])).toEqual([["from-moodori/a.txt", false]]);
  expect(readFileSync(home("yo", "inbox", "from-moodori", "a.txt"), "utf8")).toBe("for yo");
  expect(existsSync(home("mo", "outbox", "sent", kst(), "to-yoodori", "a.txt"))).toBe(true);
});
