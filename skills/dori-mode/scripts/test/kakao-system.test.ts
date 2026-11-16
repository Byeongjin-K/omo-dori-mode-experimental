import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(import.meta.dir, "../../setups/discord-aoe/kakao-system");

test("kakao-system wrappers: allowlist, tar-only uploads, client tar", async () => {
  const p = Bun.spawn(["python3", "-I", "-B", "test_kakao_system.py"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
}, 60000);

test("kakao-system install.sh parses as bash", async () => {
  const p = Bun.spawn(["bash", "-n", join(dir, "install.sh")], { stderr: "pipe" });
  expect(await p.exited).toBe(0);
});

// install.sh login names the account file in a login env file (DORI_ENV_FILE), because kakao-login.ts drops inherited
// DORI_KAKAO_* before reading its env file (review 5 of #485): the env-file form reaches the CLI, the inherited one does not.
test("kakao-system login: the account file reaches kakao-login only through the env file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kakao-system-login-"));
  try {
    const cli = join(tmp, "agent-messenger");
    writeFileSync(cli, `#!/bin/sh\necho "$*" > "${tmp}/calls.log"\n`);
    chmodSync(cli, 0o755);
    writeFileSync(join(tmp, "account"), "KAKAO_EMAIL=010-1234-5678\nKAKAO_PASSWORD=box\n");
    const base = `DORI_KAKAO_STATE_DIR=${tmp}\nDORI_KAKAO_CLI=${cli}\n`;
    const run = async (envFile: string, extra: Record<string, string>) => {
      writeFileSync(join(tmp, "login.env"), envFile);
      const p = Bun.spawn(["bun", join(dir, "..", "kakao-login.ts"), "--phone", "82"], { cwd: tmp, stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "", HOME: tmp, TMPDIR: tmp, DORI_CONFIG: join(tmp, "none.json"), DORI_ENV_FILE: join(tmp, "login.env"), ...extra } });
      return [await p.exited, (await new Response(p.stdout).text()).trim(), (await new Response(p.stderr).text()).trim()];
    };
    expect(await run(base, { DORI_KAKAO_ACCOUNT_FILE: join(tmp, "account") })).toEqual([2, "", "KAKAO_LOGIN_FAIL DORI_KAKAO_ACCOUNT_FILE is not set"]);
    expect(await run(`${base}DORI_KAKAO_ACCOUNT_FILE=${join(tmp, "account")}\n`, {})).toEqual([0, "KAKAO_LOGIN_EXIT 0", ""]);
    expect(readFileSync(join(tmp, "calls.log"), "utf8")).toMatch(/^kakaotalk auth login --email \+82 1012345678 --password-file /);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60000);
