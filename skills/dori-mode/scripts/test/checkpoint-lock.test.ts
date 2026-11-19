import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

// review 4 of #509: takeLock held the flock before it wrote its owner record, and a write that failed there (ENOSPC on a full
// disk, the moment dori guard's disk alert has to go out) left the descriptor open: every later take in that process was
// refused as locked until it restarted. A child with no room to write (ulimit -f 0, SIGXFSZ ignored: EFBIG, the same failed
// write after the flock) takes the lock twice.
test("a lock whose owner record cannot be written is let go, so the next take is not refused as locked", async () => {
  const lock = join(state.dir, "guard.json.lock");
  const probe = join(state.dir, "probe.ts");
  await Bun.write(probe, `import { CheckpointError, takeLock } from ${JSON.stringify(join(import.meta.dir, "../src/checkpoint-lock.ts"))};
for (const n of [1, 2]) {
  try {
    takeLock(${JSON.stringify(lock)}, Date.now(), "guard pass", "state");
    console.log(n, "taken");
  } catch (e) {
    console.log(n, e instanceof CheckpointError ? "locked" : (e as NodeJS.ErrnoException).code);
  }
}`);
  const p = Bun.spawn(["bash", "-c", 'trap "" XFSZ; ulimit -f 0; exec "$0" "$1"', process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
  const [out] = [await new Response(p.stdout).text(), await p.exited];
  expect(out.trim().split("\n")).toEqual(["1 EFBIG", "2 EFBIG"]);
});
