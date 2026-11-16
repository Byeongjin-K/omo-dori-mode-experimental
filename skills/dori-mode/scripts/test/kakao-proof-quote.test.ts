import { expect, test } from "bun:test";
import { handleKakaoProofRequest } from "../../setups/discord-aoe/kakao-proof.ts";

// Discord quoting of a relayed owner message: `> ` per line, or `>>> ` for the rest of the post.
test.each([
  ["multiline quote", "owner", "alpha\nbeta", "> alpha\n> beta\n-# 카톡 근거 kakao:100/6", true],
  ["block quote", "owner", "alpha\nbeta", ">>> alpha\nbeta", true],
  ["owner line starting with >", "owner", "> kept\nnext", "> > kept\n> next", true],
  ["multiline forged", "owner", "alpha\nbeta", "> alpha\n> gamma", false],
  ["block quote keeps owner >", "owner", "alpha\n> beta", ">>> alpha\n> beta", true],
  ["lines then block", "owner", "gamma\n> delta", "> note\n>>> gamma\n> delta", true],
] as const)("relay quote: %s", (_label, kind, content, text, quoted) => {
  const sent_at = Math.floor(Date.now() / 1000);
  const rows = new Map([["100/6", { channel_id: "100", id: "6", author_id: "1", author_kind: kind, sent_at, content }]]);
  expect(handleKakaoProofRequest(JSON.stringify({ chat: "100", log: "6", text }), rows))
    .toEqual({ found: true, chat: "100", log: "6", author_id: "1", author_kind: kind, sent_at, quoted });
});
