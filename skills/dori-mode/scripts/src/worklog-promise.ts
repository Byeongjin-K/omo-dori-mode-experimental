import type { WorklogItem } from "./worklog.ts";

// Fork change (zzangdori's repair request, worklog da078c1a): the old lead's promise to another dori ("the wrist lane opens
// after #56 merges") lived only in a note, and the new lead closed the item. Words that read as a promise still owed, broad
// on purpose: a promise closed by mistake costs more than one dori worklog close --ack-promise.
const PROMISE = /뒤|후에|이후|다음에|나중에|열 것|할 것|하기로|약속|(?:할|열|줄|드릴)게|\b(?:after|once|later|will|promis\w*)\b|'ll\b/i;

/** The note and Next lines of an item that read as a promise, as `note <at> "<text>"` or `next "<text>"`. */
export const promiseLines = (item: WorklogItem): string[] => [
  ...item.notes.filter((note) => PROMISE.test(note.text)).map((note) => `note ${note.at} ${JSON.stringify(note.text)}`),
  ...(item.next !== undefined && PROMISE.test(item.next) ? [`next ${JSON.stringify(item.next)}`] : []),
];
