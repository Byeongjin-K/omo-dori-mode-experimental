// Ported from upstream sisyphuslabs/dori-superagent#96 (https://github.com/sisyphuslabs/dori-superagent/pull/96, commit 067b70f).
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { promiseLines } from "./worklog-promise.ts";
import { type Event, isTorn, parseEvent, WorklogError } from "./worklog-record.ts";

export { WorklogError };

export type WorklogItem = {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly openedAt: string;
  readonly next?: string;
  readonly notes: readonly { readonly at: string; readonly text: string }[];
  readonly closedAt?: string;
  readonly result?: string;
};
/** problems are damage; warnings are the normal results of racing writers that are still worth naming. */
export type WorklogRead = { readonly items: WorklogItem[]; readonly problems: string[]; readonly warnings: string[] };

/** First line of a worklog.md this module wrote. A file without it is someone's notes and is never replaced. */
export const WORKLOG_MARKER = "<!-- written by dori worklog from worklog.jsonl; change it with the command -->";

const ownedOrAbsent = (path: string): boolean =>
  !existsSync(path) || readFileSync(path, "utf8").split("\n", 1)[0] === WORKLOG_MARKER;

/**
 * Write a rendered worklog.md through a temp file and rename, so a reader never sees half a file. The marker is checked
 * again right before the rename: a file someone wrote meanwhile is kept, and this publish is skipped (returns false).
 * beforeCheck runs between the temp write and that check.
 */
export const publishWorklog = (path: string, markdown: string, beforeCheck: () => void = () => {}): boolean => {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, markdown, { encoding: "utf8", mode: 0o600 });
    beforeCheck();
    if (!ownedOrAbsent(path)) return false;
    renameSync(tmp, path);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
};

/**
 * The lead's list of owner requests. worklog.jsonl is the record: one O_APPEND write per change, so concurrent
 * writers never lose each other's lines. worklog.md is rendered from it after every change for the lead to read.
 */
export class Worklog {
  readonly path: string;
  readonly markdownPath: string;

  /** beforeAppend runs right before the record is appended (fork change for tests: another writer's append lands there). */
  constructor(readonly stateDir: string, private readonly beforeAppend: () => void = () => {}) {
    this.path = join(stateDir, "worklog.jsonl");
    this.markdownPath = join(stateDir, "worklog.md");
  }

  read(): WorklogRead {
    return this.fold(existsSync(this.path) ? readFileSync(this.path, "utf8") : "");
  }

  open(): WorklogItem[] {
    return this.read().items.filter((item) => item.closedAt === undefined);
  }

  add(title: string, source: string, now: number): WorklogItem {
    const known = new Set(this.read().items.map((item) => item.id));
    let id = randomBytes(4).toString("hex");
    while (known.has(id)) id = randomBytes(4).toString("hex");
    return this.write({ op: "add", id, at: new Date(now).toISOString(), title: title.trim(), source: source.trim() });
  }

  next(id: string, text: string, now: number): WorklogItem {
    this.openItem(id);
    return this.write({ op: "next", id, at: new Date(now).toISOString(), text: text.trim() });
  }

  note(id: string, text: string, now: number): WorklogItem {
    this.openItem(id);
    return this.write({ op: "note", id, at: new Date(now).toISOString(), text: text.trim() });
  }

  // Fork change (worklog da078c1a): a note or Next line that reads as a promise (promiseLines) stops it, unless acknowledged.
  // The record decides (fold): a close without ack is ignored when the item holds a promise at its place, so a promise
  // note another writer appends between this check and the append stops it too (review 1 of #483).
  close(id: string, result: string, now: number, opts: { readonly ackPromise?: boolean } = {}): WorklogItem {
    const refusal = (item: WorklogItem) => new WorklogError([...promiseLines(item).map((line) => `WORKLOG_CLOSE_PROMISE ${id} ${line}`), `WORKLOG_CLOSE_REFUSED ${id}: the line above reads as a promise still owed; keep it or hand it on, then close again with --ack-promise`].join("\n"));
    const item = this.openItem(id);
    if (!opts.ackPromise && promiseLines(item).length) throw refusal(item);
    const closed = this.write({ op: "close", id, at: new Date(now).toISOString(), result: result.trim(), ...(opts.ackPromise ? { ack: true as const } : {}) });
    if (closed.closedAt === undefined) throw refusal(closed);
    return closed;
  }

  private openItem(id: string): WorklogItem {
    const item = this.read().items.find((candidate) => candidate.id === id);
    if (!item) throw new WorklogError(`worklog item not found: ${id}`);
    if (item.closedAt !== undefined) throw new WorklogError(`worklog item ${id} is closed: ${item.result ?? ""}`);
    return item;
  }

  private fold(text: string): WorklogRead {
    const items = new Map<string, WorklogItem>();
    const problems: string[] = [];
    const warnings: string[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (!isTorn(line)) problems.push(`${this.path}:${index + 1}: ${error.message}`);
        continue;
      }
      try {
        const event = parseEvent(value);
        const item = items.get(event.id);
        if (event.op === "add") {
          if (item) throw new WorklogError(`worklog item ${event.id} was already added`);
          items.set(event.id, { id: event.id, title: event.title, source: event.source, openedAt: event.at, notes: [] });
          continue;
        }
        if (!item) throw new WorklogError(`worklog item ${event.id} was never added`);
        // Two writers can both see the item open and append. The first close wins; a second close is the same race's
        // normal result and is a no-op, and a next or note after the close is ignored and named as a warning.
        if (item.closedAt !== undefined && event.op === "close") continue;
        if (item.closedAt !== undefined) {
          warnings.push(`${this.path}:${index + 1}: worklog item ${event.id} was already closed; ${event.op} ignored`);
          continue;
        }
        if (event.op === "next") items.set(event.id, { ...item, next: event.text });
        else if (event.op === "note") items.set(event.id, { ...item, notes: [...item.notes, { at: event.at, text: event.text }] });
        else if (event.op === "close" && !event.ack && promiseLines(item).length) warnings.push(`${this.path}:${index + 1}: worklog item ${event.id} close without --ack-promise ignored: a note or its Next reads as a promise`);
        else if (event.op === "close") items.set(event.id, { ...item, closedAt: event.at, result: event.result });
      } catch (error) {
        if (!(error instanceof WorklogError)) throw error;
        problems.push(`${this.path}:${index + 1}: ${error.message}`);
      }
    }
    return { items: [...items.values()], problems, warnings };
  }

  private write(event: Event): WorklogItem {
    parseEvent(event);
    mkdirSync(this.stateDir, { recursive: true });
    // Check before the append, so a refused render leaves the record unchanged too.
    this.ensureOwnedMarkdown();
    const fd = openSync(this.path, "a", 0o600);
    try {
      // A writer that stopped mid-record left no newline: start on a fresh line so only the torn line is damaged.
      // Fork change (review of orientpine#352): the newline goes into the same append every time. Upstream looked at the
      // tail first, and a torn record another writer left between that look and this append swallowed this record.
      // The blank lines it leaves are skipped by every reader.
      this.beforeAppend();
      writeSync(fd, `\n${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
    const item = this.render().items.find((candidate) => candidate.id === event.id);
    if (!item) throw new WorklogError(`worklog item ${event.id} did not read back`);
    return item;
  }

  private ensureOwnedMarkdown(): void {
    if (!ownedOrAbsent(this.markdownPath)) throw new WorklogError(`${this.markdownPath} was not written by dori worklog; move it aside before using the command`);
  }

  /** Rewrite worklog.md from the whole record. */
  private render(): WorklogRead {
    const text = renderUntilStable(() => readFileSync(this.path), (record) => {
      publishWorklog(this.markdownPath, renderWorklog(this.fold(record).items));
    }, () => statSync(this.path).size);
    return this.fold(text);
  }
}

/**
 * Publish a view of an append-only record until the record stopped growing during the publish. Another writer that
 * appended meanwhile may have published before us, leaving our older view last, so we publish again. The last publish
 * to finish therefore always holds every record, without a lock. The sizes are compared in bytes as read: decoding a
 * line cut inside a multi-byte character changes its length, and the sizes would then never match.
 */
export const renderUntilStable = (read: () => Buffer, publish: (record: string) => void, size: () => number): string => {
  for (;;) {
    const bytes = read();
    const record = bytes.toString("utf8");
    publish(record);
    if (size() === bytes.length) return record;
  }
};

const itemBlock = (item: WorklogItem): string => [
  `### ${item.id} ${item.title}`,
  `- Source: ${item.source}`,
  `- Opened: ${item.openedAt}`,
  `- Next: ${item.next ?? "(none yet)"}`,
  ...(item.notes.length ? ["- Notes:", ...item.notes.map((note) => `  - ${note.at} ${note.text}`)] : []),
  ...(item.closedAt !== undefined ? [`- Closed: ${item.closedAt}`, `- Result: ${item.result ?? ""}`] : []),
].join("\n");

export const renderWorklog = (items: readonly WorklogItem[]): string => {
  const open = items.filter((item) => item.closedAt === undefined);
  const closed = items.filter((item) => item.closedAt !== undefined).reverse();
  const section = (title: string, list: readonly WorklogItem[]) => `## ${title}\n\n${list.length ? list.map(itemBlock).join("\n\n") : "(none)"}\n`;
  return `${WORKLOG_MARKER}\n# Worklog\n\n${section("Open", open)}\n${section("Closed", closed)}`;
};

/** One open item as dori boot and a handover note show it. */
export const openLine = (item: WorklogItem): string =>
  `OPEN ${item.id} ${JSON.stringify(item.title)} source=${JSON.stringify(item.source)} next=${JSON.stringify(item.next ?? "")}`;

export const worklogLines = (items: readonly WorklogItem[]): string[] => {
  const open = items.filter((item) => item.closedAt === undefined);
  return [
    `WORKLOG open=${open.length}`,
    ...open.map(openLine),
  ];
};
