import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// One JSON row appended to an inbox file: the Discord listener's own messages, the lead's notices (backlog, guard), the
// directive and rollover audits and the handover probe all go through here.
// - Private as the listener makes it: a folder made here is 0700, a file 0600, so a guard that writes first leaves no inbox
//   other accounts can read (review 5 of #509).
// - Whole rows only: a write that fails part way (ENOSPC on a full disk, review 5 of #509) is cut back to the size the file
//   had before it, so no half row is left for the listener's restart to choke on; the error stands for the caller. When
//   another writer appended after the half row, cutting would drop its row, so the half row is ended with a newline instead.
export const appendInboxRow = (inbox: string, row: unknown): void => {
  mkdirSync(dirname(inbox), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
  const fd = openSync(inbox, "a", 0o600);
  try {
    const before = fstatSync(fd).size;
    let done = 0;
    try {
      while (done < bytes.length) done += writeSync(fd, bytes, done);
    } catch (error) {
      if (done > 0) {
        if (fstatSync(fd).size === before + done) ftruncateSync(fd, before);
        else writeSync(fd, "\n");
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
};
