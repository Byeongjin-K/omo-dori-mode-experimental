// From upstream sisyphuslabs/dori-superagent#255 (pull request 255), fitted to the fork's CLI: one option table with
// per-command onlyOptions, --text-file and the literal-newline check, and --question TEXT (the fork's --question is a
// string flag, so upstream's bare --question would take the next word as its value).
/** dori send gateway and dori inbound gateway: the dori.bot surface over the gateway's local socket. */
import type { Cli } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { Gateway, gatewaySocketPath, type LeadPort, unixConnector } from "./messenger/gateway.ts";
import type { InboundFrame, StatusPhase, WorkRow } from "./messenger/gateway-frames.ts";
import { writeLineSync } from "./messenger/telegram-inbound.ts";
import { realClock } from "./run.ts";
import { duplicateLine, SEND_DUPLICATE_EXIT, type Sent, sendKey, sendOnce, sentLine } from "./send-dedupe.ts";
import { join } from "node:path";

const PHASES: ReadonlySet<string> = new Set(["start", "update", "stop"]);
const STATES: ReadonlySet<string> = new Set(["running", "done", "failed"]);
const SEND_OPTIONS = ["text", "text-file", "edit", "status", "status-id", "row", "question", "option", "receipt", "line", "again"];

const socketOf = (cli: Cli): string => gatewaySocketPath(cli.config.gateway.socket);
const gateway = (cli: Cli): Gateway => new Gateway(unixConnector, realClock, socketOf(cli));

// A new message (post, question, receipt) goes out once per conversation and content, as every dori send does
// (src/send-dedupe.ts: SEND_DUPLICATE, exit 3, --again sends it once more); status rows and edits change a message in place
// and are never checked (review 2 of #511: upstream #255's op_id stops only a retry inside one call).
const once = async (cli: Cli, parts: readonly string[], send: () => Promise<Sent>): Promise<string | undefined> => {
  const place = `gateway:${socketOf(cli)}`;
  const r = await sendOnce(join(cli.config.stateDir, "sent"), place, sendKey([place, ...parts]), send, { again: Boolean(cli.flags.values.again) });
  if (!r.duplicate) return r.id;
  console.log(duplicateLine(place, r));
  process.exitCode = SEND_DUPLICATE_EXIT;
  return undefined;
};

/** `--row running:Build the image`; rows are numbered by position, so the same list keeps its ids across updates. */
const rowsOf = (cli: Cli): WorkRow[] =>
  cli.many("row").map((row, i) => {
    const at = row.indexOf(":");
    const state = row.slice(0, at);
    const label = row.slice(at + 1).trim();
    if (at < 0 || !STATES.has(state) || !label) die(`--row must be running|done|failed:<label>, got ${JSON.stringify(row)}`);
    return { id: `r${i + 1}`, label, state: state as WorkRow["state"] };
  });

/** `--line "Total=12,000 KRW"`: one receipt line, split at the first `=`. */
const linesOf = (cli: Cli) =>
  cli.many("line").map((line) => {
    const at = line.indexOf("=");
    if (at <= 0 || at === line.length - 1) die(`--line must be <label>=<value>, got ${JSON.stringify(line)}`);
    return { label: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
  });

export const sendGateway = async (cli: Cli): Promise<void> => {
  const { opt, flags, onlyOptions, postable, textOrFile } = cli;
  onlyOptions("send gateway", SEND_OPTIONS, 1);
  const text = async () => postable(await textOrFile(opt("text"), "send gateway needs --text TEXT or --text-file FILE"), "send");
  const gw = gateway(cli);
  const phase = opt("status");
  const question = opt("question");
  const receipt = opt("receipt");
  if (flags.values.again && (phase !== undefined || flags.values.edit !== undefined)) die("--again is for a new message; an edit or a status row is never checked for repeats");
  if (phase !== undefined) {
    if (!PHASES.has(phase)) die("--status takes start, update or stop, with gateway");
    console.log(`STATUS ${await gw.status(phase as StatusPhase, await text(), rowsOf(cli), opt("status-id"))}`);
  } else if (question !== undefined) {
    const options = cli.many("option").map((label, i) => ({ id: `o${i + 1}`, label }));
    if (!question) die("--question needs the question text");
    if (options.length < 2) die("--question needs at least two --option");
    const text = postable(question, "send");
    const id = await once(cli, ["question", text, ...options.map((o) => o.label)], async () => ({ id: await gw.question(text, options) }));
    if (id) console.log(`QUESTION ${id}`);
  } else if (receipt !== undefined) {
    const lines = linesOf(cli);
    const id = await once(cli, ["receipt", receipt, ...lines.flatMap((l) => [l.label, l.value])], async () => ({ id: await gw.receipt(receipt, lines) }));
    // the socket answers with no copy of what it stored, so the line says content=not-returned
    if (id) console.log(sentLine("SENT", { id }));
  } else {
    const body = await text();
    const target = flags.values.edit === undefined ? undefined : opt("edit") || die("--edit is empty: leave it out to post a new message");
    if (target !== undefined) await gw.edit(target, body);
    else {
      const id = await once(cli, ["post", body], async () => ({ id: await gw.post(body) }));
      if (id) console.log(sentLine("SENT", { id }));
    }
  }
};

/**
 * The shape of the other messengers' lines: `INBOUND <source> <channel> <thread|-> <id> <user|-> <json text>`. The whole
 * text, as dori inbound slack prints it: the line is the only copy the lead gets before the ack (review 1 of #511; upstream
 * #255 cut it at 200 characters).
 */
export const formatGatewayInbound = (sessionId: string, i: InboundFrame): string =>
  i.kind === "message"
    ? `INBOUND gateway ${sessionId} - ${i.id} - ${JSON.stringify(i.text)}`
    : `INBOUND gateway:answer ${sessionId} ${i.question_id} ${i.id} - ${JSON.stringify(i.text ?? "")}${i.option_id ? ` option=${i.option_id}` : ""}`;

/**
 * The lead side of the subscription: one INBOUND line per message or answer. writeLineSync, not console.log, which drops a
 * failed write (a closed stdout): a line stdout did not take throws, so it is never acked and the gateway resends it, as
 * dori inbound telegram keeps its offset (review 1 of #511).
 */
export const gatewayLead =
  (write: (line: string) => void = (line) => void writeLineSync(line)): LeadPort =>
  (session, inbound) =>
    write(`${formatGatewayInbound(session, inbound)}\n`);

export const inboundGateway = async (cli: Cli): Promise<void> => {
  cli.onlyOptions("inbound gateway", ["session"], 1);
  const sessionId = cli.opt("session") || process.env["PI_SESSION_ID"] || die("inbound gateway needs --session or PI_SESSION_ID");
  console.log("INBOUND_READY gateway");
  await gateway(cli).subscribe(sessionId, gatewayLead());
};
