/**
 * Tenancy isolation plugin — refuses cross-tenant data access by default (invariant #10,
 * "default deny everywhere").
 *
 * This is a BEHAVIORAL port of the frozen SQLAlchemy hook
 * `vendor/codemaster-py/codemaster/security/tenancy.py` onto Kysely (0.27.x). It is NOT a
 * byte-for-byte port — SQLAlchemy fires a `do_orm_execute` event over compiled `Select`/`Update`/
 * `Delete` statements; Kysely exposes a {@link KyselyPlugin} seam whose `transformQuery` receives the
 * query's {@link OperationNode} AST before it is compiled. We hook there.
 *
 * The invariant is identical to the Python hook:
 *
 *   > Any SELECT / UPDATE / DELETE on a table carrying `installation_id` MUST filter on it (with a
 *   > real equality predicate), or carry a cross-tenant-audit marker — and that marker is only
 *   > available inside a `@privileged_path`-decorated frame.
 *
 * Two semantics carry over from the Python source that future readers must preserve:
 *
 *  1. **The `IS NULL` vs `= :x` distinction (sharpened, not copied).** The Python hook is an honest
 *     substring matcher on the compiled WHERE string and explicitly does NOT distinguish
 *     `installation_id = :x` from `installation_id IS NULL` (see the module docstring in
 *     tenancy.py — both contain the substring `"installation_id"`, so both are accepted; it prefers
 *     false-positive/refuse over false-negative/leak). Because we walk the AST instead of a string,
 *     we can be *more* precise without being *less* safe: we require an actual equality-class
 *     predicate (`=`, `==`, `in`) whose left operand references the tenant column. A bare
 *     `installation_id IS NULL` is NOT a tenant scope (it selects the global/un-scoped rows across
 *     all tenants), so it does NOT satisfy the filter requirement — it still throws. This closes a
 *     gap the Python heuristic knowingly left open.
 *
 *  2. **The legacy-exemption / nullable-tenant tables.** A few registry tables do not express
 *     tenancy via an `installation_id` equality predicate (the column is the PK, is NULLABLE with
 *     NULL = a platform-shared row, or is superseded by a `scope` discriminator). Those are listed
 *     in {@link LEGACY_NON_TENANT_SCOPED_EXEMPTIONS} and the plugin skips the hard filter
 *     requirement for them — mirroring the Python `LEGACY_NON_TENANT_SCOPED_EXEMPTIONS` register.
 *
 * The cross-tenant-audit escape (the analogue of SQLAlchemy's `session.info["cross_tenant_audit"]`)
 * is request-scoped via {@link AsyncLocalStorage} rather than session state, since Kysely has no
 * per-session `info` bag. {@link crossTenantAudit} refuses to activate outside a
 * {@link privilegedPath} frame — exactly as `cross_tenant_audit_session()` raises outside an
 * `@privileged_path` frame in the Python source.
 *
 * Scope (matching the Python hook's scope, by design):
 *  - SELECT / UPDATE / DELETE are gated. INSERT is not (upstream callers pass explicit
 *    `installation_id` values; there is no WHERE clause to scope). Raw `sql\`...\`` tagged templates
 *    bypass the AST walk entirely — that is the PR-time gate `check_tenant_scoped_raw_sql.ts`'s job,
 *    the analogue of the Python `text()` bypass covered by `check_tenant_scoped_raw_sql.py`.
 *
 * DEEP-AST HARDENING (#8) — this walker is now STRICTER than the frozen Python heuristic (a deliberate
 * divergence: going beyond the parity baseline for tenant-isolation safety). It descends into nested
 * query bodies and refuses OR-defeated scopes that the Python `get_final_froms` + coarse substring
 * matcher accepted:
 *   - Nested query bodies ARE descended into and enforced INDEPENDENTLY: CTE (`WITH`) bodies,
 *     FROM-subqueries / derived tables, WHERE-`IN` subselects, `UNION`/set-operation branches, and
 *     `DELETE … USING` tables. A scoped table reached only through one of these must carry its OWN
 *     `installation_id` predicate (we prefer refuse-over-leak on a correlated subquery that relies on
 *     outer scoping — restructure it or wrap it in {@link crossTenantAudit}). See {@link collectQueryNodes}.
 *   - OR-defeated scope is REFUSED: `WHERE installation_id = :x OR other = :y` no longer satisfies the
 *     filter — only a top-level AND-conjunct equality counts (see {@link whereHasTenantEquality}).
 *
 * REMAINING coarseness (by design): per-table JOIN scoping is still shared — a single
 * `installation_id = :x` predicate "covers" a multi-table JOIN, because Kysely column references are
 * frequently unqualified so we cannot reliably attribute a predicate to a SPECIFIC joined table; a JOIN
 * with NO tenant predicate at all is still refused. Raw `sql\`...\`` tagged templates still bypass the
 * AST walk (the PR-time `check_tenant_scoped_raw_sql.ts` gate's job). Primary tenant isolation remains
 * the REPO LAYER passing explicit `installation_id` + code review; this plugin is defense-in-depth.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
} from "kysely";
import {
  type DeleteQueryNode,
  type OperationNode,
  type QueryResult,
  type RootOperationNode,
  type SelectQueryNode,
  type UnknownRow,
  type UpdateQueryNode,
} from "kysely";

import {
  LEGACY_NON_TENANT_SCOPED_EXEMPTIONS,
  TENANT_SCOPED_TABLES,
} from "./tenant_scoped_tables.js";

/** The tenant column every scoped table filters on (the Python `__tenant_column__` default). */
const TENANT_COLUMN = "installation_id";

/**
 * Equality-class operators that count as a real tenant scope. `=`/`==` for the common
 * `where(col, "=", x)`, and `in` for `where(col, "in", [...])` (a per-tenant set membership). `is`
 * / `is not` are deliberately excluded — `installation_id IS NULL` is a global-row selector, not a
 * tenant scope (see the module docstring, point 1).
 */
const TENANT_EQUALITY_OPERATORS: ReadonlySet<string> = new Set(["=", "==", "in"]);

/**
 * Raised when a tenant-scoped query lacks a real `installation_id` equality filter and no
 * cross-tenant-audit frame is active.
 *
 * Catching this in production code is a security smell — fix the query instead of swallowing it.
 */
export class TenancyViolation extends Error {
  readonly tableName: string;
  readonly tenantColumn: string;

  constructor(args: { tableName: string; tenantColumn: string; detail: string }) {
    super(
      `tenancy violation: query on '${args.tableName}' without an equality filter on ` +
        `'${args.tenantColumn}'; ${args.detail}`,
    );
    this.name = "TenancyViolation";
    this.tableName = args.tableName;
    this.tenantColumn = args.tenantColumn;
  }
}

// ── Privileged-path tracking (AsyncLocalStorage analogue of the Python thread-local depth) ──

type PrivilegedFrame = {
  /** Nesting depth of `privilegedPath` wrappers; >0 means a cross-tenant escape may be opened. */
  depth: number;
  /** Whether `crossTenantAudit` is currently active inside this frame (the `info` flag analogue). */
  auditActive: boolean;
};

const PRIVILEGED_STORE = new AsyncLocalStorage<PrivilegedFrame>();

function currentFrame(): PrivilegedFrame | undefined {
  return PRIVILEGED_STORE.getStore();
}

function isAuditActive(): boolean {
  const frame = currentFrame();
  return frame !== undefined && frame.auditActive;
}

/**
 * Marks a call site (and everything it `await`s) as permitted to open a cross-tenant-audit escape.
 *
 * Inside the wrapped function the tenancy plugin still runs; it only relaxes the
 * `installation_id`-filter requirement once {@link crossTenantAudit} is *also* entered. This is the
 * analogue of the Python `@privileged_path` decorator: privilege is necessary but not sufficient —
 * the explicit audit marker must also be set.
 *
 * Nesting re-uses the existing frame and bumps `depth`, so the audit flag set by an inner
 * `crossTenantAudit` is correctly torn down at the inner boundary.
 */
export function privilegedPath<A extends ReadonlyArray<unknown>, R>(
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const existing = currentFrame();
    if (existing !== undefined) {
      existing.depth += 1;
      try {
        return await fn(...args);
      } finally {
        existing.depth -= 1;
      }
    }
    return PRIVILEGED_STORE.run({ depth: 1, auditActive: false }, async () => fn(...args));
  };
}

/**
 * Opens a cross-tenant-audit escape for the duration of `fn`, allowing tenant-scoped queries to run
 * WITHOUT an `installation_id` filter (operator inspection, audit scans, aggregate roll-ups).
 *
 * Refuses to activate outside a {@link privilegedPath} frame — the analogue of the Python
 * `cross_tenant_audit_session()` raising `TenancyViolation` when called outside `@privileged_path`.
 * `reason` is required so security review can see why the escape was taken (mirrors the Python
 * `reason=` kwarg recorded in `session.info`).
 *
 * The flag is restored to its prior value on exit (supporting nested escapes), exactly as the
 * Python context manager resets `session.info["cross_tenant_audit"]` in its `finally`.
 */
export async function crossTenantAudit<R>(reason: string, fn: () => R | Promise<R>): Promise<R> {
  const frame = currentFrame();
  if (frame === undefined || frame.depth <= 0) {
    throw new TenancyViolation({
      tableName: "<any>",
      tenantColumn: "<any>",
      detail: `crossTenantAudit called outside privilegedPath; reason=${JSON.stringify(reason)}`,
    });
  }
  const prior = frame.auditActive;
  frame.auditActive = true;
  try {
    return await fn();
  } finally {
    frame.auditActive = prior;
  }
}

// ── AST walking ──

/** Narrow a node by its `kind` discriminator without an `as` cast. */
function hasKind<K extends string>(
  node: OperationNode,
  kind: K,
): node is OperationNode & { readonly kind: K } {
  return node.kind === kind;
}

/**
 * Schema-qualify a TableNode's identifier into the `schema.table` form the registry uses. The
 * registry keys are all schema-qualified (e.g. `core.review_runs`); a bare table without a schema
 * cannot match a registry key, which is the safe default (we only enforce on known scoped tables).
 */
function tableNodeToName(node: OperationNode): string | undefined {
  if (!hasKind(node, "TableNode")) {
    return undefined;
  }
  // TableNode.table is a SchemableIdentifierNode { schema?: IdentifierNode; identifier: IdentifierNode }.
  const table = (node as { table?: OperationNode }).table;
  if (table === undefined || !hasKind(table, "SchemableIdentifierNode")) {
    return undefined;
  }
  const schemable = table as {
    schema?: { name?: string };
    identifier?: { name?: string };
  };
  const identifier = schemable.identifier?.name;
  if (identifier === undefined) {
    return undefined;
  }
  const schema = schemable.schema?.name;
  return schema === undefined ? identifier : `${schema}.${identifier}`;
}

/** Unwrap an AliasNode to its underlying node (`from(x.as("y"))` / `update(...).from(...)`). */
function unwrapAlias(node: OperationNode): OperationNode {
  if (hasKind(node, "AliasNode")) {
    const inner = (node as { node?: OperationNode }).node;
    if (inner !== undefined) {
      return unwrapAlias(inner);
    }
  }
  return node;
}

/** Collect the schema-qualified names of every target table referenced by a query's FROM/INTO/UPDATE. */
function collectTargetTables(node: SelectQueryNode | UpdateQueryNode | DeleteQueryNode): Array<string> {
  const names: Array<string> = [];
  const add = (candidate: OperationNode | undefined): void => {
    if (candidate === undefined) {
      return;
    }
    const name = tableNodeToName(unwrapAlias(candidate));
    if (name !== undefined) {
      names.push(name);
    }
  };

  if (hasKind(node, "SelectQueryNode") || hasKind(node, "DeleteQueryNode")) {
    const from = (node as { from?: { froms?: ReadonlyArray<OperationNode> } }).from;
    for (const f of from?.froms ?? []) {
      add(f);
    }
    // JOINed tenant-scoped tables must also be filtered — a JOIN without a tenant predicate leaks.
    const joins = (node as { joins?: ReadonlyArray<{ table?: OperationNode }> }).joins;
    for (const join of joins ?? []) {
      add(join.table);
    }
  }

  if (hasKind(node, "DeleteQueryNode")) {
    // DELETE … USING <table> — the USING tables are additional FROM-like references; a scoped table
    // joined in via USING (correlated by whereRef) must carry a tenant predicate too (#8).
    const using = (node as { using?: { tables?: ReadonlyArray<OperationNode> } }).using;
    for (const t of using?.tables ?? []) {
      add(t);
    }
  }

  if (hasKind(node, "UpdateQueryNode")) {
    add((node as { table?: OperationNode }).table);
    const from = (node as { from?: { froms?: ReadonlyArray<OperationNode> } }).from;
    for (const f of from?.froms ?? []) {
      add(f);
    }
  }

  return names;
}

/** True if `node` is a Reference/ColumnNode resolving to the given column name. */
function referencesColumn(node: OperationNode, column: string): boolean {
  let target: OperationNode = node;
  if (hasKind(target, "ReferenceNode")) {
    const col = (target as { column?: OperationNode }).column;
    if (col === undefined) {
      return false;
    }
    target = col;
  }
  if (hasKind(target, "ColumnNode")) {
    const identifier = (target as { column?: { name?: string } }).column;
    return identifier?.name === column;
  }
  return false;
}

/**
 * Walk a WHERE subtree looking for a real equality-class predicate (`=`/`==`/`in`) whose left operand
 * references `column` AND is reachable from the root as a top-level CONJUNCT (through AND/Parens only).
 * Returns true the moment one is found.
 *
 * Two semantics future readers must preserve:
 *  - A `BinaryOperationNode` with `is`/`is not` (i.e. `installation_id IS NULL`) does NOT count — the
 *    IS-NULL-vs-equality distinction the Python substring matcher could not make.
 *  - An equality buried inside an `OR` branch does NOT count (#8). `installation_id = :x OR other = :y`
 *    looks scoped but the OR sibling matches rows across tenants — so an `OrNode` never contributes a
 *    real scope. Only AND-connected conjuncts (and Parens around them) scope the whole statement. A
 *    `BinaryOperationNode` is therefore treated as a LEAF here (we do not descend into its operands —
 *    a tenant column appearing as a comparison operand is not a top-level conjunct).
 */
function whereHasTenantEquality(node: OperationNode | undefined, column: string): boolean {
  if (node === undefined) {
    return false;
  }

  if (hasKind(node, "BinaryOperationNode")) {
    const bin = node as {
      leftOperand?: OperationNode;
      operator?: OperationNode;
    };
    const operator = bin.operator;
    const operatorName =
      operator !== undefined && hasKind(operator, "OperatorNode")
        ? (operator as { operator?: string }).operator
        : undefined;
    return (
      operatorName !== undefined &&
      TENANT_EQUALITY_OPERATORS.has(operatorName) &&
      bin.leftOperand !== undefined &&
      referencesColumn(bin.leftOperand, column)
    );
  }

  if (hasKind(node, "AndNode")) {
    // AND: a tenant equality in EITHER conjunct scopes the whole statement.
    const branch = node as { left?: OperationNode; right?: OperationNode };
    return (
      whereHasTenantEquality(branch.left, column) || whereHasTenantEquality(branch.right, column)
    );
  }

  if (hasKind(node, "OrNode")) {
    // OR: a tenant equality in one branch is DEFEATED by the sibling branch (which can match other
    // tenants), so an OR node never contributes a real tenant scope (#8 — closes the OR-defeat bypass).
    return false;
  }

  if (hasKind(node, "ParensNode")) {
    return whereHasTenantEquality((node as { node?: OperationNode }).node, column);
  }

  return false;
}

/** The WHERE predicate of a SELECT/UPDATE/DELETE, if any. */
function whereOf(
  node: SelectQueryNode | UpdateQueryNode | DeleteQueryNode,
): OperationNode | undefined {
  const where = (node as { where?: { where?: OperationNode } }).where;
  return where?.where;
}

/**
 * Collect EVERY SELECT/UPDATE/DELETE query node reachable from `root` — the root itself plus every
 * nested query body (#8): CTE bodies (`WITH`), FROM-subqueries / derived tables, WHERE-`IN` subselects,
 * `UNION`/set-operation branches, and `DELETE … USING` subqueries. A generic AST visit (every object
 * property + array element) so the descent is robust to the exact parent node shape — any node whose
 * `kind` is a query kind is collected and enforced INDEPENDENTLY (a nested scoped-table query must
 * carry its OWN tenant predicate; we prefer refuse-over-leak on a correlated subquery that relies on
 * outer scoping). The `seen` set guards against any accidental cycle in the node graph.
 */
function collectQueryNodes(root: OperationNode): Array<SelectQueryNode | UpdateQueryNode | DeleteQueryNode> {
  const acc: Array<SelectQueryNode | UpdateQueryNode | DeleteQueryNode> = [];
  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (n === null || typeof n !== "object" || seen.has(n)) {
      return;
    }
    seen.add(n);
    if (Array.isArray(n)) {
      for (const item of n) {
        visit(item);
      }
      return;
    }
    const node = n as OperationNode;
    if (
      hasKind(node, "SelectQueryNode") ||
      hasKind(node, "UpdateQueryNode") ||
      hasKind(node, "DeleteQueryNode")
    ) {
      acc.push(node as SelectQueryNode | UpdateQueryNode | DeleteQueryNode);
    }
    for (const key of Object.keys(n as Record<string, unknown>)) {
      visit((n as Record<string, unknown>)[key]);
    }
  };
  visit(root);
  return acc;
}

/**
 * Enforce tenancy on ONE query node: throw {@link TenancyViolation} on the first tenant-scoped target
 * table whose WHERE clause lacks a real `installation_id` equality filter (unless the table is
 * legacy-exempt). The audit-active short-circuit is handled by the caller.
 */
function enforceOneQueryNode(node: SelectQueryNode | UpdateQueryNode | DeleteQueryNode): void {
  const targets = collectTargetTables(node);
  if (targets.length === 0) {
    return;
  }
  const where = whereOf(node);
  for (const tableName of targets) {
    if (!TENANT_SCOPED_TABLES.has(tableName)) {
      continue;
    }
    if (LEGACY_NON_TENANT_SCOPED_EXEMPTIONS.has(tableName)) {
      // Tenancy for these is the PK / a NULLABLE column / a `scope` discriminator — not an
      // installation_id equality predicate. Mirrors the Python LEGACY_NON_TENANT_SCOPED_EXEMPTIONS.
      continue;
    }
    if (!whereHasTenantEquality(where, TENANT_COLUMN)) {
      throw new TenancyViolation({
        tableName,
        tenantColumn: TENANT_COLUMN,
        detail: `${node.kind} has no '${TENANT_COLUMN} = :x' (or 'in') predicate`,
      });
    }
  }
}

/**
 * Enforce tenancy on a query AST. Throws {@link TenancyViolation} on the first tenant-scoped target
 * table — at ANY nesting level (#8) — whose WHERE lacks a real `installation_id` equality filter, unless
 * a cross-tenant-audit frame is active or the table is legacy-exempt.
 *
 * Exported for direct unit testing (no DB / no Kysely executor needed — pass a compiled query's
 * `.query` node, or any `RootOperationNode`).
 */
export function enforceTenancyOnNode(node: RootOperationNode): void {
  if (isAuditActive()) {
    return; // explicitly privileged (covers SELECT + UPDATE + DELETE, at every nesting level)
  }
  // INSERT / DDL / raw roots have no query node here → collectQueryNodes returns [] → no-op, same as the
  // Python hook's scope. A SELECT/UPDATE/DELETE root (and every nested query body) is enforced.
  for (const queryNode of collectQueryNodes(node)) {
    enforceOneQueryNode(queryNode);
  }
}

/**
 * Kysely plugin enforcing tenant isolation at query-build time. Register it on the `Kysely`
 * instance the application uses for tenant-scoped traffic:
 *
 *   new Kysely<DB>({ dialect, plugins: [new TenancyPlugin()] })
 *
 * `transformQuery` runs the enforcement and returns the node unchanged (we refuse, we don't
 * rewrite). `transformResult` is a pass-through — there is no result-shape concern here.
 */
export class TenancyPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    enforceTenancyOnNode(args.node);
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
