// Process-local attestations only: the agent can write the inbox, so it is never a proof source.
export type KakaoProofRow = {
  readonly channel_id: string;
  readonly id: string;
  readonly author_id: string;
  readonly author_kind: "owner" | "member";
  readonly sent_at: number;
  readonly content: string;
};
export type KakaoProofReply =
  | { readonly found: false; readonly error?: string }
  | { readonly found: true; readonly chat: string; readonly log: string; readonly author_id: string;
      readonly author_kind: "owner" | "member"; readonly sent_at: number; readonly quoted: boolean };
export const KAKAO_PROOF_LIMIT = 16384;
const DAY = 86400;

export const normalizeKakaoQuote = (text: string): string =>
  text.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, "$1").replace(/\s+/g, " ").trim();

// Discord quoting: `> ` quotes one line, `>>> ` quotes the rest of the post. Remove one `> ` per line before a `>>> `
// and only the `>>> ` marker itself, so the owner's own `>` characters after it are kept.
const unquoteLines = (text: string): string => text.replace(/^[ \t]*>[ \t]?/gm, "");
export const unquoteRelay = (text: string): string => {
  const block = /^[ \t]*>>>[ \t]?/m.exec(text);
  return block ? unquoteLines(text.slice(0, block.index)) + text.slice(block.index + block[0].length) : unquoteLines(text);
};

export const lookupKakaoProof = (rows: ReadonlyMap<string, KakaoProofRow>, reference: string): KakaoProofRow | undefined => rows.get(reference);

export function pruneKakaoProof(rows: Map<string, KakaoProofRow>, now: number): void {
  for (const [key, value] of rows) {
    if (!Number.isFinite(value.sent_at) || now - value.sent_at > DAY || value.sent_at > now) rows.delete(key);
  }
  while (rows.size > 5000) {
    const first = rows.keys().next();
    if (!first.done) rows.delete(first.value);
  }
}

export function rememberKakaoProof(rows: Map<string, KakaoProofRow>, row: KakaoProofRow, now: number): void {
  rows.delete(`${row.channel_id}/${row.id}`);
  rows.set(`${row.channel_id}/${row.id}`, row);
  pruneKakaoProof(rows, now);
}

export function handleKakaoProofRequest(raw: string, rows: ReadonlyMap<string, KakaoProofRow>): KakaoProofReply {
  if (Buffer.byteLength(raw) > KAKAO_PROOF_LIMIT) return { found: false, error: "too-large" };
  try {
    const request: unknown = JSON.parse(raw);
    if (!request || typeof request !== "object" || !("chat" in request) || !("log" in request) || !("text" in request)
        || typeof request.chat !== "string" || !/^[0-9]{1,20}$/.test(request.chat)
        || typeof request.log !== "string" || !/^[0-9]{1,20}$/.test(request.log) || typeof request.text !== "string") {
      return { found: false, error: "bad-request" };
    }
    const row = lookupKakaoProof(rows, `${request.chat}/${request.log}`);
    if (!row) return { found: false };
    const content = normalizeKakaoQuote(row.content);
    return { found: true, chat: request.chat, log: request.log, author_id: row.author_id,
      author_kind: row.author_kind, sent_at: row.sent_at,
      quoted: content.length > 0 && normalizeKakaoQuote(unquoteRelay(request.text)).includes(content) };
  } catch (error) {
    if (error instanceof SyntaxError) return { found: false, error: "bad-request" };
    throw error;
  }
}

// Mutable connection framing; the deadline is total time, not an idle timer a slow sender can reset.
type Connection = { bytes: Buffer; done: boolean; timer: ReturnType<typeof setTimeout> };
const finish = (socket: Bun.Socket<Connection>, reply: KakaoProofReply): void => {
  if (socket.data.done) return;
  socket.data.done = true;
  clearTimeout(socket.data.timer);
  socket.end(`${JSON.stringify(reply)}\n`);
};

export function startKakaoProofSocket(name: string, rows: Map<string, KakaoProofRow>, log: (line: string) => void): Bun.UnixSocketListener<Connection> | null {
  if (name === "off") return null;
  try {
    const listener = Bun.listen<Connection>({
      unix: `\0${name}`,
      socket: {
        open(socket) {
          socket.data = { bytes: Buffer.alloc(0), done: false,
            timer: setTimeout(() => finish(socket, { found: false, error: "timeout" }), 2000) };
        },
        data(socket, chunk) {
          if (socket.data.done) return;
          const newline = chunk.indexOf(10);
          const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
          if (socket.data.bytes.length + part.length > KAKAO_PROOF_LIMIT) {
            finish(socket, { found: false, error: "too-large" });
            return;
          }
          socket.data.bytes = Buffer.concat([socket.data.bytes, part]);
          if (newline >= 0) {
            pruneKakaoProof(rows, Date.now() / 1000);
            finish(socket, handleKakaoProofRequest(socket.data.bytes.toString("utf8"), rows));
          }
        },
        close(socket) { clearTimeout(socket.data.timer); },
        error(socket) { clearTimeout(socket.data.timer); socket.terminate(); },
      },
    });
    log(`KAKAO_PROOF_READY ${name}`);
    return listener;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    log(`KAKAO_PROOF_OFF ${"code" in error ? String(error.code) : error.name}`);
    return null;
  }
}
