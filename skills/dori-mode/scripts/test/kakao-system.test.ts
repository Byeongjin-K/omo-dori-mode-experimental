import { expect, test } from "bun:test";
import { join } from "node:path";

const dir = join(import.meta.dir, "../../setups/discord-aoe/kakao-system");

test("kakao-system wrappers: allowlist, tar-only uploads, client tar", async () => {
  const p = Bun.spawn(["python3", "-I", "test_kakao_system.py"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
}, 60000);

test("kakao-system install.sh parses as bash", async () => {
  const p = Bun.spawn(["bash", "-n", join(dir, "install.sh")], { stderr: "pipe" });
  expect(await p.exited).toBe(0);
});
