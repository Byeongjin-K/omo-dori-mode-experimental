import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { QuestionCards, QuestionStore } from "../src/messenger/discord-cards.ts";
import { type DiscordMessage, DiscordListener, type GatewayConnection, type ListenerDeps } from "../src/messenger/discord-listener.ts";
import type { Http } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = "100000000000000001";
const GUILD = "400000000000000004";
const CHANNEL = "200000000000000002";

let state: ReturnType<typeof withState>;
afterEach(() => state?.done());

// review 5 of #509 and oh-my-pi #8596: the listener read every inbox line with JSON.parse and no catch, so a row a writer
// killed mid-write left half of (ENOSPC, OOM, a power cut) kept dori inbound discord from starting again: the lead's wake
// path. The rows are as a full disk leaves them: a torn row with the next whole row run on from it, and a torn last line.
test("the listener starts on an inbox a write was cut off in, keeps the whole rows and tells it once", async () => {
  state = withState();
  const inboxFile = `${state.dir}/discord/inbox.jsonl`;
  const whole = { id: "7102", ts: "x", channel_id: CHANNEL, scope: "channel", author_id: OWNER };
  mkdirSync(`${state.dir}/discord`, { recursive: true });
  writeFileSync(inboxFile, `{"id":"7101","ts":"x","content":"cut ${JSON.stringify(whole)}\n{"id":"7103","ts`);
  const http: Http = async () => ({ status: 200, headers: {}, body: "{}" });
  const dc = new Discord(http, { ...fakeClock(0), sleep: async () => {} }, "bot");
  const words = { ...defaultDiscordWords, statusStyle: "emoji" as const };
  const cards = new QuestionCards(dc, new QuestionStore(`${state.dir}/discord`), { channel: CHANNEL, owner: OWNER, words }, () => 0);
  const conn: GatewayConnection = { send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} };
  const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
  const logs: string[] = [];
  const deps: ListenerDeps = { dc, cards, open: () => conn, token: "BOT", guild: GUILD, channel: CHANNEL, owner: OWNER, words, inboxFile, timers, now: () => 0, log: (l) => logs.push(l), fatal: () => {} };
  // When
  const listener = new DiscordListener(deps);
  // Then: started, told once, and the row kept from the torn line is known, so the same message adds no second row
  expect(logs.filter((l) => l.startsWith("INBOX_SKIPPED"))).toHaveLength(1);
  const message: DiscordMessage = { id: "7102", channel_id: CHANNEL, guild_id: GUILD, content: "hello", timestamp: "2026-01-02T03:00:00Z", author: { id: OWNER } };
  await listener.onMessage(message);
  expect(readFileSync(inboxFile, "utf8").split('"id":"7102"')).toHaveLength(2);
});
