// From upstream dori-superagent #191 test/send-cli-empty.test.ts (https://github.com/sisyphuslabs/dori-superagent/pull/191),
// fitted to the fork: a local fake Slack and Discord API counts every request (the fork has no record-fetch preload),
// and a bare --edit keeps the fork's own refusal (opt(): "--edit needs a value"). A valid --thread still posts once.
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { viaEnvFile, withState } from "./fakes.ts";

setDefaultTimeout(120_000); // nine CLI children (bun src/cli.ts), each a few seconds on a loaded host

test("send slack and send discord refuse an empty --thread or --edit before they post anything", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true, id: "901", ts: "1700000100.000100", channel: "C1", message: { text: "hello" } });
    },
  });
  const state = withState();
  try {
    const api = `http://127.0.0.1:${server.port}/api`;
    const send = (i: number, platform: string, flags: readonly string[]) =>
      run(viaEnvFile(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${join(state.dir, String(i))}`, `DORI_ENV_FILE=${join(state.dir, `${i}.env`)}`,
        "DORI_SLACK_TOKEN=xoxb-fake", `DORI_SLACK_API=${api}`, "DORI_DISCORD_TOKEN=fake", `DORI_DISCORD_API=${api}`,
        "bun", join(import.meta.dir, "../src/cli.ts"), "send", platform, "--to", "C1", "--text", "hello", "--no-typing", ...flags].filter((a) => platform === "discord" || a !== "--no-typing")));
    const cases = ["slack", "discord"].flatMap((platform) => [["--thread", ""], ["--thread", " "], ["--edit", ""], ["--edit"]].map((flags) => ({ platform, flags })));
    const refused = [];
    for (const [i, c] of cases.entries()) {
      const r = await send(i, c.platform, c.flags);
      refused.push({ ...c, code: r.code, err: r.err.trim().split("\n").at(-1) });
    }
    expect({ refused, seen }).toEqual({
      refused: cases.map((c) => ({ ...c, code: 1, err: c.flags.length === 1 ? "--edit needs a value" : `${c.flags[0]} is empty: leave it out to post a new message` })),
      seen: [],
    });
    const threaded = await send(cases.length, "discord", ["--thread", "1566844859174756462"]);
    expect({ code: threaded.code, seen }).toEqual({ code: 0, seen: ["POST /api/channels/1566844859174756462/messages"] });
  } finally {
    state.done();
    await server.stop(true);
  }
});
