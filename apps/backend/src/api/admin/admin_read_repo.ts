// Admin read repo — net-new TS SELECTs for the admin READ endpoints (the Python orchestrating
// Postgres*Repo classes are not ported; these are the straight queries those endpoints actually run).
// Batch 1: listOrgs.

import { type Kysely, sql } from "kysely";

import type {
  FindingRowV1,
  PullRequestRowV1,
  ReviewListItemV1,
  TaxonomyGapEntryV1,
} from "#contracts/admin.v1.js";

import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/infra/sentinels.js";

/**
 * Distinct GitHub orgs (core.installations.account_login) visible to the session, ordered. 1:1 with
 * postgres_reviews_repo.list_orgs: super_admin / platform view (installation_id == the platform-view
 * sentinel) sees ALL orgs; a tenant-scoped session sees only its own installation's org.
 */
export async function listOrgs(db: Kysely<unknown>, installationId: string): Promise<Array<string>> {
  const r = await sql<{ org: string }>`
    SELECT DISTINCT inst.account_login AS org
    FROM core.installations inst
    JOIN core.repositories r ON r.installation_id = inst.installation_id
    WHERE (${installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR inst.installation_id = ${installationId})
    ORDER BY org
  `.execute(db);
  return r.rows.map((row) => row.org);
}

// UI review state → the SQL lifecycle_state vocabulary it maps onto (1:1 with _UI_STATE_TO_SQL).
const UI_STATE_TO_SQL = new Map<string, Array<string>>([
  ["queued", ["PENDING"]],
  ["in_progress", ["RUNNING", "WAITING_RETRY"]],
  ["complete", ["COMPLETED", "PARTIAL"]],
  ["failed", ["FAILED", "CANCELLED"]],
]);

export type SearchReviewsArgs = {
  installationId: string;
  repo?: string | null;
  q?: string | null;
  state?: string | null; // a UI state (queued/in_progress/complete/failed)
  org?: string | null;
  page: number;
  size: number;
};

type ReviewSearchRow = {
  review_id: string;
  repo: string;
  pr_number: number;
  pr_title: string;
  state: "queued" | "in_progress" | "complete" | "failed";
  severity_max: "nit" | "suggestion" | "issue" | "blocker" | null;
  finding_count: string | number;
  started_at: Date;
  completed_at: Date | null;
  total_count: string | number;
};

/**
 * Page/size-paginated reviews list — 1:1 with postgres_reviews_repo.search. A CTE aggregates per-PR
 * finding_count + max-severity (non-suppressed), the main query maps lifecycle_state → the UI state
 * vocabulary, COALESCEs the title + started_at, and COUNT(*) OVER () yields the total. Honors the
 * platform-view bypass + repo/q/state/org filters. An unknown UI state short-circuits to an empty page.
 */
export async function searchReviews(
  db: Kysely<unknown>,
  args: SearchReviewsArgs,
): Promise<{ items: Array<ReviewListItemV1>; total: number }> {
  let stateIn: Array<string> | null = null;
  if (args.state != null) {
    const mapped = UI_STATE_TO_SQL.get(args.state);
    if (mapped === undefined) {
      return { items: [], total: 0 };
    }
    stateIn = mapped;
  }
  const offset = (args.page - 1) * args.size;
  const repoFilter = args.repo ?? null;
  const qFilter = args.q ?? null;
  const orgFilter = args.org ?? null;
  // Explicit IN-list (binding a JS array to `= ANY(::text[])` doesn't match reliably via the driver).
  const stateClause =
    stateIn === null
      ? sql`TRUE`
      : sql`rr.lifecycle_state IN (${sql.join(
          stateIn.map((s) => sql`${s}`),
          sql`, `,
        )})`;

  const r = await sql<ReviewSearchRow>`
    WITH counted AS (
      SELECT rf.pr_id, COUNT(*) AS finding_count,
             MAX(CASE rf.severity WHEN 'blocker' THEN 4 WHEN 'issue' THEN 3
                                  WHEN 'suggestion' THEN 2 WHEN 'nit' THEN 1 ELSE 0 END) AS severity_rank
      FROM core.review_findings rf
      WHERE (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
             OR rf.installation_id = ${args.installationId})
        AND rf.suppression_state = 'NONE'
      GROUP BY rf.pr_id
    )
    SELECT
      pr.review_id,
      repo.full_name AS repo,
      pr.pr_number,
      COALESCE(prr.title, 'PR #' || pr.pr_number::text) AS pr_title,
      CASE
        WHEN rr.lifecycle_state IS NULL                        THEN 'queued'
        WHEN rr.lifecycle_state = 'PENDING'                    THEN 'queued'
        WHEN rr.lifecycle_state IN ('RUNNING','WAITING_RETRY') THEN 'in_progress'
        WHEN rr.lifecycle_state IN ('COMPLETED','PARTIAL')     THEN 'complete'
        WHEN rr.lifecycle_state IN ('FAILED','CANCELLED')      THEN 'failed'
        ELSE 'queued'
      END AS state,
      CASE counted.severity_rank WHEN 4 THEN 'blocker' WHEN 3 THEN 'issue'
                                 WHEN 2 THEN 'suggestion' WHEN 1 THEN 'nit' ELSE NULL END AS severity_max,
      COALESCE(counted.finding_count, 0) AS finding_count,
      COALESCE(rr.started_at, pr.created_at) AS started_at,
      rr.completed_at,
      COUNT(*) OVER () AS total_count
    FROM core.pull_request_reviews pr
    JOIN core.repositories repo ON repo.github_repo_id = pr.repo_id
    LEFT JOIN core.installations inst ON inst.installation_id = repo.installation_id
    LEFT JOIN core.pull_requests prr ON prr.repository_id = repo.repository_id AND prr.pr_number = pr.pr_number
    LEFT JOIN core.review_runs rr ON rr.run_id = pr.current_run_id
    LEFT JOIN counted ON counted.pr_id = prr.pr_id
    WHERE (${args.installationId} = CAST(${SUPER_ADMIN_PLATFORM_VIEW_UUID} AS uuid)
           OR repo.installation_id = ${args.installationId})
      AND (CAST(${repoFilter} AS text) IS NULL OR repo.full_name ILIKE '%' || CAST(${repoFilter} AS text) || '%')
      AND (${stateClause})
      AND (CAST(${qFilter} AS text) IS NULL OR prr.title ILIKE '%' || CAST(${qFilter} AS text) || '%')
      AND (CAST(${orgFilter} AS text) IS NULL OR inst.account_login = ${orgFilter})
    ORDER BY pr.created_at DESC, pr.review_id DESC
    LIMIT ${args.size} OFFSET ${offset}
  `.execute(db);

  const items = r.rows.map((row) => ({
    review_id: row.review_id,
    repo: row.repo,
    pr_number: row.pr_number,
    pr_title: row.pr_title,
    state: row.state,
    severity_max: row.severity_max,
    finding_count: Number(row.finding_count),
    started_at: new Date(row.started_at).toISOString(),
    completed_at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  }));
  const total = r.rows.length > 0 ? Number(r.rows[0]!.total_count) : 0;
  return { items, total };
}

type TaxonomyGapRow = {
  label: string;
  chunks_carrying: string | number;
  pages_carrying: string | number;
  spaces_carrying: string | number;
  most_recent_use: Date;
};

/**
 * Top-N unrecognized-label entries from core.v_taxonomy_gaps, ordered by chunks_carrying DESC. 1:1 with
 * postgres_taxonomy_repo.top_n. The view's COUNT(*) columns come back as bigint strings — coerced to int.
 */
export async function listTaxonomyGaps(
  db: Kysely<unknown>,
  limit: number,
): Promise<Array<TaxonomyGapEntryV1>> {
  const r = await sql<TaxonomyGapRow>`
    SELECT label, chunks_carrying, pages_carrying, spaces_carrying, most_recent_use
    FROM core.v_taxonomy_gaps
    WHERE label LIKE 'unrecognized:%'
    ORDER BY chunks_carrying DESC
    LIMIT ${limit}
  `.execute(db);
  return r.rows.map((row) => ({
    schema_version: 1 as const,
    label: row.label,
    chunks_carrying: Number(row.chunks_carrying),
    pages_carrying: Number(row.pages_carrying),
    spaces_carrying: Number(row.spaces_carrying),
    most_recent_use: new Date(row.most_recent_use).toISOString(),
  }));
}

export type ListFindingsArgs = {
  installationId: string;
  repositoryId?: string | null;
  severity?: string | null;
  category?: string | null;
  filePathSubstring?: string | null;
  createdAfter?: string | null;
  createdBefore?: string | null;
  cursorCreatedAt?: string | null;
  cursorFindingId?: string | null;
  /** The DB LIMIT — the route passes pageSize + 1 to over-fetch for has-more detection. */
  limit: number;
};

type FindingDbRow = {
  review_finding_id: string;
  installation_id: string;
  pr_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  severity: string;
  category: string;
  title: string;
  body: string;
  suggestion: string | null;
  confidence: string | number;
  github_comment_id: string | number | null;
  posted_review_pr_id: string | null;
  created_at: Date;
};

function mapFindingRow(row: FindingDbRow): FindingRowV1 {
  return {
    review_finding_id: row.review_finding_id,
    installation_id: row.installation_id,
    pr_id: row.pr_id,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    severity: row.severity,
    category: row.category,
    title: row.title,
    body: row.body,
    suggestion: row.suggestion,
    confidence: Number(row.confidence),
    github_comment_id: row.github_comment_id === null ? null : Number(row.github_comment_id),
    posted_review_pr_id: row.posted_review_pr_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Keyset-paginated findings, ordered created_at DESC, review_finding_id ASC. 1:1 with
 * postgres_findings_repo.list_findings: tenancy-filtered on installation_id, optional repository_id JOIN to
 * pull_requests, severity/category/file-substring/date filters, and the (created_at, review_finding_id)
 * keyset cursor. (The mixed DESC/ASC keyset is carried verbatim from the frozen Python.)
 */
export async function listFindings(
  db: Kysely<unknown>,
  args: ListFindingsArgs,
): Promise<Array<FindingRowV1>> {
  const conditions = [sql`rf.installation_id = ${args.installationId}`];
  if (args.severity != null) {
    conditions.push(sql`rf.severity = ${args.severity}`);
  }
  if (args.category != null) {
    conditions.push(sql`rf.category = ${args.category}`);
  }
  if (args.filePathSubstring != null) {
    conditions.push(sql`rf.file_path ILIKE ${"%" + args.filePathSubstring + "%"}`);
  }
  if (args.createdAfter != null) {
    conditions.push(sql`rf.created_at >= ${args.createdAfter}`);
  }
  if (args.createdBefore != null) {
    conditions.push(sql`rf.created_at < ${args.createdBefore}`);
  }
  if (args.cursorCreatedAt != null && args.cursorFindingId != null) {
    conditions.push(
      sql`(rf.created_at, rf.review_finding_id) < (${args.cursorCreatedAt}, ${args.cursorFindingId})`,
    );
  }
  const joinClause =
    args.repositoryId != null
      ? sql`JOIN core.pull_requests pr ON pr.pr_id = rf.pr_id AND pr.repository_id = ${args.repositoryId}`
      : sql``;
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await sql<FindingDbRow>`
    SELECT rf.review_finding_id, rf.installation_id, rf.pr_id, rf.file_path, rf.start_line, rf.end_line,
           rf.severity, rf.category, rf.title, rf.body, rf.suggestion, rf.confidence,
           rf.github_comment_id, rf.posted_review_pr_id, rf.created_at
    FROM core.review_findings rf
    ${joinClause}
    WHERE ${whereClause}
    ORDER BY rf.created_at DESC, rf.review_finding_id ASC
    LIMIT ${args.limit}
  `.execute(db);
  return r.rows.map(mapFindingRow);
}

export type ListPullRequestsArgs = {
  installationId: string;
  repositoryId?: string | null;
  state?: string | null;
  openedAfter?: string | null;
  openedBefore?: string | null;
  cursorOpenedAt?: string | null;
  cursorPrId?: string | null;
  limit: number;
};

type PullRequestDbRow = {
  pr_id: string;
  installation_id: string;
  repository_id: string;
  pr_number: number;
  state: "open" | "closed" | "merged";
  title: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  draft: boolean;
  cross_fork: boolean;
  opened_at: Date;
  closed_at: Date | null;
  merged_at: Date | null;
  created_at: Date;
  updated_at: Date;
  author_gh_user_id: string | null;
};

/**
 * Keyset-paginated pull requests (opened_at DESC, pr_id ASC), tenancy-filtered on installation_id, with
 * optional repository_id/state/date filters + the (opened_at, pr_id) cursor. author_login is resolved per
 * page via ONE batched IN query against core.gh_users (tenant-AGNOSTIC by design — no installation_id
 * column; the author_gh_user_id values are already tenant-scoped at the pull_requests SELECT). 1:1 with
 * postgres_pull_request_repo.list_pull_requests.
 */
export async function listPullRequests(
  db: Kysely<unknown>,
  args: ListPullRequestsArgs,
): Promise<Array<PullRequestRowV1>> {
  const conditions = [sql`installation_id = ${args.installationId}`];
  if (args.repositoryId != null) {
    conditions.push(sql`repository_id = ${args.repositoryId}`);
  }
  if (args.state != null) {
    conditions.push(sql`state = ${args.state}`);
  }
  if (args.openedAfter != null) {
    conditions.push(sql`opened_at >= ${args.openedAfter}`);
  }
  if (args.openedBefore != null) {
    conditions.push(sql`opened_at < ${args.openedBefore}`);
  }
  if (args.cursorOpenedAt != null && args.cursorPrId != null) {
    conditions.push(sql`(opened_at, pr_id) < (${args.cursorOpenedAt}, ${args.cursorPrId})`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  const r = await sql<PullRequestDbRow>`
    SELECT pr_id, installation_id, repository_id, pr_number, state, title, base_ref, head_ref, head_sha,
           draft, cross_fork, opened_at, closed_at, merged_at, created_at, updated_at, author_gh_user_id
    FROM core.pull_requests
    WHERE ${whereClause}
    ORDER BY opened_at DESC, pr_id ASC
    LIMIT ${args.limit}
  `.execute(db);

  // Resolve author_login per page via one batched IN against core.gh_users (tenant-agnostic).
  const authorIds = [
    ...new Set(r.rows.map((row) => row.author_gh_user_id).filter((id): id is string => id != null)),
  ];
  const loginByGhUserId = new Map<string, string>();
  if (authorIds.length > 0) {
    const lr = await sql<{ gh_user_id: string; login: string }>`
      SELECT gh_user_id, login FROM core.gh_users
      WHERE gh_user_id IN (${sql.join(
        authorIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `.execute(db);
    for (const row of lr.rows) {
      loginByGhUserId.set(row.gh_user_id, row.login);
    }
  }

  return r.rows.map((row) => ({
    pr_id: row.pr_id,
    installation_id: row.installation_id,
    repository_id: row.repository_id,
    pr_number: row.pr_number,
    state: row.state,
    title: row.title,
    author_login:
      row.author_gh_user_id === null ? null : (loginByGhUserId.get(row.author_gh_user_id) ?? null),
    base_ref: row.base_ref,
    head_ref: row.head_ref,
    head_sha: row.head_sha.trim(), // char(40) is space-padded; the SHA itself is 40 chars (no-op here)
    draft: row.draft,
    cross_fork: row.cross_fork,
    opened_at: new Date(row.opened_at).toISOString(),
    closed_at: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
    merged_at: row.merged_at === null ? null : new Date(row.merged_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  }));
}
