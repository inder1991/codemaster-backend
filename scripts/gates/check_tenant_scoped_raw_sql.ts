// Tenancy raw-SQL gate (ts-morph port of the frozen scripts/check_tenant_scoped_raw_sql.py).
//
// Walks every `sql`...`` tagged template (Kysely raw SQL — the TS equivalent of SQLAlchemy
// `session.execute(text(...))`). For each FROM/JOIN/INTO/UPDATE reference to a TENANT_SCOPED table,
// requires one of three escape hatches, else emits a WARN finding:
//   (a) the SQL contains an `installation_id` token (the tenancy filter), OR
//   (b) the enclosing method/class carries an `@privileged_path` decorator, OR
//   (c) a same-line or preceding-line `// tenant:exempt reason=<...> follow_up=<...>` marker.
//
// WARN-mode in v1 (per CLAUDE.md GF-3): reports to stderr, always exits 0. ERROR-mode is the tracked
// follow-up FOLLOW-UP-gf3-error-mode — do NOT silently promote it.
import { Project, SyntaxKind } from "ts-morph";

import { TENANT_SCOPED_TABLES } from "./_registry.js";

const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z_0-9.]*)/gi;
const MARKER_RE = /tenant:exempt\s+reason=\S+\s+follow_up=\S+/;
const INSTALLATION_ID_RE = /installation_id/i;
const PRIVILEGED_PATH_RE = /(?:^|\.)privileged_?path/i;

export interface Violation {
  file: string;
  line: number;
  table: string;
}

export function findTenancyViolations(project: Project): Violation[] {
  const out: Violation[] = [];
  for (const sf of project.getSourceFiles()) {
    const lines = sf.getFullText().split("\n");
    for (const tpl of sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
      if (!/^sql\b|^sql$/.test(tpl.getTag().getText())) continue;
      const text = tpl.getText();
      let m: RegExpExecArray | null;
      TABLE_RE.lastIndex = 0;
      while ((m = TABLE_RE.exec(text)) !== null) {
        const table = m[1]!.toLowerCase();
        if (!TENANT_SCOPED_TABLES.has(table)) continue;
        if (INSTALLATION_ID_RE.test(text)) continue;
        if (hasPrivilegedPath(tpl)) continue;
        if (hasExemptMarker(tpl, lines)) continue;
        out.push({ file: sf.getFilePath(), line: tpl.getStartLineNumber(), table });
      }
    }
  }
  return out;
}

function hasPrivilegedPath(node: import("ts-morph").Node): boolean {
  const method = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  const decorators = [...(method?.getDecorators() ?? []), ...(cls?.getDecorators() ?? [])];
  return decorators.some((d) => PRIVILEGED_PATH_RE.test(d.getExpression().getText()));
}

function hasExemptMarker(node: import("ts-morph").Node, lines: string[]): boolean {
  const ln = node.getStartLineNumber(); // 1-based
  const sameLine = lines[ln - 1] ?? "";
  const prevLine = lines[ln - 2] ?? "";
  return MARKER_RE.test(sameLine) || MARKER_RE.test(prevLine);
}

/** CLI entry: emit H-16-format WARN lines; always exit 0 (WARN-mode v1). */
export function main(): number {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  const violations = findTenancyViolations(project);
  for (const v of violations) {
    process.stderr.write(
      `[WARN] file=${v.file}:${v.line} rule=tenant.raw_sql.unfiltered ` +
        `message="tenant-scoped table ${v.table} referenced in raw SQL without an installation_id filter" ` +
        `suggestion="add WHERE installation_id = \${iid}, @privileged_path, or a // tenant:exempt marker"\n`,
    );
  }
  process.stderr.write(
    `[INFO] tenant-scoped raw-SQL gate (WARN-mode): ${violations.length} finding(s). Exit 0.\n`,
  );
  return 0; // WARN-mode: never block (matches the frozen Python gate's v1 behavior)
}
