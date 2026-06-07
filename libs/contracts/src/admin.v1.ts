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

// ─── Integrations (platform-scope; in-memory keyset pagination) ──────────────────────────────────

/** One integration in GET /api/admin/integrations (config_json kept as an opaque raw JSON string). */
export const IntegrationListItemV1 = z
  .object({
    integration_id: z.string().uuid(),
    kind: z.literal("confluence_space"),
    config_json: z.string(),
    enabled: z.boolean(),
    last_validated_at: z.string().datetime({ offset: true }).nullable().default(null),
    last_validation_error: z.string().nullable().default(null),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    trust_tier: z.enum(["trusted", "semi"]).nullable().default(null),
    default_governance_ack_at: z.string().datetime({ offset: true }).nullable().default(null),
    visibility: z.string().default("platform"),
    strict_label_mode: z.boolean().default(false),
  })
  .strict();
export type IntegrationListItemV1 = z.infer<typeof IntegrationListItemV1>;

export const IntegrationListPageV1 = z
  .object({
    rows: z.array(IntegrationListItemV1),
    next_cursor: z.string().nullable().default(null),
  })
  .strict();
export type IntegrationListPageV1 = z.infer<typeof IntegrationListPageV1>;

// ─── Notification rules (platform-scope) ─────────────────────────────────────────────────────────

const SlackRecipientV1 = z
  .object({ schema_version: z.literal(1).default(1), type: z.literal("slack"), channel: z.string().min(1).max(80).regex(/^[#C]/) })
  .strict();
const EmailRecipientV1 = z
  .object({ schema_version: z.literal(1).default(1), type: z.literal("email"), address: z.string().email() })
  .strict();
const WebhookRecipientV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    type: z.literal("webhook"),
    url: z.string().url(),
    secret_vault_path: z.string().min(1).max(512),
  })
  .strict();
const JiraRecipientV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    type: z.literal("jira"),
    project_key: z.string().regex(/^[A-Z]{1,10}$/),
    issue_type: z.enum(["Bug", "Task", "Story"]),
  })
  .strict();
/** A notification recipient — discriminated union on `type` (Pydantic Discriminator('type')). */
export const RecipientV1 = z.discriminatedUnion("type", [
  SlackRecipientV1,
  EmailRecipientV1,
  WebhookRecipientV1,
  JiraRecipientV1,
]);
export type RecipientV1 = z.infer<typeof RecipientV1>;

/** One rule from GET /api/admin/notification-rules[/{id}]. */
export const NotificationRuleV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rule_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    trigger_event: z.string().min(1).max(100),
    filters: z.record(z.string(), z.unknown()),
    recipients: z.array(RecipientV1),
    schedule_cron: z.string().nullable().default(null),
    state: z.enum(["active", "paused"]),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type NotificationRuleV1 = z.infer<typeof NotificationRuleV1>;

export const NotificationRulesPageV1 = z
  .object({ schema_version: z.literal(1).default(1), rules: z.array(NotificationRuleV1) })
  .strict();
export type NotificationRulesPageV1 = z.infer<typeof NotificationRulesPageV1>;

// ─── LLM config reads (llm_models_router / llm_provider_config) ──────────────────────────────────

/** One model in GET /api/admin/llm-models (core.llm_models). */
export const LlmModelV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.enum(["anthropic_direct", "bedrock"]),
    model_id: z.string().min(1).max(128),
    display_name: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
    last_validation_status: z.enum(["untested", "ok", "failed"]).default("untested"),
    last_validation_error: z.string().nullable().default(null),
    last_validated_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type LlmModelV1 = z.infer<typeof LlmModelV1>;

export const LlmModelListV1 = z
  .object({ schema_version: z.literal(1).default(1), models: z.array(LlmModelV1).default([]) })
  .strict();
export type LlmModelListV1 = z.infer<typeof LlmModelListV1>;

/** One purpose→model assignment in GET /api/admin/llm-purpose-routing.
 *  FAITHFUL-PORT: the enum mirrors the Python contract's 7 values; the DB CHECK also admits 'fix_prompt'
 *  (8th) — a row with that value would fail validation identically to the Python (parity preserved). */
export const LlmPurposeModelV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    purpose: z.enum([
      "review_summary",
      "review_finding",
      "chat_reply",
      "walkthrough",
      "redaction_check",
      "cost_estimate",
      "analysis_curator",
    ]),
    model_id: z.string().min(1).max(128),
  })
  .strict();
export type LlmPurposeModelV1 = z.infer<typeof LlmPurposeModelV1>;

export const LlmPurposeModelListV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    assignments: z.array(LlmPurposeModelV1).default([]),
  })
  .strict();
export type LlmPurposeModelListV1 = z.infer<typeof LlmPurposeModelListV1>;

/** GET /api/admin/llm-provider-config (the active per-role provider metadata; 404 when unconfigured). */
export const LlmProviderConfigV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.enum(["bedrock", "anthropic_direct"]),
    model_id: z.string().min(1).max(128),
    region: z.string().min(1).max(32).nullable().default(null),
    api_key_fingerprint: z.string().length(4),
    enabled: z.boolean(),
    last_validated_at: z.string().datetime({ offset: true }).nullable(),
    last_validation_status: z.enum(["ok", "failed"]).nullable(),
    last_rotated_at: z.string().datetime({ offset: true }),
    last_rotated_by_user_id: z.string().uuid(),
  })
  .strict();
export type LlmProviderConfigV1 = z.infer<typeof LlmProviderConfigV1>;

/** One feature flag in GET /api/admin/flags (incl. pending two-person-approval state). */
export const FlagDetailV1 = z
  .object({
    flag_name: z.string(),
    scope: z.enum(["global", "installation", "repository"]),
    scope_id: z.string().uuid().nullable().default(null),
    value_json: z.string(),
    last_changed_at: z.string().datetime({ offset: true }),
    last_changed_by_user_id: z.string().uuid().nullable().default(null),
    pending_second_approver: z.boolean(),
    pending_first_approver_user_id: z.string().uuid().nullable().default(null),
    pending_value_json: z.string().nullable().default(null),
    pending_set_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type FlagDetailV1 = z.infer<typeof FlagDetailV1>;

/** GET /api/admin/flags — a bare array of flags visible to the session (global + own-installation). */
export const FlagListV1 = z.array(FlagDetailV1);
export type FlagListV1 = z.infer<typeof FlagListV1>;

/** One row in GET /api/admin/audit-events (decrypted excerpts; no schema_version, matching the Python
 *  internal HTTP type). */
export const AuditEventListItemV1 = z
  .object({
    audit_event_id: z.string().uuid(),
    actor_user_id: z.string().uuid(),
    action: z.string(),
    target_id: z.string().nullable().default(null),
    occurred_at: z.string().datetime({ offset: true }),
    before_excerpt: z.string(),
    after_excerpt: z.string(),
  })
  .strict();
export type AuditEventListItemV1 = z.infer<typeof AuditEventListItemV1>;

/** GET /api/admin/audit-events — cursor-paginated audit page. */
export const AuditSearchResponseV1 = z
  .object({
    rows: z.array(AuditEventListItemV1),
    next_cursor: z.string().nullable().default(null),
  })
  .strict();
export type AuditSearchResponseV1 = z.infer<typeof AuditSearchResponseV1>;

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
