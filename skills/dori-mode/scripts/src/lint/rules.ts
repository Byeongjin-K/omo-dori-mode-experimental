// Runs the three test-hygiene rules of upstream https://github.com/sisyphuslabs/dori-superagent/pull/250 over one
// source file. Upstream carries the rules as an oxlint jsPlugin; the fork keeps Biome as its only linter and adds no
// oxlint, so this walks the same ESTree that oxlint hands a jsPlugin (oxc-parser, the top-level devDependency; knip keeps its own nested copy):
// every node gets its `parent`, each rule's visitor runs on entry and its `<type>:exit` visitor on leaving, in source
// order. No disable comment is honoured, so a finding cannot be hidden from the ratchet.
import { parseSync } from "oxc-parser";
import noFixedSleep from "./no-fixed-sleep.ts";
import noFlakeMasking from "./no-flake-masking.ts";
import noModuleMock from "./no-module-mock.ts";

type AstNode = { readonly type: string; readonly start: number; parent?: AstNode; readonly [key: string]: unknown };
type Visitors = Readonly<Record<string, (node: never) => void>>;
type Rule = {
  readonly meta: { readonly messages: Readonly<Record<string, string>> };
  readonly create: (context: { readonly report: (problem: { readonly node: { readonly type: string }; readonly messageId: string }) => void }) => Visitors;
};

export const RULES: Readonly<Record<string, Rule>> = {
  "dori-testing/no-fixed-sleep": noFixedSleep,
  "dori-testing/no-flake-masking": noFlakeMasking,
  "dori-testing/no-module-mock": noModuleMock,
};

export type Finding = { readonly rule: string; readonly message: string; readonly line: number };
export type Linted = { readonly findings: readonly Finding[]; readonly errors: readonly string[] };

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) line += 1;
  return line;
};

export const lintSource = (file: string, source: string): Linted => {
  const { program, errors } = parseSync(file, source, { preserveParens: false });
  if (errors.length > 0) return { findings: [], errors: errors.map((error) => error.message) };
  const findings: Finding[] = [];
  const active = Object.entries(RULES).map(([rule, { meta, create }]) =>
    create({
      report: ({ node, messageId }) => {
        const { start } = node as AstNode;
        findings.push({ rule, message: meta.messages[messageId] ?? messageId, line: lineAt(source, start) });
      },
    }),
  );
  const visit = (node: AstNode, key: string) => {
    for (const visitors of active) visitors[key]?.(node as never);
  };
  const walk = (node: AstNode, parent: AstNode | undefined) => {
    if (parent !== undefined) node.parent = parent;
    visit(node, node.type);
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) for (const item of value) isAstNode(item) && walk(item, node);
      else if (isAstNode(value)) walk(value, node);
    }
    visit(node, `${node.type}:exit`);
  };
  walk(program as unknown as AstNode, undefined);
  return { findings, errors: [] };
};
