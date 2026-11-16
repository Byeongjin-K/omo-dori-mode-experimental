// The worklog's record lines (split out of worklog.ts, which ports upstream sisyphuslabs/dori-superagent#96).
export type Event =
  | { readonly op: "add"; readonly id: string; readonly at: string; readonly title: string; readonly source: string }
  | { readonly op: "next"; readonly id: string; readonly at: string; readonly text: string }
  | { readonly op: "note"; readonly id: string; readonly at: string; readonly text: string }
  | { readonly op: "close"; readonly id: string; readonly at: string; readonly result: string; readonly ack?: boolean };
export class WorklogError extends Error {}

const ID = /^[0-9a-f]{8}$/;
// C0 and C1 controls (C1 holds U+0085 NEL and the CSI \x9b), DEL, and the Unicode line and paragraph separators.
const singleLine = (value: unknown, max: number): value is string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern deliberately matches control characters to reject or strip them
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export const parseEvent = (value: unknown): Event => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorklogError("worklog record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || !ID.test(record["id"])) throw new WorklogError('worklog field "id" must be 8 lowercase hex digits');
  if (!isoTime(record["at"])) throw new WorklogError('worklog field "at" must be an ISO time as toISOString writes it');
  const fields: Record<string, Record<string, number>> = { add: { title: 200, source: 400 }, next: { text: 1000 }, note: { text: 1000 }, close: { result: 1000 } };
  // Fork change (review of orientpine#352): only the four ops themselves; an inherited name (toString, __proto__) is no op.
  const wanted = typeof record["op"] === "string" && Object.hasOwn(fields, record["op"]) ? fields[record["op"]] : undefined;
  if (!wanted) throw new WorklogError('worklog field "op" must be add, next, note or close');
  // Fork change (#483): a close dori writes now carries ack (true: --ack-promise); one written before has none (worklog.ts close).
  const unknown = Object.keys(record).find((name) => !["op", "id", "at", ...Object.keys(wanted), ...(record["op"] === "close" ? ["ack"] : [])].includes(name));
  if ("ack" in record && typeof record["ack"] !== "boolean") throw new WorklogError('worklog field "ack" must be true or false');
  if (unknown !== undefined) throw new WorklogError(`unknown worklog field "${unknown}"`);
  for (const [name, max] of Object.entries(wanted)) {
    if (!singleLine(record[name], max)) throw new WorklogError(`worklog field "${name}" must be one nonempty line of at most ${max} characters`);
  }
  return record as Event;
};

// Every record is JSON.stringify of an event built op first, so it starts with this.
const RECORD_START = '{"op":"';
/** A line that does not parse but begins like a record is a write cut off halfway: harmless, and skipped quietly. */
export const isTorn = (line: string): boolean => line.startsWith(RECORD_START) || RECORD_START.startsWith(line);
