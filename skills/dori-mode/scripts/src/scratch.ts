import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Lane rule 9 of dori-superagent #252 (https://github.com/sisyphuslabs/dori-superagent/pull/252): a lane's scratch clones,
// checkouts, builds and test copies go under this folder, one per lane key, never /tmp, and are gone before it claims
// done. On 0a83 (2026-11-19) the root disk hit 100% from lane test copies left in /tmp; /tmp is on the same disk there,
// so what helps is one known folder per lane and a word when it is left. The lane removes it: dori never does.
export const SCRATCH_ROOT = "~/.cache/dori-scratch";

const sizeOf = (dir: string): number =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((sum, e) => {
    try {
      return e.isFile() ? sum + lstatSync(join(e.parentPath, e.name)).size : sum;
    } catch {
      return sum;
    }
  }, 0);

const human = (bytes: number): string => {
  const units = ["B", "K", "M", "G", "T"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return u ? `${n.toFixed(1)}${units[u]}` : `${n}B`;
};

export const scratchLeft = (key: string, home = process.env["HOME"] || homedir()): string | undefined => {
  const dir = join(home, SCRATCH_ROOT.slice(2), key);
  let size: string;
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    size = human(sizeOf(dir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    size = `size-unknown (${(e as Error).message.slice(0, 80)})`;
  }
  return `DORI_SCRATCH_LEFT ${key} ${size} ${dir}: the lane's scratch folder is still there; dori does not remove it, the lane deletes it once nothing needs it`;
};
