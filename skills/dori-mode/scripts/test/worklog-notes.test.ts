import { expect, test } from "bun:test";
import { Worklog } from "../src/worklog.ts";
import { worklogFacts, worklogSection } from "../src/worklog-notes.ts";
import { withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-11T16:00:00Z");

test("an open item's newest three notes follow its OPEN line, a long one cut at 200 characters and marked, older ones counted", () => {
  // Given one open item with four notes, one of them 260 characters long, and a closed item with a note
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const item = log.add("Wrist lane for gongdori", "discord:777/m3", T0);
    log.next(item.id, "watch #56", T0 + 1000);
    log.note(item.id, "first note, oldest", T0 + 2000);
    log.note(item.id, "told gongdori: the wrist lane opens after #56 merges", T0 + 3000);
    log.note(item.id, "x".repeat(260), T0 + 4000);
    log.note(item.id, "#56 is in review", T0 + 5000);
    const done = log.add("Rename the bot", "discord:777/m4", T0 + 6000);
    log.note(done.id, "closed note", T0 + 7000);
    log.close(done.id, "renamed", T0 + 8000);
    // When
    const facts = worklogFacts(state.dir);
    // Then
    expect(facts).toEqual({ markdown: log.markdownPath, open: 1, lines: [
      `OPEN ${item.id} "Wrist lane for gongdori" source="discord:777/m3" next="watch #56"`,
      `NOTE ${item.id} (1 older note not shown: dori worklog list --open)`,
      `NOTE ${item.id} 2026-10-11T16:00:03.000Z "told gongdori: the wrist lane opens after #56 merges"`,
      `NOTE ${item.id} 2026-10-11T16:00:04.000Z "${"x".repeat(200)}" (cut from 260 characters)`,
      `NOTE ${item.id} 2026-10-11T16:00:05.000Z "#56 is in review"`,
    ] });
  } finally { state.done(); }
});

test("no worklog gives an empty section that says none", () => {
  // Given a state folder without a worklog
  const state = withState();
  try {
    // Then
    expect(worklogSection(worklogFacts(state.dir))).toEqual(["", `## Open worklog items (0, dori worklog list --open; ${new Worklog(state.dir).markdownPath})`, "none"]);
  } finally { state.done(); }
});
