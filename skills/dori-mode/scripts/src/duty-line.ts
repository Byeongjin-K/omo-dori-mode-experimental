// What omo's status lines under its input line (the last line starting with ❯) say is on duty to wake the agent. omo counts
// each source and ends the line in " on duty" ("1 task on duty", "1 wake source · 2 evals on duty"), so the last source's own
// words mark it; a monitor ("◉ watching ...") and a scheduled goal continuation wake it too. Only those status lines count: the
// transcript above the input line may quote any of these words as history (the watch, aoe.ts paneActivity; freshness's STALLED).
const DUTY_MARKS = ["◉ watching", "wake source", " task on duty", " tasks on duty", " eval on duty", " evals on duty", " bash on duty", " bash sessions on duty", "goal continues in"];

export const onDuty = (screen: string): string | undefined => {
  const lines = Bun.stripANSI(screen).split("\n");
  const input = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
  const status = input < 0 ? "" : lines.slice(input + 1).join("\n");
  return DUTY_MARKS.find((m) => status.includes(m))?.trim();
};
