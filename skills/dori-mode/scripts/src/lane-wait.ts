import { readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";

import { tmuxPanePid } from "./aoe.ts";
import { type BackgroundJob, pendingBackground, pidAlive, restoredMonitors, sessionFile, taskOpen, taskRecord, taskRecords } from "./background.ts";
import type { Runner } from "./run.ts";
import { descendants, type Proc, procTable } from "./session-id.ts";

// A dori heavy run (queued, running here or sent to a helper: its dori heavy process lives until the result is back) is the
// lane's when the pane's shell runs it or it runs in the lane's folder (started with nohup or setsid, it leaves the shell's
// tree). One per run: the outermost of the lane's own heavy processes (a wrapper of another lane's, or the shell's command
// line naming dori heavy, takes no run away). A run a child task started belongs to that task's host and counts through the task.
const HEAVY_CMD = /(?:^|[\s/])(?:dori|cli\.ts) heavy(?:\s|$)/;
const cwdOf = (pid: number): string | undefined => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
};
const heavyRuns = (table: readonly Proc[], shell: number, cwd: string): BackgroundJob[] => {
  const under = new Set(shell ? [shell, ...descendants(table, shell).map((p) => p.pid)] : []);
  const inFolder = (pid: number): boolean => {
    const at = cwd ? cwdOf(pid) : undefined;
    return at !== undefined && (at === cwd || at.startsWith(`${cwd}/`));
  };
  const own = table.filter((p) => HEAVY_CMD.test(p.cmd) && (under.has(p.pid) || inFolder(p.pid)));
  const ids = new Set(own.map((p) => p.pid));
  return own.filter((p) => !ids.has(p.ppid)).map((p) => ({ kind: "heavy" as const, id: String(p.pid), at: 0 }));
};

// What an idle lane still waits on, for the blocked check (done-flow.ts BG_WAITING) and freshness (no STALLED beside it):
// the jobs its transcript started and did not end (a task whose senpi record says it ended is not one), the tasks of its
// session senpi's record says still run (their host alive), and its dori heavy runs. Jobs started before the agent process
// started died with the earlier process; jobs started before notBefore (a server or watcher left running for hours) are not
// what the lane waits on. undefined when the lane's session cannot be read and no heavy run is its.
export const laneBackground = async (run: Runner, sessionsDir: string, pane: string, cwd: string, until = Number.POSITIVE_INFINITY, notBefore = 0, home = homedir()): Promise<BackgroundJob[] | undefined> => {
  const table = await procTable(run);
  const heavy = heavyRuns(table, await tmuxPanePid(run, pane), cwd);
  const file = await sessionFile(run, sessionsDir, pane, cwd, table);
  if (!file) return heavy.length ? heavy : undefined;
  const started = Date.parse((await run(["ps", "-o", "lstart=", "-p", String(file.pid)])).out.trim());
  const jobs = pendingBackground(readFileSync(file.path, "utf8"), Math.max(Number.isNaN(started) ? 0 : started, notBefore), until).filter((j) => {
    const r = j.kind === "task" ? taskRecord(home, j.id) : undefined;
    return !r || taskOpen(r);
  });
  const id = /_([^_]+)\.jsonl$/.exec(file.path)?.[1];
  const tasks = id ? taskRecords(home, id).filter((r) => taskOpen(r) && (r.host === undefined || pidAlive(r.host)) && !jobs.some((j) => j.id === r.id)) : [];
  const restored = id && !Number.isNaN(started) ? restoredMonitors(sessionsDir, cwd, id, started) : [];
  return [...jobs, ...tasks.map((r) => ({ kind: "task" as const, id: r.id, at: Date.parse(r.at ?? "") || 0 })), ...restored.map((m) => ({ kind: "monitor" as const, id: `restored:${m.description}`, at: 0 })), ...heavy];
};
