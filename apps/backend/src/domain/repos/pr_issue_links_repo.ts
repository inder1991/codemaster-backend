/**
 * PostgresLinkedIssuesRepo — 1:1 TS port of the READ slice of the frozen Python
 * `vendor/codemaster-py/codemaster/domain/repos/pr_issue_links_repo.py` consumed by
 * `fetchLinkedIssues` (DM-WIRE T4 / S22.DM.16): the `list_links_for_pr` query wrapped in the
 * session-bound `PostgresLinkedIssuesRepo` class.
 *
 * Single operation:
 *   - {@link PostgresLinkedIssuesRepo.listLinksForPr} — SELECT every link row for one PR, returning the
 *     full `(github_issue_number, linkage_kind, source)` triple per row so the walkthrough assembler has
 *     what it needs without a second DB hop. Tenancy-isolated by `installation_id`; ordered by
 *     `(github_issue_number ASC, source ASC)` so the activity's downstream dedup is deterministic.
 *
 * The producer-side `replace_links` / `derive_pr_issue_link_id` (the webhook-path DELETE-then-INSERT)
 * are NOT consumed by this activity and are deliberately OUT of scope for this port — they belong to the
 * webhook persistence path, ported separately. Only the read slice the consumer needs is ported here
 * (per the task's "port the minimal slice" instruction).
 *
 * ADR-0062: this repo is handed a `Kysely<PrIssueLinksDb>` over the process-wide single pool from
 * {@link tenantKysely}. {@link PostgresLinkedIssuesRepo.fromDsn} is the default entry point. Pool
 * teardown is the shared `disposeAllPools` / `disposePool` seam, NOT a per-repo close.
 *
 * Schema (confirmed live against the disposable PG, `\d core.pr_issue_links`):
 *   pr_issue_link_id    uuid    PK, default gen_random_uuid()
 *   installation_id     uuid    NOT NULL
 *   pr_id               uuid    NOT NULL
 *   github_issue_number bigint  NOT NULL, CHECK >= 1
 *   linkage_kind        text    NOT NULL, CHECK in ('closes','fixes','resolves','mentioned')
 *   source              text    NOT NULL, CHECK in ('description','title','branch_name','commit_message')
 *   created_at          timestamptz NOT NULL, default now()
 *   UNIQUE (pr_id, github_issue_number, linkage_kind, source)
 */

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

import type { IssueLink, LinkageKind, LinkageSource } from "#contracts/issue_link.v1.js";

/** Minimal Kysely table typing for `core.pr_issue_links` (the only table this repo touches). */
type PrIssueLinksTable = {
  pr_issue_link_id: string;
  installation_id: string;
  pr_id: string;
  github_issue_number: number;
  linkage_kind: string;
  source: string;
  created_at: Date;
};

type PrIssueLinksDb = {
  "core.pr_issue_links": PrIssueLinksTable;
};

/**
 * The repo Port consumed by `fetchLinkedIssues` (1:1 with the Python `LinkedIssuesPort`). The activity
 * depends on this narrow surface, not the concrete class.
 */
export type LinkedIssuesPort = {
  listLinksForPr(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<IssueLink>>;
};

/** Implements {@link LinkedIssuesPort} against `core.pr_issue_links`. */
export class PostgresLinkedIssuesRepo implements LinkedIssuesPort {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<PrIssueLinksDb>;

  /**
   * Construct from an injected `Kysely<PrIssueLinksDb>` — the tenant-scoped, shared-pool instance from
   * {@link tenantKysely}. The TenancyPlugin is already installed by {@link tenantKysely}; do NOT
   * re-install it here.
   */
  public constructor(args: { db: Kysely<PrIssueLinksDb> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  public static fromDsn(dsn: string): PostgresLinkedIssuesRepo {
    return new PostgresLinkedIssuesRepo({ db: tenantKysely<PrIssueLinksDb>(dsn) });
  }

  /**
   * SELECT every link row for one PR, 1:1 with the Python `list_links_for_pr`.
   *
   * Returns the full `(github_issue_number, linkage_kind, source)` triple per row so the walkthrough
   * assembler has what it needs without a second DB hop. Tenancy-isolated by `installation_id`. Sort by
   * `(github_issue_number ASC, source ASC)` so the activity's downstream dedup is deterministic.
   */
  public async listLinksForPr(args: {
    installationId: string;
    prId: string;
  }): Promise<ReadonlyArray<IssueLink>> {
    const { installationId, prId } = args;
    const result = await sql<{
      github_issue_number: string | number;
      linkage_kind: string;
      source: string;
    }>`
      SELECT github_issue_number, linkage_kind, source
      FROM core.pr_issue_links
      WHERE installation_id = ${installationId} AND pr_id = ${prId}
      ORDER BY github_issue_number ASC, source ASC
    `.execute(this.#db);

    return result.rows.map((row) => ({
      // bigint comes back as a string from node-postgres; coerce (issue numbers are < 2^53).
      github_issue_number: Number(row.github_issue_number),
      linkage_kind: row.linkage_kind as LinkageKind,
      source: row.source as LinkageSource,
    }));
  }
}
