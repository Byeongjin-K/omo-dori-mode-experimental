// From upstream https://github.com/sisyphuslabs/dori-superagent/pull/250 (scripts/lint-ratchet.ts), rooted at
// skills/dori-mode/scripts: `bun run lint:ratchet` counts each rule of src/lint/rules.ts per file under src/ and test/
// (the files lint:loc reads) and compares the counts with lint-ratchet-baseline.json. A rise fails, and so does a drop
// until the baseline is lowered in the same change, so a removed site cannot come back. `--update` only lowers counts
// unless `--allow-increase` is passed. Upstream also counts oxlint/eslint disable comments; the fork's runner honours
// none, so there is nothing to count.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles } from "../../check-loc.ts";
import { type Finding, lintSource, RULES } from "./rules.ts";

const BASELINE_FILE = "lint-ratchet-baseline.json";

type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;
type Change = { readonly file: string; readonly rule: string; readonly before: number; readonly after: number };

const compare = (baseline: Counts, current: Counts) => {
  const increases: Change[] = [];
  const decreases: Change[] = [];
  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
    for (const rule of Object.keys(RULES)) {
      const before = baseline[file]?.[rule] ?? 0;
      const after = current[file]?.[rule] ?? 0;
      if (after > before) increases.push({ file, rule, before, after });
      if (after < before) decreases.push({ file, rule, before, after });
    }
  }
  return { increases, decreases };
};

const readBaseline = (root: string): Counts => {
  const path = join(root, BASELINE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Counts) : {};
};

const lintTree = (root: string) => {
  const counts: Record<string, Record<string, number>> = {};
  const findings = new Map<string, readonly Finding[]>();
  const unparsed: string[] = [];
  for (const file of sourceFiles(root)) {
    const linted = lintSource(file, readFileSync(join(root, file), "utf8"));
    for (const error of linted.errors) unparsed.push(`${file}: ${error}`);
    if (linted.findings.length === 0) continue;
    findings.set(file, linted.findings);
    const perFile: Record<string, number> = {};
    for (const { rule } of linted.findings) perFile[rule] = (perFile[rule] ?? 0) + 1;
    counts[file] = Object.fromEntries(Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { counts, findings, unparsed };
};

const report = (lines: readonly string[]) => {
  for (const line of lines) console.error(line);
};

const main = (root: string, args: readonly string[]): number => {
  const { counts, findings, unparsed } = lintTree(root);
  if (unparsed.length > 0) {
    report([...unparsed, "lint-ratchet: a file that fails to parse cannot be counted; fix the syntax first."]);
    return 1;
  }
  const { increases, decreases } = compare(readBaseline(root), counts);
  const rises = increases.flatMap(({ file, rule, before, after }) => [
    `${file}: ${rule} went up from ${before} to ${after}`,
    ...(findings.get(file) ?? []).filter((f) => f.rule === rule).map((f) => `  ${file}:${f.line} ${f.message}`),
  ]);
  if (args.includes("--update")) {
    if (increases.length > 0 && !args.includes("--allow-increase")) {
      report([...rises, "lint-ratchet: --update only lowers counts; fix the new findings (or pass --allow-increase)."]);
      return 1;
    }
    writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`lint-ratchet: baseline written for ${Object.keys(counts).length} files`);
    return 0;
  }
  report(rises);
  report(decreases.map(({ file, rule, before, after }) => `${file}: ${rule} went down from ${before} to ${after}; lower the baseline in this change`));
  if (increases.length > 0)
    report([`lint-ratchet: new code must not add ${Object.keys(RULES).join(", ")}; wait on the event, inject the dependency, or fix the flake at its cause.`]);
  else if (decreases.length > 0)
    report(["lint-ratchet: run `bun run lint:ratchet:update` and commit the baseline, so removed sites cannot come back."]);
  if (increases.length > 0 || decreases.length > 0) return 1;
  console.log("lint-ratchet: every count matches the baseline");
  return 0;
};

if (import.meta.main) process.exit(main(process.cwd(), process.argv.slice(2)));
