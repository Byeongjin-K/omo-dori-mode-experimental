import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kakaoOptions, kakaoTick, loadKakaoState, refreshLogin, type KakaoOptions } from "../../setups/discord-aoe/kakao-watch.ts";
import type { Ran, Runner } from "../src/run.ts";

// 2026-11-17 07:49Z: every call of the dori-kakao watcher answered this for 2 min 20 s (138 KAKAO_POLL_FAIL lines) until
// the owner stopped the unit as root; the login came back at 08:25Z through the stored refresh token.
const EXPIRED: Ran = { code: 1, out: "", err: "Error: KakaoTalk LOGINLIST invalid access token (status -950)" };
const OK: Ran = { code: 0, out: "[]", err: "" };
const NET: Ran = { code: 1, out: "", err: "Error: connect ETIMEDOUT 211.183.212.1:443" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "kakao-auth-"));
  dirs.push(dir);
  const o = kakaoOptions({ DORI_KAKAO_STATE_DIR: dir, DORI_KAKAO_INBOX: join(dir, "inbox.jsonl"), DORI_KAKAO_SELF_ID: "9", DORI_KAKAO_POLL_MS: "1000", DORI_KAKAO_SWEEP_MS: "60000", AGENT_MESSENGER_CONFIG_DIR: join(dir, "am"), ...env });
  writeFileSync(o.rooms, JSON.stringify({ A: { id: "100" }, B: { id: "200" }, C: { id: "300" }, D: { id: "400" } }));
  writeFileSync(o.cursors, JSON.stringify({ "100": "5", "200": "5", "300": "5", "400": "5" }));
  writeFileSync(o.marked, JSON.stringify({ "100": "5", "200": "5", "300": "5", "400": "5" }));
  mkdirSync(o.syncDir, { recursive: true });
  writeFileSync(join(o.syncDir, "kakaotalk-credentials.json"), '{"accounts":{}}');
  return o;
};

// A fake agent-messenger behind flock: chat list and message list take the next reply of `replies` (the last one
// repeats); --refresh answers `refresh` and then every call answers `after` when it is set.
const fake = (replies: Ran[], refresh: { ok: boolean; why?: string }, after?: Ran) => {
  const calls: string[] = [];
  let refreshed = false;
  const runner: Runner = async (argv) => {
    if (argv[4] === "--refresh") {
      calls.push("refresh");
      refreshed = true;
      return { code: 0, out: JSON.stringify(refresh), err: "" };
    }
    calls.push(argv[4] === "chat" ? "chat list" : `list ${argv[6]}`);
    if (refreshed && after) return after;
    return replies.length > 1 ? (replies.shift() as Ran) : (replies[0] as Ran);
  };
  return { calls, runner };
};
const ticker = (o: KakaoOptions, runner: Runner) => {
  const lines: string[] = [];
  const state = loadKakaoState(o);
  return { state, lines, at: (ms: number) => kakaoTick(o, state, runner, () => ms, (l) => lines.push(l)) };
};
const inbox = (o: KakaoOptions) => (existsSync(o.inbox) ? readFileSync(o.inbox, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const kinds = (lines: string[]) => lines.map((l) => l.split(" ")[0]);

test("three -950 replies in a row try one refresh; when it fails one KAKAO_AUTH_EXPIRED line and one inbox alert, then no Kakao call at all", async () => {
  const o = setup();
  const k = fake([EXPIRED], { ok: false, why: "refresh_rejected server=-950 http=401" });
  const w = ticker(o, k.runner);
  await w.at(0);
  await w.at(10_000);
  await w.at(400_000);
  expect(k.calls).toEqual(["chat list", "list 100", "list 200", "refresh"]);
  expect(kinds(w.lines)).toEqual(["KAKAO_DISCOVER_FAIL", "KAKAO_POLL_FAIL", "KAKAO_POLL_FAIL", "KAKAO_AUTH_EXPIRED"]);
  expect(w.lines[3]).toBe("KAKAO_AUTH_EXPIRED after 3 invalid access token replies in a row, refresh failed (refresh_rejected server=-950 http=401): polling stopped until the login file changes");
  expect(inbox(o).map((r) => [r.kind, r.content.startsWith("KAKAO_AUTH_EXPIRED")])).toEqual([["kakao-auth-expired", true]]);
});

test("a refresh that works keeps polling in the same tick; a refreshed login that still gets -950 is not refreshed again", async () => {
  const o = setup();
  const good = fake([EXPIRED], { ok: true }, OK);
  const w = ticker(o, good.runner);
  await w.at(0);
  expect(good.calls).toEqual(["chat list", "list 100", "list 200", "refresh", "list 300", "list 400"]);
  expect(kinds(w.lines)).toEqual(["KAKAO_DISCOVER_FAIL", "KAKAO_POLL_FAIL", "KAKAO_POLL_FAIL", "KAKAO_AUTH_REFRESHED"]);
  expect(inbox(o)).toEqual([]);

  const o2 = setup();
  const bad = fake([EXPIRED], { ok: true });
  const w2 = ticker(o2, bad.runner);
  await w2.at(0);
  await w2.at(10_000);
  expect(bad.calls).toEqual(["chat list", "list 100", "list 200", "refresh", "list 300", "list 400", "list 100"]);
  expect(kinds(w2.lines).slice(3)).toEqual(["KAKAO_AUTH_REFRESHED", "KAKAO_POLL_FAIL", "KAKAO_POLL_FAIL", "KAKAO_POLL_FAIL", "KAKAO_AUTH_EXPIRED"]);
  expect(w2.lines.at(-1)).toContain("refresh failed (the refreshed login got -950 again)");
  expect(inbox(o2).length).toBe(1);
});

test("other failures go on as before: a network error is never counted and a success between -950 replies starts the count over", async () => {
  const o = setup();
  const k = fake([NET, EXPIRED, EXPIRED, OK, EXPIRED, NET, EXPIRED, OK], { ok: false });
  const w = ticker(o, k.runner);
  await w.at(0);
  await w.at(30_000);
  expect(k.calls).toEqual(["chat list", "list 100", "list 200", "list 300", "list 400", "chat list", "list 100", "list 200", "list 300", "list 400"]);
  expect(kinds(w.lines)).toEqual(["KAKAO_DISCOVER_FAIL", "KAKAO_POLL_FAIL", "KAKAO_POLL_FAIL", "KAKAO_POLL_FAIL", "KAKAO_DISCOVER_FAIL", "KAKAO_POLL_FAIL"]);
  expect(inbox(o)).toEqual([]);
});

test("DORI_KAKAO_AUTH_FAILS sets how many -950 replies in a row come before the refresh", async () => {
  const o = setup({ DORI_KAKAO_AUTH_FAILS: "1" });
  const k = fake([EXPIRED], { ok: false, why: "no_refresh_token" });
  const w = ticker(o, k.runner);
  await w.at(0);
  expect(k.calls).toEqual(["chat list", "refresh"]);
  expect(setup().authFails).toBe(3);
  expect(() => setup({ DORI_KAKAO_AUTH_FAILS: "0" })).toThrow();
});

test("a restart with the same expired login stays idle with one KAKAO_AUTH_WAIT line and no alert; a new login file resumes polling once", async () => {
  const o = setup();
  const k = fake([EXPIRED], { ok: false, why: "refresh_rejected" });
  await ticker(o, k.runner).at(0);
  const again = fake([OK], { ok: false });
  const w = ticker(o, again.runner);
  await w.at(0);
  await w.at(10_000);
  expect([again.calls, w.lines.map((l) => l.split(" ")[0]), inbox(o).length]).toEqual([[], ["KAKAO_AUTH_WAIT"], 1]);
  const cred = join(o.syncDir, "kakaotalk-credentials.json");
  writeFileSync(cred, '{"accounts":{"a":{}}}');
  utimesSync(cred, new Date(), new Date(Date.now() + 5000));
  await w.at(20_000);
  await w.at(30_000);
  expect([kinds(w.lines), again.calls.filter((c) => c === "list 100").length, existsSync(o.expired)]).toEqual([["KAKAO_AUTH_WAIT", "KAKAO_AUTH_RESUMED"], 2, false]);
});

// The watcher's --refresh is the refresh the 2026-11-17 relogin used (kakao-relogin.ts refresh): the stored account's
// tokens through agent-messenger's refreshKakaoOAuthToken, saved back as the current account. It prints no token.
const sdk = (account: Record<string, unknown> | null, renew: () => Promise<{ accessToken: string; refreshToken: string }>) => {
  const store = { account, current: null as unknown, pendingCleared: false, refreshCalls: 0 };
  class CredentialManager {
    getAccount = async () => store.account;
    setAccount = async (a: Record<string, unknown>) => {
      store.account = a;
    };
    setCurrentAccount = async (id: unknown) => {
      store.current = id;
    };
    clearPendingLogin = async () => {
      store.pendingCleared = true;
    };
  }
  const refreshKakaoOAuthToken = () => {
    store.refreshCalls += 1;
    return renew();
  };
  return { store, mod: { CredentialManager, refreshKakaoOAuthToken } };
};
const account = { account_id: "a1", oauth_token: "old-access-secret", refresh_token: "old-refresh-secret", device_uuid: "dev1", user_id: 9 };

test("--refresh saves the renewed tokens as the current account; a refused or impossible refresh says why without any token", async () => {
  const ok = sdk({ ...account }, async () => ({ accessToken: "new-access-secret", refreshToken: "new-refresh-secret" }));
  expect(await refreshLogin(ok.mod)).toEqual({ ok: true });
  expect([ok.store.account?.["oauth_token"], ok.store.account?.["refresh_token"], ok.store.account?.["device_uuid"], ok.store.current, ok.store.pendingCleared]).toEqual(["new-access-secret", "new-refresh-secret", "dev1", "a1", true]);

  const refused = sdk({ ...account }, async () => {
    throw Object.assign(new Error("KakaoTalk OAuth token refresh failed (refresh_rejected)"), { code: "refresh_rejected", serverStatus: -950, httpStatus: 401 });
  });
  const back = await refreshLogin(refused.mod);
  expect([back, refused.store.account?.["oauth_token"]]).toEqual([{ ok: false, why: "refresh_rejected server=-950 http=401" }, "old-access-secret"]);
  expect(JSON.stringify(back)).not.toContain("secret");

  const none = sdk({ ...account, refresh_token: "" }, async () => ({ accessToken: "x", refreshToken: "y" }));
  expect([await refreshLogin(none.mod), none.store.refreshCalls]).toEqual([{ ok: false, why: "no_refresh_token" }, 0]);
});
