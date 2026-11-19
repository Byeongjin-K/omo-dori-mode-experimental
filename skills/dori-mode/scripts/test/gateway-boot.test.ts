// Ported from upstream dori-superagent #255 (https://github.com/sisyphuslabs/dori-superagent/pull/255); fitted to the fork's boot fixtures (bootDeps).
import { afterEach, beforeEach, expect, test } from "bun:test";

import { bootCheck } from "../src/boot.ts";
import { gatewayCheck } from "../src/boot-gateway.ts";
import { bootDeps } from "./boot-fixtures.ts";
import { newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const SOCK = "/run/dori-gateway/dori.sock";
const boot = (ping: () => Promise<number | undefined>, socketExists: boolean) => {
  const pinged: string[] = [];
  const result = bootCheck({
    ...bootDeps(newWorld(), state.dir),
    gateway: gatewayCheck(
      {
        ping: () => {
          pinged.push(SOCK);
          return ping();
        },
      },
      SOCK,
      () => socketExists,
    ),
  });
  return { result, pinged };
};

test("with no socket file the gateway surface is skipped and boot still checks clean", async () => {
  // Given no gateway socket on this machine; when boot runs.
  const { result, pinged } = boot(async () => 1, false);
  const r = await result;
  // Then the surface is skipped without a connection attempt, as a messenger with no token is.
  expect(pinged).toEqual([]);
  expect(r.lines).toContain("GATEWAY skipped (no gateway socket)");
  expect(r.exitCode).toBe(0);
});

test("a socket that answers is reachable and boot names the surface's rule ids", async () => {
  const r = await boot(async () => 1, true).result;
  expect(r.lines).toContain("GATEWAY reachable contract=1");
  expect(r.lines.find((l) => l.startsWith("GATEWAY rules "))?.split(" ")).toContain("ask.money-leaves");
  expect(r.exitCode).toBe(0);
});

test("a socket file with no gateway behind it is a failed check that shows no error text", async () => {
  const r = await boot(async () => {
    throw new Error("connect ECONNREFUSED /secret/path");
  }, true).result;
  expect(r.lines).toContain("GATEWAY unavailable");
  expect(r.lines.join("\n")).not.toContain("/secret/path");
  expect(r.exitCode).toBe(1);
});
