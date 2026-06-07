import { AsyncLocalStorage } from "node:async_hooks";

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RootOperationNode,
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  TenancyPlugin,
  TenancyViolation,
  crossTenantAudit,
  enforceTenancyOnNode,
  privilegedPath,
} from "#platform/db/tenancy_plugin.js";

// ── In-memory Kysely (no DB) ───────────────────────────────────────────────────────────────────
// Build queries against the dummy Postgres dialect and inspect their OperationNode AST. `.compile()`
// never touches a connection (DummyDriver), and `.toOperationNode()` hands us the exact node the
// plugin's `transformQuery` would receive. This is a pure query-AST test, per the task contract.

type DB = {
  // Tenant-scoped (present in TENANT_SCOPED_TABLES, NOT legacy-exempt).
  "core.review_runs": {
    run_id: string;
    installation_id: string;
    head_sha: string;
  };
  // Legacy-exempt (installation_id is the PK, not a tenancy FK — in LEGACY_NON_TENANT_SCOPED_EXEMPTIONS).
  "core.installations": {
    installation_id: string;
    org_login: string;
  };
  // NOT in the registry — a non-tenant-scoped table; queries on it are never refused.
  "public.app_meta": {
    id: string;
    value: string;
  };
};

function db(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** Run a built query's AST through the plugin exactly as Kysely would at compile time. */
function runThroughPlugin(node: RootOperationNode): void {
  const plugin = new TenancyPlugin();
  plugin.transformQuery({
    node,
    queryId: { queryId: "test" },
  });
}

const IID = "11111111-1111-1111-1111-111111111111";

describe("TenancyPlugin — tenant-scoped table without installation_id filter is refused", () => {
  it("SELECT without installation_id throws TenancyViolation", () => {
    const node = db().selectFrom("core.review_runs").select("run_id").toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
    expect(() => runThroughPlugin(node)).toThrow(TenancyViolation);
  });

  it("SELECT filtered by an unrelated column (not installation_id) throws", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("head_sha", "=", "deadbeef")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });

  it("UPDATE without installation_id throws", () => {
    const node = db()
      .updateTable("core.review_runs")
      .set({ head_sha: "abc" })
      .where("run_id", "=", "r1")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
    expect(() => runThroughPlugin(node)).toThrow(TenancyViolation);
  });

  it("DELETE without installation_id throws", () => {
    const node = db()
      .deleteFrom("core.review_runs")
      .where("run_id", "=", "r1")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
    expect(() => runThroughPlugin(node)).toThrow(TenancyViolation);
  });
});

describe("TenancyPlugin — installation_id equality filter satisfies the invariant", () => {
  it("SELECT with where(installation_id, =, x) passes", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("installation_id", "=", IID)
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
    expect(() => runThroughPlugin(node)).not.toThrow();
  });

  it("SELECT with installation_id 'in' a tenant set passes", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("installation_id", "in", [IID])
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });

  it("SELECT with installation_id equality AND another predicate passes (nested in AndNode)", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("head_sha", "=", "deadbeef")
      .where("installation_id", "=", IID)
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });

  it("UPDATE with installation_id filter passes", () => {
    const node = db()
      .updateTable("core.review_runs")
      .set({ head_sha: "abc" })
      .where("installation_id", "=", IID)
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });

  it("DELETE with installation_id filter passes", () => {
    const node = db()
      .deleteFrom("core.review_runs")
      .where("installation_id", "=", IID)
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });
});

describe("TenancyPlugin — IS NULL is not a tenant scope", () => {
  it("SELECT with only `installation_id IS NULL` still throws (selects global rows across tenants)", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("installation_id", "is", null)
      .toOperationNode();
    // The Python substring matcher would have accepted this (the column name is present). The
    // AST walk is sharper: IS NULL is not an equality predicate, so it is refused.
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
    expect(() => runThroughPlugin(node)).toThrow(TenancyViolation);
  });

  it("UPDATE with only `installation_id IS NULL` still throws", () => {
    const node = db()
      .updateTable("core.review_runs")
      .set({ head_sha: "abc" })
      .where("installation_id", "is", null)
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });
});

describe("TenancyPlugin — non-scoped tables pass unmodified", () => {
  it("SELECT on a table absent from the registry passes without a tenant filter", () => {
    const node = db().selectFrom("public.app_meta").select("value").toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
    expect(runThroughPlugin(node)).toBeUndefined();
  });

  it("DELETE on a non-scoped table passes", () => {
    const node = db().deleteFrom("public.app_meta").where("id", "=", "x").toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });

  it("legacy-exempt table (core.installations) passes WITHOUT an installation_id equality filter", () => {
    // installation_id is the PK here, looked up directly — no tenancy equality predicate by design.
    const node = db()
      .selectFrom("core.installations")
      .select("org_login")
      .where("org_login", "=", "acme")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });

  it("the plugin returns the node unchanged (refuse, do not rewrite)", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("installation_id", "=", IID)
      .toOperationNode();
    const plugin = new TenancyPlugin();
    const out = plugin.transformQuery({ node, queryId: { queryId: "t" } });
    expect(out).toBe(node);
  });
});

describe("TenancyPlugin — cross-tenant-audit escape", () => {
  it("crossTenantAudit inside privilegedPath allows an unfiltered tenant-scoped SELECT", async () => {
    const node = db().selectFrom("core.review_runs").select("run_id").toOperationNode();
    await privilegedPath(async () => {
      await crossTenantAudit("operator audit scan", () => {
        expect(() => enforceTenancyOnNode(node)).not.toThrow();
        expect(runThroughPlugin(node)).toBeUndefined();
      });
    })();
  });

  it("the escape is scoped: after crossTenantAudit exits, enforcement is restored", async () => {
    const node = db().selectFrom("core.review_runs").select("run_id").toOperationNode();
    await privilegedPath(async () => {
      await crossTenantAudit("scan", () => {
        expect(() => enforceTenancyOnNode(node)).not.toThrow();
      });
      // Still inside privilegedPath, but the audit frame has closed → enforcement is back.
      expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
    })();
  });

  it("crossTenantAudit OUTSIDE a privileged frame throws TenancyViolation (refusal-outside-privileged)", async () => {
    await expect(
      crossTenantAudit("no privilege here", () => undefined),
    ).rejects.toThrow(TenancyViolation);
  });

  it("crossTenantAudit in a sibling async context (no privileged frame) throws", async () => {
    // A bare AsyncLocalStorage frame elsewhere must not leak privilege into this call.
    const unrelated = new AsyncLocalStorage<number>();
    await unrelated.run(7, async () => {
      await expect(crossTenantAudit("still no privilege", () => undefined)).rejects.toThrow(
        TenancyViolation,
      );
    });
  });
});

// ── #8 deep-AST hardening: OR-defeat + nested query bodies (CTE / subquery / union / DELETE USING) ──
// Previously these passed UN-scoped (the walker only looked at the top-level FROM + a coarse shared
// WHERE, and accepted an `installation_id =` found ANYWHERE incl. inside an OR). Now each is refused.
describe("TenancyPlugin — OR-defeated tenant scope is refused", () => {
  it("SELECT `installation_id = :x OR head_sha = :y` throws (the OR sibling matches across tenants)", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where((eb) => eb.or([eb("installation_id", "=", IID), eb("head_sha", "=", "abc")]))
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });

  it("SELECT `installation_id = :x AND (a OR b)` PASSES (the tenant filter is a top-level conjunct)", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("installation_id", "=", IID)
      .where((eb) => eb.or([eb("head_sha", "=", "a"), eb("head_sha", "=", "b")]))
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });
});

describe("TenancyPlugin — nested query bodies are descended into", () => {
  it("CTE whose body selects a scoped table WITHOUT a filter throws", () => {
    const node = db()
      .with("t", (d) => d.selectFrom("core.review_runs").select("run_id"))
      .selectFrom("t")
      .select("run_id")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });

  it("CTE whose body filters the scoped table PASSES", () => {
    const node = db()
      .with("t", (d) =>
        d.selectFrom("core.review_runs").select("run_id").where("installation_id", "=", IID),
      )
      .selectFrom("t")
      .select("run_id")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).not.toThrow();
  });

  it("FROM-subquery (derived table) on a scoped table WITHOUT a filter throws", () => {
    const node = db()
      .selectFrom((eb) => eb.selectFrom("core.review_runs").select("run_id").as("sub"))
      .select("sub.run_id")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });

  it("WHERE-IN subselect on a scoped table WITHOUT a filter throws (even from a non-scoped outer table)", () => {
    const node = db()
      .selectFrom("public.app_meta")
      .select("id")
      .where("id", "in", (eb) => eb.selectFrom("core.review_runs").select("run_id"))
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });

  it("UNION branch on a scoped table WITHOUT a filter throws (even when the first branch IS scoped)", () => {
    const node = db()
      .selectFrom("core.review_runs")
      .select("run_id")
      .where("installation_id", "=", IID)
      .union(db().selectFrom("core.review_runs").select("run_id"))
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });

  it("DELETE … USING a scoped table WITHOUT a filter throws", () => {
    const node = db()
      .deleteFrom("public.app_meta")
      .using("core.review_runs")
      .whereRef("public.app_meta.id", "=", "core.review_runs.run_id")
      .toOperationNode();
    expect(() => enforceTenancyOnNode(node)).toThrow(TenancyViolation);
  });
});
