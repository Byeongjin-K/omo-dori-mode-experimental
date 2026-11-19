// Review 3 of #511 (fork repeat check on upstream #255's gateway sends): one new message at a time per conversation, so a
// slow send is never taken over by a second one and the recorded last post is the one the gateway stored last.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { gatewayOnce } from "../src/cli-gateway.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const PLACE = "gateway:/run/dori-gateway/dori.sock";
// a send the test finishes by hand, and the moment it began
const held = () => {
  let release = () => {};
  let began = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (began = resolve));
  return { done, release, started, began };
};

test("a second identical send while the first is still retrying past the 60 s claim is a repeat, not a second post", async () => {
  // Given a first post whose gateway send is still running (retries can take 65 s) and a second identical one 61 s later.
  const t0 = 1_795_090_000_000;
  const sent: string[] = [];
  const first = held();
  const a = gatewayOnce(state.dir, PLACE, ["post", "hello"], async () => {
    sent.push("a");
    first.began();
    await first.done;
    return { id: "op-a" };
  }, { now: () => t0 });
  const b = gatewayOnce(state.dir, PLACE, ["post", "hello"], async () => {
    sent.push("b");
    return { id: "op-b" };
  }, { now: () => t0 + 61_000 });
  // When the first send finishes.
  await first.started;
  first.release();
  const [ra, rb] = await Promise.all([a, b]);
  // Then only the first went to the gateway and the second names it.
  expect(sent).toEqual(["a"]);
  expect(ra).toMatchObject({ id: "op-a", duplicate: false });
  expect(rb).toMatchObject({ id: "op-a", duplicate: true });
});

test("the recorded last post is the one sent last, also when the earlier send's answer comes in later", async () => {
  // Given A started first and B second, where B's answer would come back before A's, on one clock that moves on every
  // read, so a post is recorded at the time its answer came in.
  const t0 = 1_795_090_000_000;
  let reads = 0;
  const clock = () => t0 + reads++;
  const order: string[] = [];
  const slowA = held();
  const a = gatewayOnce(state.dir, PLACE, ["post", "A"], async () => {
    order.push("A sent");
    slowA.began();
    await slowA.done;
    return { id: "op-a" };
  }, { now: clock });
  const b = gatewayOnce(state.dir, PLACE, ["post", "B"], async () => {
    order.push("B sent");
    return { id: "op-b" };
  }, { now: clock });
  await slowA.started;
  slowA.release();
  await Promise.all([a, b]);
  // When, after the 10-minute window, A and then B are sent again.
  const later = () => t0 + 11 * 60_000;
  const againA = await gatewayOnce(state.dir, PLACE, ["post", "A"], async () => ({ id: "op-a2" }), { now: later });
  // Then the gateway got A before B, and B (the real last post) is the repeat while A goes out again.
  expect(order).toEqual(["A sent", "B sent"]);
  expect(againA).toMatchObject({ id: "op-a2", duplicate: false });
});
