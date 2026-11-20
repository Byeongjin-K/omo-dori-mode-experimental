import type { Runner } from "./run.ts";

// A disk-full write stops an hc core's registry writer for good: every call that saves terminals (hc ls among them) then
// fails with "cannot save terminals: registry writer stopped", and it stays so when the disk has room again (hc 0.1.18;
// OkDori 2026-11-19 for 3 h 43 min, ZzangDori's default core for about 18 h, no lead told). hc server restart starts a new
// core beside the holder, so every program and terminal address stays (a test core, hc-registry-stuck lane); an attached
// client's stream ends and doriterm's attach.sh attaches again. own: this Dori's core, which the guard restarts itself;
// another core (the doriterm host's default core, where doriface-host may need a restart after it) is only told.
export type HcCore = { readonly name: string; readonly own: boolean };
export type HcGuardDeps = { readonly cores: readonly HcCore[]; readonly up: (core: string) => Promise<boolean>; readonly run: Runner };
export type HcStuck = { passes: number; restarted?: boolean; waited?: boolean };
const STOPPED = "registry writer stopped";

// HC_SESSION for one hc call: the default core is the one with none
const coreEnv = (core: string) => ({ HC_SESSION: core === "default" ? undefined : core });
const hcStuckNow = async (hc: HcGuardDeps, core: string): Promise<boolean> => {
  const ls = await hc.run(["hc", "--json", "ls"], { env: coreEnv(core), timeoutMs: 20_000 });
  return ls.code !== 0 && `${ls.err}\n${ls.out}`.includes(STOPPED);
};

// The lines of one hc pass, wake: the lead's inbox gets it too. A core is asked only while its socket answers, since any
// hc call starts a core. One stuck answer is told; a second one on the next pass restarts an own core, once per episode
// and not while the disk is still low (the new writer would stop again).
export const hcPass = async (hc: HcGuardDeps, state: { hc?: Record<string, HcStuck> }, diskLow: string | undefined): Promise<{ line: string; wake: boolean }[]> => {
  const out: { line: string; wake: boolean }[] = [];
  const seen = { ...state.hc };
  for (const { name, own } of hc.cores) {
    if (!(await hc.up(name))) continue;
    const was = seen[name];
    if (!(await hcStuckNow(hc, name))) {
      if (was) out.push({ line: `HOST_GUARD HC_CLEAR ${name}: hc ls answers again`, wake: true });
      delete seen[name];
      continue;
    }
    const now: HcStuck = { ...was, passes: (was?.passes ?? 0) + 1 };
    seen[name] = now;
    if (!was) {
      const next = own ? "the guard restarts this Dori's own core on its next pass if it stays so (hc server restart: programs and terminal addresses stay)" : `not this Dori's own core, so the guard does not restart it: ${name === "default" ? "env -u HC_SESSION -u HC_SOCKET" : `env -u HC_SOCKET HC_SESSION=${name}`} hc server restart revives it (programs keep running), then systemctl --user restart doriface-host if doriterm's host runs on it`;
      out.push({ line: `HOST_GUARD HC_STUCK ${name}: hc ls fails with "cannot save terminals: ${STOPPED}" (a disk-full write stopped the core's registry writer, and it stays stopped when the disk has room again); ${next}`, wake: true });
      continue;
    }
    if (!own || now.restarted) continue;
    if (diskLow) {
      if (!now.waited) out.push({ line: `HOST_GUARD HC_RESTART_WAIT ${name}: ${diskLow}; the restart waits for room`, wake: false });
      now.waited = true;
      continue;
    }
    now.restarted = true;
    const r = await hc.run(["hc", "--json", "server", "restart"], { env: coreEnv(name), timeoutMs: 60_000 });
    if (r.code === 0 && !(await hcStuckNow(hc, name))) {
      out.push({ line: `HOST_GUARD HC_RESTART ${name} ok: hc server restart, programs kept`, wake: true }, { line: `HOST_GUARD HC_CLEAR ${name}: hc ls answers again`, wake: true });
      delete seen[name];
    } else {
      const why = r.code === 0 ? "hc ls still fails after hc server restart" : `hc server restart failed (${r.code}): ${(r.err || r.out).trim().slice(0, 160)}`;
      out.push({ line: `HOST_GUARD HC_RESTART ${name} failed: ${why}; not tried again until it clears`, wake: true });
    }
  }
  state.hc = seen;
  return out;
};
