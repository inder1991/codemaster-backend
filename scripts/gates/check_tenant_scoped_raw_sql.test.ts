import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";

import { findTenancyViolations } from "./check_tenant_scoped_raw_sql.js";

// Build an in-memory TS project from a snippet and run the gate over it.
// Mirrors the frozen Python gate's tests (test_check_tenant_scoped_raw_sql.py) but for Kysely's
// raw `sql\`...\`` tagged templates (the TS equivalent of SQLAlchemy `session.execute(text(...))`).
function violations(code: string) {
  const p = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { experimentalDecorators: true },
  });
  p.createSourceFile("x.ts", code);
  return findTenancyViolations(p);
}

describe("tenant-scoped raw-SQL gate", () => {
  it("passes a tenant-scoped SELECT that filters on installation_id", () => {
    expect(
      violations("const r = await db.executeQuery(sql`SELECT id FROM core.repositories WHERE installation_id = ${iid}`);"),
    ).toHaveLength(0);
  });

  it("WARNs on an unfiltered SELECT against a tenant-scoped table", () => {
    const v = violations("const r = await db.executeQuery(sql`SELECT id FROM core.repositories WHERE run_id = ${rid}`);");
    expect(v).toHaveLength(1);
    expect(v[0]!.table).toBe("core.repositories");
  });

  it("exempts a method carrying @privileged_path", () => {
    expect(
      violations(`
        class RepoScan {
          @privileged_path
          async all() {
            return await db.executeQuery(sql\`SELECT id FROM core.repositories WHERE run_id = \${rid}\`);
          }
        }`),
    ).toHaveLength(0);
  });

  it("exempts a site with an inline // tenant:exempt reason=... follow_up=... marker", () => {
    expect(
      violations(`
        // tenant:exempt reason=PK-lookup follow_up=BF-9-PHASE-B-caller-updates
        const r = await db.executeQuery(sql\`SELECT id FROM core.review_runs WHERE run_id = \${rid}\`);`),
    ).toHaveLength(0);
  });

  it("ignores a non-tenant-scoped table", () => {
    expect(
      violations("const r = await db.executeQuery(sql`SELECT id FROM partman.part_config WHERE x = ${x}`);"),
    ).toHaveLength(0);
  });

  it("WARNs on an unfiltered UPDATE against a tenant-scoped table", () => {
    const v = violations("await db.executeQuery(sql`UPDATE core.repositories SET name = ${n} WHERE id = ${x}`);");
    expect(v).toHaveLength(1);
    expect(v[0]!.table).toBe("core.repositories");
  });

  it("WARNs on an unfiltered JOIN against a tenant-scoped table", () => {
    const v = violations(
      "await db.executeQuery(sql`SELECT * FROM partman.part_config p JOIN core.review_findings f ON f.x = p.y`);",
    );
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.some((x) => x.table === "core.review_findings")).toBe(true);
  });

  it("ignores non-sql tagged templates (only raw SQL is gated)", () => {
    expect(violations("const t = html`<div>FROM core.repositories</div>`;")).toHaveLength(0);
  });
});
