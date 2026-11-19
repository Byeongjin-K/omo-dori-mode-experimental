import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { CheckpointError, takeLock } from "./checkpoint-lock.ts";

// One JSON row appended to an inbox file: the Discord listener's own messages, the lead's notices (backlog, guard), the
// directive and rollover audits and the handover probe all go through here.
// - Private as the listener makes it: a folder made here is 0700, a file 0600, so a guard that writes first leaves no inbox
//   other accounts can read (review 5 of #509).
// - Whole rows only: every append holds <inbox>.lock (flock(2), takeLock) for its write and nothing else, so no other writer
//   lands between its bytes, and a write that fails part way (ENOSPC on a full disk, review 5 of #509) is cut back to the
//   size the file had before it; the error stands for the caller. A writer killed mid-row can still leave half a row:
//   readers go through inboxRows.
const LOCK_WAIT_MS = 5_000;
// waitMs: how long it waits for another append to let go of the lock before it fails (CheckpointError)
export const appendInboxRow = (inbox: string, row: unknown, waitMs = LOCK_WAIT_MS): void => {
  mkdirSync(dirname(inbox), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
  const release = lockInbox(inbox, waitMs);
  try {
    const fd = openSync(inbox, "a", 0o600);
    try {
      const before = fstatSync(fd).size;
      let done = 0;
      try {
        while (done < bytes.length) done += writeSync(fd, bytes, done);
      } catch (error) {
        if (done > 0) ftruncateSync(fd, before);
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    release();
  }
};

// the append's own lock, waited for a short while (another append holds it for one write)
const lockInbox = (inbox: string, waitMs: number): (() => void) => {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return takeLock(`${inbox}.lock`, Date.now(), "inbox append", inbox);
    } catch (e) {
      if (!(e instanceof CheckpointError) || Date.now() > until) throw e;
      Bun.sleepSync(5);
    }
  }
};

// The rows of an inbox file for a reader that must start whatever the file holds (the listener, review 5 of #509 and
// oh-my-pi #8596): a line that is not JSON is skipped, except that a whole row another writer appended right after a torn
// one (no newline between them) is taken from the end of that line. note gets one line when anything was skipped.
export const inboxRows = (file: string, note: (line: string) => void): unknown[] => {
  const rows: unknown[] = [];
  let skipped = 0;
  for (const line of existsSync(file) ? readFileSync(file, "utf8").split("\n") : []) {
    if (!line.trim()) continue;
    const row = parsed(line);
    if (row === undefined || row.at > 0) skipped++;
    if (row !== undefined) rows.push(row.value);
  }
  if (skipped) note(`INBOX_SKIPPED ${file}: ${skipped} line(s) were not whole rows (a write cut off part way) and were left out; every whole row is kept`);
  return rows;
};

// the line as a row, else the longest whole row it ends with (a torn row's prefix before it), with where that row starts
const parsed = (line: string): { readonly value: unknown; readonly at: number } | undefined => {
  for (let at = 0; at >= 0; at = line.indexOf("{", at + 1)) {
    try {
      return { value: JSON.parse(line.slice(at)), at };
    } catch {
      // not a row from here: the torn prefix goes on
    }
  }
  return undefined;
};
