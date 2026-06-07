import { z } from "zod";

// Zod port of contracts/admin/v1.py — the admin-console read contracts. `.strict()` (Pydantic
// extra="forbid"). Batch 1: orgs filter + dashboard summary.

/** Per-service health row in the dashboard summary (Pydantic __contract_internal__; no schema_version). */
export const ServiceHealthV1 = z
  .object({
    name: z.enum(["api", "workers", "postgres", "bedrock"]),
    state: z.enum(["healthy", "degraded", "down"]),
    detail: z.string().max(200).default(""),
  })
  .strict();
export type ServiceHealthV1 = z.infer<typeof ServiceHealthV1>;

/** GET /api/admin/orgs — the distinct GitHub orgs (core.installations.account_login) visible to the session. */
export const OrgsListV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    orgs: z.array(z.string()),
  })
  .strict();
export type OrgsListV1 = z.infer<typeof OrgsListV1>;

/** One item in the GET /api/admin/reviews page (Pydantic __contract_internal__). */
export const ReviewListItemV1 = z
  .object({
    review_id: z.string().uuid(),
    repo: z.string().min(1),
    pr_number: z.number().int().min(1),
    pr_title: z.string(),
    state: z.enum(["queued", "in_progress", "complete", "failed"]),
    severity_max: z.enum(["nit", "suggestion", "issue", "blocker"]).nullable().default(null),
    finding_count: z.number().int().min(0),
    started_at: z.string().datetime({ offset: true }),
    completed_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type ReviewListItemV1 = z.infer<typeof ReviewListItemV1>;

/** GET /api/admin/reviews — page/size-paginated reviews list. */
export const ReviewsListPageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    items: z.array(ReviewListItemV1),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    size: z.number().int().min(1).max(100),
  })
  .strict();
export type ReviewsListPageV1 = z.infer<typeof ReviewsListPageV1>;

/** One row from GET /api/admin/pull-requests (a core.pull_requests row + resolved author_login). */
export const PullRequestRowV1 = z
  .object({
    pr_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    pr_number: z.number().int(),
    state: z.enum(["open", "closed", "merged"]),
    title: z.string(),
    author_login: z.string().nullable().default(null),
    base_ref: z.string(),
    head_ref: z.string(),
    head_sha: z.string(),
    draft: z.boolean(),
    cross_fork: z.boolean(),
    opened_at: z.string().datetime({ offset: true }),
    closed_at: z.string().datetime({ offset: true }).nullable().default(null),
    merged_at: z.string().datetime({ offset: true }).nullable().default(null),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type PullRequestRowV1 = z.infer<typeof PullRequestRowV1>;

/** GET /api/admin/pull-requests — keyset-paginated PR page. next_cursor carries
 *  cursor_opened_at + cursor_pr_id. */
export const PullRequestListResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rows: z.array(PullRequestRowV1),
    next_cursor: z.record(z.string(), z.string()).nullable().default(null),
  })
  .strict();
export type PullRequestListResponseV1 = z.infer<typeof PullRequestListResponseV1>;

/** One row from GET /api/admin/findings (a persisted core.review_findings row). */
export const FindingRowV1 = z
  .object({
    review_finding_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    file_path: z.string(),
    start_line: z.number().int(),
    end_line: z.number().int(),
    severity: z.string(),
    category: z.string(),
    title: z.string(),
    body: z.string(),
    suggestion: z.string().nullable().default(null),
    confidence: z.number(),
    github_comment_id: z.number().int().nullable().default(null),
    posted_review_pr_id: z.string().uuid().nullable().default(null),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type FindingRowV1 = z.infer<typeof FindingRowV1>;

/** GET /api/admin/findings — keyset-paginated findings page. next_cursor (when present) carries
 *  cursor_created_at + cursor_finding_id to pass back as query params. */
export const FindingListResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rows: z.array(FindingRowV1),
    next_cursor: z.record(z.string(), z.string()).nullable().default(null),
  })
  .strict();
export type FindingListResponseV1 = z.infer<typeof FindingListResponseV1>;

/** One unrecognized-label entry from core.v_taxonomy_gaps. */
export const TaxonomyGapEntryV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    label: z.string().min(14).regex(/^unrecognized:[a-z][a-z0-9_-]*$/),
    chunks_carrying: z.number().int().min(0),
    pages_carrying: z.number().int().min(0),
    spaces_carrying: z.number().int().min(0),
    most_recent_use: z.string().datetime({ offset: true }),
  })
  .strict();
export type TaxonomyGapEntryV1 = z.infer<typeof TaxonomyGapEntryV1>;

/** GET /api/admin/taxonomy/gaps — top-N unrecognized labels (sorted by chunks_carrying DESC). */
export const TaxonomyGapListV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rows: z.array(TaxonomyGapEntryV1),
  })
  .strict();
export type TaxonomyGapListV1 = z.infer<typeof TaxonomyGapListV1>;

/** GET /api/admin/dashboard — the operator landing summary. */
export const DashboardSummaryV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    services: z.array(ServiceHealthV1),
    reviews_this_hour: z.number().int().min(0),
    latency_p95_ms: z.number().int().min(0),
    in_flight_reviews: z.number().int().min(0),
    last_updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type DashboardSummaryV1 = z.infer<typeof DashboardSummaryV1>;
