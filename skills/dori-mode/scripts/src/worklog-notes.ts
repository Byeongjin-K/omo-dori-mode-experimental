import { openLine, Worklog, type WorklogItem } from "./worklog.ts";

// How much of an item's notes a handover note carries: the newest few, each cut short, so the note stays small.
export const NOTE_LINES_MAX = 3;
export const NOTE_CHARS_MAX = 200;

/**
 * An open item's notes for a handover note, newest last: `NOTE <id> <at> "<text>"`, a cut one marked, older ones counted.
 * Fork change (zzangdori's repair request, worklog da078c1a): a promise to another dori may live only in a note, and a note
 * that carried the Next line alone let the new lead close it.
 */
export const worklogNoteLines = (item: WorklogItem): string[] => {
  const older = item.notes.length - NOTE_LINES_MAX;
  return [
    ...(older > 0 ? [`NOTE ${item.id} (${older} older note${older === 1 ? "" : "s"} not shown: dori worklog list --open)`] : []),
    ...item.notes.slice(-NOTE_LINES_MAX).map((note) => note.text.length > NOTE_CHARS_MAX
      ? `NOTE ${item.id} ${note.at} ${JSON.stringify(note.text.slice(0, NOTE_CHARS_MAX))} (cut from ${note.text.length} characters)`
      : `NOTE ${item.id} ${note.at} ${JSON.stringify(note.text)}`),
  ];
};

export type WorklogFacts = { readonly markdown: string; readonly open: number; readonly lines: readonly string[] };

// Upstream https://github.com/sisyphuslabs/dori-superagent/pull/96 lists these in dori boot; a handover note (the lead's and
// a lane's) lists each OPEN line with its NOTE lines. A damaged or unreadable record is named, never a refusal.
export const worklogFacts = (stateDir: string): WorklogFacts => {
  const log = new Worklog(stateDir);
  try {
    const read = log.read();
    const open = read.items.filter((item) => item.closedAt === undefined);
    return { markdown: log.markdownPath, open: open.length, lines: [...open.flatMap((item) => [openLine(item), ...worklogNoteLines(item)]), ...read.problems.map((p) => `WORKLOG damaged ${p}`), ...read.warnings.map((w) => `WORKLOG warning ${w}`)] };
  } catch (error) {
    return { markdown: log.markdownPath, open: 0, lines: [`WORKLOG unreadable ${log.path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
};

/** The Open worklog items section, the same in a lead's and a lane's handover note. */
export const worklogSection = (w: WorklogFacts | undefined): string[] =>
  w ? ["", `## Open worklog items (${w.open}, dori worklog list --open; ${w.markdown})`, ...(w.lines.length ? w.lines.map((l) => `- ${l}`) : ["none"])] : [];
