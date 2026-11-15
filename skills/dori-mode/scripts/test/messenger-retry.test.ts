// From upstream dori-superagent #230 test/messenger.test.ts (https://github.com/sisyphuslabs/dori-superagent/pull/230): a thrown
// network error is retried on the same backoff ladder as a 5xx; the fork's case for an aborted request is its own.
import { expect, test } from "bun:test";

import { type Http, type HttpResponse, withBackoff } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const sleeps = () => {
  const waited: number[] = [];
  const clock = { ...fakeClock(0), sleep: async (ms: number) => { waited.push(ms); } };
  return { clock, waited };
};

test("a network-level failure is retried with the same backoff and the message lands", async () => {
  let attempts = 0;
  const http: Http = async () => {
    attempts++;
    if (attempts === 1) throw new Error("socket hang up");
    return ok({ ok: true, result: { message_id: 5 } });
  };
  const { clock, waited } = sleeps();
  expect(await new Telegram(http, clock, "b").send({ chatId: 1 }, "hi")).toBe(5);
  expect(attempts).toBe(2);
  expect(waited).toEqual([1000]);
});

test("a network failure on every attempt rethrows the last error after the full backoff ladder", async () => {
  const http: Http = async () => {
    throw new Error("connection reset");
  };
  const { clock, waited } = sleeps();
  const err = await new Telegram(http, clock, "b").send({ chatId: 1 }, "hi").catch((e: unknown) => e);
  expect((err as Error).message).toBe("connection reset");
  expect(waited).toEqual([1000, 2000, 4000, 8000]);
});

test("a request its caller aborted is not retried", async () => {
  const aborted = new AbortController();
  aborted.abort(new Error("caller gave up"));
  let attempts = 0;
  const http: Http = async (req) => {
    attempts++;
    throw req.signal?.reason;
  };
  const { clock, waited } = sleeps();
  await expect(withBackoff(http, clock, { method: "POST", url: "https://x.invalid/", signal: aborted.signal })).rejects.toThrow("caller gave up");
  expect(attempts).toBe(1);
  expect(waited).toEqual([]);
});
