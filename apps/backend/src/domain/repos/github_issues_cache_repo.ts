/**
 * PostgresGithubIssuesCacheRepo — 1:1 TS port of the frozen Python
 * `vendor/codemaster-py/codemaster/domain/repos/github_issues_cache_repo.py`
 * (`PostgresGithubIssuesCacheRepo`, DM-WIRE T4 / S22.DM.16).
 *
 * Async repo over `core.github_issues_cache`. Two operations, ported method-for-method:
 *
 *   - {@link PostgresGithubIssuesCacheRepo.getMany} — bulk SELECT of cache entries for a set of
 *     `(installation_id, github_issue_number)` pairs. Returns a Map keyed by issue number. Missing
 *     entries are simply absent from the Map; the caller's `fetchLinkedIssues` activity then attempts
 *     a single ETag-aware GitHub fetch per miss (or per stale entry). Empty `issueNumbers` returns an
 *     empty Map without touching the DB.
 *   - {@link PostgresGithubIssuesCacheRepo.upsert} — INSERT ON CONFLICT DO UPDATE on
 *     `(installation_id, github_issue_number)`. Refreshes `cached_at` (from the injected clock) +
 *     `etag` on every write so the activity's TTL boundary slides forward when GitHub returns a fresh
 *     body. The title is sliced to 500 chars (the column's `varchar(500)` bound + the Python
 *     `title[:500]` slice).
 *
 * Tenancy (CLAUDE.md invariant #10 / "default deny everywhere"): the `getMany` SELECT filters
 * `WHERE installation_id = ...`; the `upsert` INSERT carries `installation_id` as an explicit column
 * value (no WHERE to scope). 1:1 with the frozen Python `text()` SQL.
 *
 * ADR-0062: this repo NO LONGER owns a `pg.Pool` or constructs a `new Kysely(...)`. It is handed a
 * `Kysely<GithubIssuesCacheDb>` over the process-wide single pool from {@link tenantKysely}
 * (`#platform/db/database.js`). {@link PostgresGithubIssuesCacheRepo.fromDsn} is the default entry
 * point; it routes through {@link tenantKysely} so every repo over the same DSN shares ONE pool. Pool
 * teardown is the shared `disposeAllPools` / `disposePool` seam, NOT a per-repo close.
 *
 * Schema (confirmed live against the disposable PG, `\d core.github_issues_cache`):
 *   github_issue_cache_id uuid          PK, default gen_random_uuid()
 *   installation_id       uuid          NOT NULL
 *   repository_id         uuid          NOT NULL
 *   github_issue_number   bigint        NOT NULL, CHECK >= 1
 *   title                 varchar(500)  NOT NULL
 *   body                  text          NULL
 *   state                 text          NOT NULL, CHECK in ('open','closed')
 *   etag                  varchar(64)   NULL
 *   cached_at             timestamptz   NOT NULL, default now()
 *   UNIQUE (installation_id, github_issue_number)
 */

import { type Kysely, sql } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

import type { Clock } from "#platform/clock.js";

/**
 * The in-process row shape {@link PostgresGithubIssuesCacheRepo.getMany} returns. Mirrors the fields
 * of the Python `GithubIssueV1` envelope the activity reads — but `cached_at` is a `Date` (NOT the
 * wire string) because the consuming `fetchLinkedIssues` activity does age math on it
 * (`now - entry.cached_at`), exactly as the Python activity reads `entry.cached_at` as a `datetime`.
 */
export type CachedIssueRow = {
  readonly github_issue_number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly etag: string | null;
  readonly cached_at: Date;
};

/** Minimal Kysely table typing for `core.github_issues_cache` (the only table this repo touches). */
type GithubIssuesCacheTable = {
  github_issue_cache_id: string;
  installation_id: string;
  repository_id: string;
  github_issue_number: number;
  title: string;
  body: string | null;
  state: string;
  etag: string | null;
  cached_at: Date;
};

type GithubIssuesCacheDb = {
  "core.github_issues_cache": GithubIssuesCacheTable;
};

/**
 * The repo Port consumed by `fetchLinkedIssues` (1:1 with the Python `GithubIssuesCacheRepoPort`).
 * The activity depends on this narrow surface, not the concrete class.
 */
export type GithubIssuesCacheRepoPort = {
  getMany(args: {
    installationId: string;
    issueNumbers: ReadonlyArray<number>;
  }): Promise<Map<number, CachedIssueRow>>;

  upsert(args: {
    installationId: string;
    repositoryId: string;
    githubIssueNumber: number;
    title: string;
    body: string | null;
    state: string;
    etag: string | null;
  }): Promise<void>;
};

/** Implements {@link GithubIssuesCacheRepoPort} against `core.github_issues_cache`. */
export class PostgresGithubIssuesCacheRepo implements GithubIssuesCacheRepoPort {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<GithubIssuesCacheDb>;
  readonly #clock: Clock;

  /**
   * Construct from an injected `Kysely<GithubIssuesCacheDb>` — the tenant-scoped, shared-pool instance
   * from {@link tenantKysely} — plus the injected clock. The TenancyPlugin is already installed by
   * {@link tenantKysely}; do NOT re-install it here.
   */
  public constructor(args: { db: Kysely<GithubIssuesCacheDb>; clock: Clock }) {
    this.#db = args.db;
    this.#clock = args.clock;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  public static fromDsn(args: { dsn: string; clock: Clock }): PostgresGithubIssuesCacheRepo {
    return new PostgresGithubIssuesCacheRepo({
      db: tenantKysely<GithubIssuesCacheDb>(args.dsn),
      clock: args.clock,
    });
  }

  /**
   * Bulk SELECT for the activity's resolver-dict build path, 1:1 with the Python `get_many`.
   *
   * Returns a Map keyed by `github_issue_number`. Missing entries are absent from the Map; the
   * activity then attempts a single ETag-aware fetch per miss (or per stale entry). Empty
   * `issueNumbers` returns an empty Map without touching the DB.
   */
  public async getMany(args: {
    installationId: string;
    issueNumbers: ReadonlyArray<number>;
  }): Promise<Map<number, CachedIssueRow>> {
    const { installationId, issueNumbers } = args;
    if (issueNumbers.length === 0) {
      return new Map();
    }

    // Tenancy carried explicitly via `installation_id = ...` (the raw-SQL tenancy AST gate requires
    // the token in the template). `= ANY(...)` binds the issue-number list as a single array param.
    const result = await sql<{
      github_issue_number: string | number;
      title: string;
      body: string | null;
      state: string;
      etag: string | null;
      cached_at: Date;
    }>`
      SELECT github_issue_number, title, body, state, etag, cached_at
      FROM core.github_issues_cache
      WHERE installation_id = ${installationId}
        AND github_issue_number = ANY(${sql`${[...issueNumbers]}`}::bigint[])
    `.execute(this.#db);

    const out = new Map<number, CachedIssueRow>();
    for (const row of result.rows) {
      // bigint columns come back as a string from node-postgres; coerce to number (issue numbers are
      // well under 2^53 — the contract bounds them at <= 999_999_999).
      const issueNumber = Number(row.github_issue_number);
      out.set(issueNumber, {
        github_issue_number: issueNumber,
        title: row.title,
        body: row.body,
        state: row.state === "open" ? "open" : "closed",
        etag: row.etag,
        cached_at: row.cached_at instanceof Date ? row.cached_at : new Date(row.cached_at),
      });
    }
    return out;
  }

  /**
   * INSERT ON CONFLICT DO UPDATE on `(installation_id, github_issue_number)`, 1:1 with the Python
   * `upsert`. Refreshes `cached_at` via the injected clock so cache TTL semantics are deterministic in
   * tests. The title is sliced to 500 chars (column `varchar(500)` + the Python `title[:500]`).
   */
  public async upsert(args: {
    installationId: string;
    repositoryId: string;
    githubIssueNumber: number;
    title: string;
    body: string | null;
    state: string;
    etag: string | null;
  }): Promise<void> {
    const now = this.#clock.now();
    const title = args.title.slice(0, 500);
    await sql`
      INSERT INTO core.github_issues_cache
        (github_issue_cache_id, installation_id, repository_id,
         github_issue_number, title, body, state, etag, cached_at)
      VALUES
        (gen_random_uuid(), ${args.installationId}, ${args.repositoryId},
         ${args.githubIssueNumber}, ${title}, ${args.body},
         ${args.state}, ${args.etag}, ${now})
      ON CONFLICT (installation_id, github_issue_number) DO UPDATE SET
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        state = EXCLUDED.state,
        etag = EXCLUDED.etag,
        cached_at = EXCLUDED.cached_at
    `.execute(this.#db);
  }
}
