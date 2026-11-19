// From upstream sisyphuslabs/dori-superagent#255 (pull request 255), fitted to the fork's CLI: one option table with
// per-command onlyOptions, --text-file and the literal-newline check, and --question TEXT (the fork's --question is a
// string flag, so upstream's bare --question would take the next word as its value).
/** dori send gateway and dori inbound gateway: the dori.bot surface over the gateway's local socket. */
import type { Cli } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { Gateway, gatewaySocketPath, unixConnector } from "./messenger/gateway.ts";
import type { InboundFrame, StatusPhase, WorkRow } from "./messenger/gateway-frames.ts";
import { realClock } from "./run.ts";

const PHASES: ReadonlySet<string> = new Set(["start", "update", "stop"]);
const STATES: ReadonlySet<string> = new Set(["running", "done", "failed"]);
const SEND_OPTIONS = ["text", "text-file", "edit", "status", "status-id", "row", "question", "option", "receipt", "line"];

const gateway = (cli: Cli): Gateway => new Gateway(unixConnector, realClock, gatewaySocketPath(cli.config.gateway.socket));

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
  if (phase !== undefined) {
    if (!PHASES.has(phase)) die("--status takes start, update or stop, with gateway");
    console.log(`STATUS ${await gw.status(phase as StatusPhase, await text(), rowsOf(cli), opt("status-id"))}`);
  } else if (question !== undefined) {
    const options = cli.many("option").map((label, i) => ({ id: `o${i + 1}`, label }));
    if (!question) die("--question needs the question text");
    if (options.length < 2) die("--question needs at least two --option");
    console.log(`QUESTION ${await gw.question(postable(question, "send"), options)}`);
  } else if (receipt !== undefined) {
    console.log(`SENT ${await gw.receipt(receipt, linesOf(cli))}`);
  } else {
    const body = await text();
    const target = flags.values.edit === undefined ? undefined : opt("edit") || die("--edit is empty: leave it out to post a new message");
    if (target !== undefined) await gw.edit(target, body);
    else console.log(`SENT ${await gw.post(body)}`);
  }
};

/** The shape of the other messengers' lines: `INBOUND <source> <channel> <thread|-> <id> <user|-> <json text>`. */
export const formatGatewayInbound = (sessionId: string, i: InboundFrame): string =>
  i.kind === "message"
    ? `INBOUND gateway ${sessionId} - ${i.id} - ${JSON.stringify(i.text.slice(0, 200))}`
    : `INBOUND gateway:answer ${sessionId} ${i.question_id} ${i.id} - ${JSON.stringify((i.text ?? "").slice(0, 200))}${i.option_id ? ` option=${i.option_id}` : ""}`;

export const inboundGateway = async (cli: Cli): Promise<void> => {
  cli.onlyOptions("inbound gateway", ["session"], 1);
  const sessionId = cli.opt("session") || process.env["PI_SESSION_ID"] || die("inbound gateway needs --session or PI_SESSION_ID");
  console.log("INBOUND_READY gateway");
  await gateway(cli).subscribe(sessionId, (session, inbound) => console.log(formatGatewayInbound(session, inbound)));
};
