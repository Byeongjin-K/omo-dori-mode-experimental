import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginArgv, phoneLogin, readAccount } from "../../setups/discord-aoe/kakao-login.ts";
import { viaEnvFile } from "./fakes.ts";

const SETUP = join(import.meta.dir, "..", "..", "setups", "discord-aoe");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "kakao-cli-")); dirs.push(dir); return dir; };

const fakeCli = (dir: string) => {
  const cli = join(dir, "agent-messenger");
  writeFileSync(
    cli,
    `#!/bin/sh
echo "$*" >> "${dir}/calls.log"
case "$2 $3" in
  "chat list") echo "[]" ;;
  "message list") echo '[{"log_id":"5","author_id":2,"message":"old","sent_at":0},{"log_id":"6","author_id":2,"message":"new","sent_at":0}]' ;;
  "auth login") cat "$7" > "${dir}/seen-password"; exit 3 ;;
  *) echo '{"success":true}' ;;
esac
`,
  );
  chmodSync(cli, 0o755);
  // The SDK beside the CLI script, as in the agent-messenger package: the one-session mark logs its packets.
  const sdk = join(realpathSync(dir), "platforms", "kakaotalk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, "index.js"),
    `import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, line + "\\n");
export const Long = { fromString: (s) => s };
let mark = "4";
const session = {
  syncMessages: async (c, n, cur, max) => (log("sdk SYNCMSG " + c + " " + cur + " " + max), { statusCode: 0, body: {} }),
  markRead: async (c, w) => (log("sdk NOTIREAD " + c + " " + w), (mark = w), { statusCode: 0, body: { status: 0 } }),
  getChatInfo: async (c) => (log("sdk CHATONROOM " + c), { statusCode: 0, body: { a: [9], w: [mark] } }),
};
export class KakaoTalkClient {
  async login() { log("sdk login"); }
  async executeWithReconnect(op) { return op({ session }); }
  close() { log("sdk close"); }
}
`,
  );
  return cli;
};
const runScript = async (script: string, args: string[], env: Record<string, string>, cwd: string) => {
  const p = Bun.spawn(["bun", join(SETUP, script), ...args], { cwd, env: viaEnvFile({ PATH: process.env["PATH"] ?? "", HOME: cwd, DORI_ENV_FILE: join(cwd, "none.env"), ...env }), stdout: "pipe", stderr: "pipe" });
  return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => ({ out, err, code }));
};

test("the script stays off without a Kakao id and runs one tick through flock with --once", async () => {
  const dir = scratch();
  const off = await runScript("kakao-watch.ts", [], {}, dir);
  expect([off.code, off.out.trim()]).toEqual([0, "KAKAO_WATCH_OFF DORI_KAKAO_SELF_ID is not set"]);
  writeFileSync(join(dir, "kakao-rooms.json"), JSON.stringify({ R: { id: "100" } }));
  writeFileSync(join(dir, "kakao-cursors.json"), JSON.stringify({ "100": "5" }));
  const env = { DORI_KAKAO_SELF_ID: "9", DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_INBOX: join(dir, "inbox.jsonl"), DORI_KAKAO_CLI: fakeCli(dir) };
  const once = await runScript("kakao-watch.ts", ["--once"], env, dir);
  expect([once.code, once.out.trim().split("\n").map((l) => l.replace(/^\S+Z /, ""))]).toEqual([0, ["KAKAO_MSG R 6 2: new", "KAKAO_MARKREAD_OK R 6 server 6", "KAKAO_WATCH_ONCE"]]);
  expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual([
    "kakaotalk chat list --all",
    "kakaotalk message list 100 -n 15",
    "sdk login",
    "sdk CHATONROOM 100",
    "sdk close",
    "sdk login",
    "sdk SYNCMSG 100 4 6",
    "sdk NOTIREAD 100 6",
    "sdk close",
    "sdk login",
    "sdk CHATONROOM 100",
    "sdk close",
  ]);
  expect(existsSync(join(dir, "kakao.lock"))).toBe(true);
});

test("login reads the account file, formats a phone login, and hands the password over only in a file it removes", async () => {
  expect(readAccount("# KAKAO_PASSWORD=old\nKAKAO_EMAIL=010-1234-5678\nKAKAO_PASSWORD='p w'\n")).toEqual({ login: "010-1234-5678", password: "p w" });
  expect(phoneLogin("010-1234-5678", "82")).toBe("+82 1012345678");
  expect(loginArgv("/l", "am", "a@b", "/p", "tablet")).toEqual(["flock", "/l", "am", "kakaotalk", "auth", "login", "--email", "a@b", "--password-file", "/p", "--device-type", "tablet", "--pretty"]);
  const dir = scratch();
  writeFileSync(join(dir, "kakao.env"), "KAKAO_EMAIL=010-1234-5678\nKAKAO_PASSWORD=secret\n");
  const r = await runScript("kakao-login.ts", ["--phone", "82"], { DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_ACCOUNT_FILE: join(dir, "kakao.env"), DORI_KAKAO_CLI: fakeCli(dir), TMPDIR: dir }, dir);
  expect([r.code, r.out.trim(), readFileSync(join(dir, "seen-password"), "utf8")]).toEqual([3, "KAKAO_LOGIN_EXIT 3", "secret"]);
  expect(readFileSync(join(dir, "calls.log"), "utf8").trim()).toMatch(/^kakaotalk auth login --email \+82 1012345678 --password-file \S+\/password --device-type tablet --pretty$/);
  expect(readFileSync(join(dir, "calls.log"), "utf8")).not.toContain("secret");
  expect([...new Bun.Glob("kakao-login-*").scanSync({ cwd: dir, onlyFiles: false })]).toEqual([]);
});
