import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";

// Why a path given as a working folder (--cwd) is none: missing, a file or under a file (ENOTDIR) is "is not a directory",
// any other stat failure is named by its code; undefined for a directory (upstream #245).
export const dirProblem = (dir: string): string | undefined => {
  try {
    return statSync(dir).isDirectory() ? undefined : "is not a directory";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "is not a directory" : `cannot be read (${code ?? String(e)})`;
  }
};

// A directory every Dori account on this host writes in (backlog.hostDir's lane files, heavyHoldDir's holds): mode 1777,
// sticky, so only a file's owner removes or replaces it. Why it is unsafe to write in (a link, not a directory, no sticky
// bit), or undefined; made when missing.
export const sharedDirProblem = (dir: string): string | undefined => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o1777);
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return "is not a plain directory";
  if (!(st.mode & 0o1000)) return "has no sticky bit (another account could remove or replace this Dori's files)";
  return undefined;
};
