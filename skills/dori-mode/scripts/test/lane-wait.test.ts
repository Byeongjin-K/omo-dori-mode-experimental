// What an idle lane waits on (lane-wait.ts laneBackground): GongDori's e7-e2e-plan-exec waited at its prompt on a child task
// ("1 task on duty") and on a dori heavy run, 2026-11-18, and freshness called it STALLED every two minutes. senpi's task record
// and the process table say so, whatever the transcript or screen shows.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneBackground } from "../src/lane-wait.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const ID = "99999999-9999-4999-8999-999999999999";
const PANE = "aoe_fix-a_abcdef12";
// the pane's shell (tmux pane_pid 10) runs the lane's agent under session ID
const AGENT = `10 1 /bin/bash /dev/fd/4\n11 10 /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin --model m --session-id ${ID}`;

let state: ReturnType<typeof withState>;
let world: World;
let sessions: string;
const run = () => depsFor(world, fakeClock(T0), state.dir, { backend: "aoe" }).run;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.ps = AGENT;
  world.agentStart = new Date(T0).toUTCString();
  sessions = join(state.dir, "sessions");
  const dir = join(sessions, "--tmp-w--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-01-01T12-00-01-000Z_${ID}.jsonl`), `${JSON.stringify({ type: "message", message: { role: "user", content: "QA. Read and execute the lane brief" } })}\n`);
});
afterEach(() => state.done());

const taskFile = (home: string, id: string, status: string) => {
  const dir = join(home, ".omo", "agent", "projects", "p", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ task_id: id, status, parent_session_id: ID, started_at: new Date(T0).toISOString() }));
};

test("the lane session's task that senpi's record says still runs counts, and not once the record says it ended", async () => {
  const home = join(state.dir, "home");
  taskFile(home, "st_0e2e", "running");
  expect(await laneBackground(run(), sessions, PANE, "/tmp/w", Number.POSITIVE_INFINITY, 0, home)).toEqual([{ kind: "task", id: "st_0e2e", at: T0 }]);
  taskFile(home, "st_0e2e", "completed");
  expect(await laneBackground(run(), sessions, PANE, "/tmp/w", Number.POSITIVE_INFINITY, 0, home)).toEqual([]);
});

test("a dori heavy run under the lane's shell or in the lane's folder counts once per run, and not another folder's", async () => {
  world.ps = `${AGENT}\n12 10 timeout 3600 /home/u/.dori/bin/dori heavy fullcpu2 --kind cpu --local -- bash ./run.sh\n13 12 bun /home/u/.bun/bin/dori heavy fullcpu2 --kind cpu --local -- bash ./run.sh`;
  expect((await laneBackground(run(), sessions, PANE, "/tmp/w"))?.map((j) => `${j.kind}:${j.id}`)).toEqual(["heavy:12"]);
  // the pane's own command line names the run (a QA pane, 2026-11-18): it is the lane's, not a stranger that hides its child
  world.ps = `${AGENT.replace("/bin/bash /dev/fd/4", "bash -c printf x; /home/u/.dori/bin/dori heavy fullcpu2 -- ./run.sh; sleep 900")}\n12 10 /bin/bash /home/u/.dori/bin/dori heavy fullcpu2 -- ./run.sh`;
  expect((await laneBackground(run(), sessions, PANE, "/tmp/w"))?.map((j) => `${j.kind}:${j.id}`)).toEqual(["heavy:10"]);
  // started with nohup or setsid it leaves the shell's tree; its folder still ties it to the lane
  world.ps = `${AGENT}\n${process.pid} 1 bun /home/u/.bun/bin/dori heavy apart --kind cpu -- true`;
  expect((await laneBackground(run(), sessions, PANE, process.cwd()))?.map((j) => `${j.kind}:${j.id}`)).toEqual([`heavy:${process.pid}`]);
  expect(await laneBackground(run(), sessions, PANE, "/tmp/w")).toEqual([]);
});
