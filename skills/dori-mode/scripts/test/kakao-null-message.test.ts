import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleKakaoProofRequest, kakaoOptions, kakaoTick, loadKakaoState } from "../../setups/discord-aoe/kakao-watch.ts";
import type { Runner } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A photo or feed post comes from agent-messenger with message null; it must not stop the watch or be taken in twice.
test("a message without text is taken in once, moves the cursor past it and never becomes an owner proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kakao-null-"));
  dirs.push(dir);
  const o = kakaoOptions({ DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_INBOX: join(dir, "inbox.jsonl"), DORI_KAKAO_SELF_ID: "9",
    DORI_KAKAO_OWNER_ID: "1", DORI_KAKAO_MENTION: "dori", AGENT_MESSENGER_CONFIG_DIR: join(dir, "am") });
  writeFileSync(o.rooms, JSON.stringify({ R: { id: "100" } }));
  writeFileSync(o.cursors, JSON.stringify({ "100": "5" }));
  writeFileSync(o.marked, JSON.stringify({ "100": "5" }));
  const sent_at = Math.floor(Date.now() / 1000);
  const list = [
    { log_id: "6", author_id: 1, author_name: "u1", message: null, sent_at },
    { log_id: "7", author_id: 1, author_name: "u1", message: "dori after the photo", sent_at },
  ];
  const runner: Runner = async (argv) => {
    if (argv[4] === "--mark-read") return { code: 0, out: JSON.stringify({ status: 0, watermark: argv[6] ?? "0" }), err: "" };
    if (argv[4] === "chat") return { code: 0, out: "[]", err: "" };
    if (argv[5] === "list") return { code: 0, out: JSON.stringify(list), err: "" };
    return { code: 0, out: '{"success":true}', err: "" };
  };
  const state = loadKakaoState(o);
  const lines: string[] = [];
  for (const t of [sent_at * 1000, sent_at * 1000 + 1_000]) await kakaoTick(o, state, runner, () => t, (l) => lines.push(l));

  const rows = existsSync(o.inbox) ? readFileSync(o.inbox, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  expect(rows.map((r) => [r.id, r.content, r.mentions_self])).toEqual([["6", "", false], ["7", "dori after the photo", true]]);
  expect(JSON.parse(readFileSync(o.cursors, "utf8"))).toEqual({ "100": "7" });
  expect(lines.filter((l) => l.startsWith("KAKAO_MSG"))).toEqual(["KAKAO_MSG R 6 u1: [no text]", "KAKAO_MSG R 7 u1: dori after the photo"]);
  expect(lines.filter((l) => l.startsWith("KAKAO_WATCH_FAIL"))).toEqual([]);
  expect(handleKakaoProofRequest(JSON.stringify({ chat: "100", log: "6", text: "anything" }), state.proofRecords)).toEqual({ found: false });
  expect(handleKakaoProofRequest(JSON.stringify({ chat: "100", log: "7", text: "dori after the photo" }), state.proofRecords))
    .toMatchObject({ found: true, author_kind: "owner", quoted: true });
});
