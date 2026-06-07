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

// ─── Default-corpus health (platform-scope) ──────────────────────────────────────────────────────

export const DefaultScopeHitRateV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    scope: z.enum([
      "universal",
      "security_only",
      "compliance_only",
      "framework_only",
      "language_only",
    ]),
    chunks_in_corpus: z.number().int().min(0),
    chunks_retrieved_24h: z.number().int().min(0),
    hit_rate_24h: z.number().min(0).max(1),
  })
  .strict();
export type DefaultScopeHitRateV1 = z.infer<typeof DefaultScopeHitRateV1>;

/** GET /api/admin/default-corpus/health — default-corpus coverage + 24h per-scope hit rate. */
export const DefaultCorpusHealthV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    captured_at: z.string().datetime({ offset: true }),
    total_default_chunks: z.number().int().min(0),
    stale_default_chunks: z.number().int().min(0),
    total_tokens: z.number().int().min(0),
    spaces_with_defaults: z.number().int().min(0),
    hit_rate_24h_by_scope: z.array(DefaultScopeHitRateV1),
  })
  .strict();
export type DefaultCorpusHealthV1 = z.infer<typeof DefaultCorpusHealthV1>;

// ─── Cost caps (platform-scope governance) ───────────────────────────────────────────────────────

export const CostCapSettingsV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    global_cap_cents: z.number().int().min(0),
    per_org_default_cap_cents: z.number().int().min(0),
    hard_ceiling_cents: z.literal(5000000).default(5000000),
    updated_at: z.string().datetime({ offset: true }),
    updated_by_user_id: z.string().uuid().nullable().default(null),
  })
  .strict();
export type CostCapSettingsV1 = z.infer<typeof CostCapSettingsV1>;

export const CostCapOverrideV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    installation_id: z.string().uuid(),
    installation_name: z.string(),
    cap_cents: z.number().int().min(0),
    expires_at: z.string().datetime({ offset: true }).nullable().default(null),
    updated_at: z.string().datetime({ offset: true }),
    updated_by_user_id: z.string().uuid().nullable().default(null),
  })
  .strict();
export type CostCapOverrideV1 = z.infer<typeof CostCapOverrideV1>;

export const CostCapPendingChangeV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    pending_change_id: z.string().uuid(),
    target_kind: z.enum(["global", "per_org_default", "per_org_override"]),
    target_id: z.string().uuid().nullable().default(null),
    new_cap_cents: z.number().int().min(0),
    expires_at: z.string().datetime({ offset: true }).nullable().default(null),
    requested_at: z.string().datetime({ offset: true }),
    requested_by_user_id: z.string().uuid(),
    approved_at: z.string().datetime({ offset: true }).nullable().default(null),
    approved_by_user_id: z.string().uuid().nullable().default(null),
    applied_at: z.string().datetime({ offset: true }).nullable().default(null),
    state: z.enum(["pending", "approved", "applied", "rejected", "expired"]),
  })
  .strict();
export type CostCapPendingChangeV1 = z.infer<typeof CostCapPendingChangeV1>;

/** GET /api/admin/cost-caps — the cost-cap governance page. */
export const CostCapPageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    settings: CostCapSettingsV1,
    overrides: z.array(CostCapOverrideV1),
    todays_spend_global_cents: z.number().int().min(0),
    todays_projected_global_cents: z.number().int().min(0),
    pending_changes: z.array(CostCapPendingChangeV1),
  })
  .strict();
export type CostCapPageV1 = z.infer<typeof CostCapPageV1>;

/** Cap ceiling enforced at the contract boundary (1:1 with HARD_CEILING_CENTS). */
export const COST_CAP_HARD_CEILING_CENTS = 5_000_000;

/** POST /api/admin/cost-caps/changes body — stage a cap change (two-person approval). The structural
 *  target_kind/target_id consistency rules are enforced at the route helper, not the schema. */
export const CostCapChangeRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    target_kind: z.enum(["global", "per_org_default", "per_org_override"]),
    target_id: z.string().uuid().nullable().default(null),
    new_cap_cents: z.number().int().min(0).max(COST_CAP_HARD_CEILING_CENTS),
    expires_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type CostCapChangeRequestV1 = z.infer<typeof CostCapChangeRequestV1>;

// ─── Knowledge (learnings; tenant-scoped; in-memory keyset) ──────────────────────────────────────

/** One learning in GET /api/admin/knowledge. accept_rate is app-computed (accepted/feedback). */
export const LearningListItemV1 = z
  .object({
    learning_id: z.string().uuid(),
    title: z.string(),
    state: z.enum(["active", "deprecated"]),
    repo: z.string().nullable().default(null),
    version: z.number().int(),
    fired_count: z.number().int(),
    accept_rate: z.number(),
    last_fired_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type LearningListItemV1 = z.infer<typeof LearningListItemV1>;

export const LearningListPageV1 = z
  .object({ rows: z.array(LearningListItemV1), next_cursor: z.string().nullable().default(null) })
  .strict();
export type LearningListPageV1 = z.infer<typeof LearningListPageV1>;

export const LearningRevisionItemV1 = z
  .object({
    revision_id: z.string().uuid(),
    body_markdown: z.string(),
    version: z.number().int(),
    edited_by_user_id: z.string().uuid(),
    edited_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type LearningRevisionItemV1 = z.infer<typeof LearningRevisionItemV1>;

/** GET /api/admin/knowledge/{learning_id} — the learning + its recent revisions. */
export const LearningDetailV1 = z
  .object({
    learning_id: z.string().uuid(),
    title: z.string(),
    body_markdown: z.string(),
    state: z.enum(["active", "deprecated"]),
    repo: z.string().nullable().default(null),
    version: z.number().int(),
    fired_count: z.number().int(),
    accept_rate: z.number(),
    last_fired_at: z.string().datetime({ offset: true }).nullable().default(null),
    revisions: z.array(LearningRevisionItemV1),
  })
  .strict();
export type LearningDetailV1 = z.infer<typeof LearningDetailV1>;

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

/** Atlassian space-key charset (1:1 with integrations.py _SPACE_KEY_REGEX). Anchored; refuses
 *  path-traversal before any Confluence call. */
const SPACE_KEY_RE = /^[A-Z0-9_-]{1,255}$/;
/** 'platform' | 'org:<slug>' (1:1 with _AddConfluenceSpaceV1.visibility pattern). */
const INTEGRATION_VISIBILITY_RE = /^(platform|org:[a-z][a-z0-9_-]*)$/;

/**
 * POST /api/admin/integrations/confluence-spaces request body — 1:1 with integrations.py
 * `_AddConfluenceSpaceV1`. No cross-field rule: page_tree_root_id is NOT required even when
 * scope='page_tree' (the Python does not pair them — preserve the gap). .strict() ⇔ extra="forbid".
 * The 201 response reuses IntegrationListItemV1 (the Python _IntegrationHTTP is field-identical).
 */
export const AddConfluenceSpaceRequestV1 = z
  .object({
    space_key: z.string().min(1).max(255).regex(SPACE_KEY_RE),
    space_name: z.string().min(1).max(255),
    scope: z.enum(["whole_space", "page_tree"]).default("whole_space"),
    page_tree_root_id: z.string().max(64).nullable().default(null),
    trust_tier: z.enum(["trusted", "semi"]).default("trusted"),
    governance_ack: z.boolean().default(false),
    visibility: z.string().max(64).regex(INTEGRATION_VISIBILITY_RE).default("platform"),
    strict_label_mode: z.boolean().default(false),
  })
  .strict();
export type AddConfluenceSpaceRequestV1 = z.infer<typeof AddConfluenceSpaceRequestV1>;

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

// Cron validation for the WRITE request contracts (mirrors the Python `_cron_valid` field_validator, which
// uses croniter). 1:1-DIVERGENCE: this is a STRUCTURAL validator (standard 5/6-field grammar + @macros),
// not byte-identical to croniter — it rejects malformed input at 422 but may not match croniter on
// pathological-yet-valid expressions (real notification crons are standard). Swap in a cron-parser dep
// here if exact croniter parity is ever required.
const _CRON_MACROS = new Set([
  "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly",
]);
const _CRON_ATOM = "(?:\\*|\\?|(?:[0-9]+|[a-z]{3})(?:-(?:[0-9]+|[a-z]{3}))?)(?:\\/[0-9]+)?";
const _CRON_FIELD = new RegExp(`^${_CRON_ATOM}(?:,${_CRON_ATOM})*$`, "i");

/** Structural cron check: @macro, or 5/6 whitespace-separated fields each matching the standard atom
 *  grammar (wildcard, ranges, steps, lists, 3-letter names). See divergence note above. */
export function isValidCron(value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  if (v.startsWith("@")) return _CRON_MACROS.has(v.toLowerCase());
  const fields = v.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  return fields.every((f) => _CRON_FIELD.test(f));
}

function cronRefine(value: string | null | undefined, ctx: z.RefinementCtx): void {
  if (typeof value === "string" && !isValidCron(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid cron expression: " + value });
  }
}

/** POST /api/admin/notification-rules body — state/timestamps/rule_id are server-assigned. */
export const NotificationRuleCreateRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    name: z.string().min(1).max(200),
    trigger_event: z.string().min(1).max(100),
    filters: z.record(z.string(), z.unknown()).default({}),
    recipients: z.array(RecipientV1).default([]),
    schedule_cron: z.string().nullable().default(null).superRefine(cronRefine),
  })
  .strict();
export type NotificationRuleCreateRequestV1 = z.infer<typeof NotificationRuleCreateRequestV1>;

/** PATCH /api/admin/notification-rules/{rule_id} body — every field optional; only provided fields are
 *  written (exclude-unset semantics enforced at the route from the raw body's keys). */
export const NotificationRuleUpdateRequestV1 = z
  .object({
    schema_version: z.literal(1).optional(),
    name: z.string().min(1).max(200).optional(),
    trigger_event: z.string().min(1).max(100).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    recipients: z.array(RecipientV1).optional(),
    schedule_cron: z.string().nullable().optional().superRefine(cronRefine),
    state: z.enum(["active", "paused"]).optional(),
  })
  .strict();
export type NotificationRuleUpdateRequestV1 = z.infer<typeof NotificationRuleUpdateRequestV1>;

/** POST /api/admin/notification-rules/{rule_id}/dry-run response — the recipients the rule WOULD fire to. */
export const NotificationRuleDryRunResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    would_dispatch_to: z.array(z.record(z.string(), z.string())),
  })
  .strict();
export type NotificationRuleDryRunResponseV1 = z.infer<typeof NotificationRuleDryRunResponseV1>;

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

/** PUT /api/admin/llm-models body — upsert a catalog model. model_id is guarded against BEDROCK_MODELS at
 *  the route (the engine rejects anything outside that set, regardless of provider). */
export const LlmModelUpsertV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.enum(["anthropic_direct", "bedrock"]),
    model_id: z.string().min(1).max(128),
    display_name: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict();
export type LlmModelUpsertV1 = z.infer<typeof LlmModelUpsertV1>;

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

/** PUT /api/admin/llm-purpose-routing body — assign one purpose to a catalog model. The purpose enum is
 *  the 7-value LlmPurposeV1 vocabulary (it OMITS 'fix_prompt' which the DB CHECK admits — faithful drift). */
export const LlmPurposeAssignmentUpdateV1 = z
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
export type LlmPurposeAssignmentUpdateV1 = z.infer<typeof LlmPurposeAssignmentUpdateV1>;

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

/** AWS region shape (Bedrock). 1:1 with the Python region Field pattern. */
const LLM_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

/**
 * PUT /api/admin/llm-provider-config request body — 1:1 with contracts/admin/llm_provider_config/v1.py
 * `LlmProviderConfigUpdateV1`. api_key is the plaintext token (Vault-Transit-encrypted at rest, never
 * returned). Cross-field invariants (superRefine, mirroring the Python model_validator):
 *   - bedrock requires a region; anthropic_direct does not.
 *   - model_id pattern is provider-specific (bedrock: `anthropic.`|`claude-`; anthropic_direct: `claude-`).
 */
export const LlmProviderConfigUpdateV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.enum(["bedrock", "anthropic_direct"]),
    role: z.enum(["primary", "secondary"]),
    model_id: z.string().min(1).max(128),
    region: z.string().min(1).max(32).regex(LLM_REGION_RE).nullable().default(null),
    api_key: z.string().min(20),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.provider === "bedrock" && v.region === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "region is required for bedrock", path: ["region"] });
    }
    if (v.provider === "bedrock" && !/^(anthropic\.|claude-)/.test(v.model_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bedrock model_id must start with 'anthropic.' or 'claude-'",
        path: ["model_id"],
      });
    }
    if (v.provider === "anthropic_direct" && !/^claude-/.test(v.model_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "anthropic_direct model_id must start with 'claude-'",
        path: ["model_id"],
      });
    }
  });
export type LlmProviderConfigUpdateV1 = z.infer<typeof LlmProviderConfigUpdateV1>;

/**
 * POST /api/admin/llm-provider-config/test-credentials request — 1:1 with `LlmCredentialsTestV1`. Model-LESS
 * connection check (ADR-0060): no model_id. bedrock still requires a region.
 */
export const LlmCredentialsTestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.enum(["bedrock", "anthropic_direct"]),
    region: z.string().min(1).max(32).regex(LLM_REGION_RE).nullable().default(null),
    api_key: z.string().min(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.provider === "bedrock" && v.region === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "region is required for bedrock", path: ["region"] });
    }
  });
export type LlmCredentialsTestV1 = z.infer<typeof LlmCredentialsTestV1>;

/** Response of the preflight / test-credentials connection checks — `{ ok, message }` (Python returns a bare
 *  dict; "ok" on success, the sanitized upstream error otherwise). 200 regardless of outcome. */
export const LlmConnectionTestResultV1 = z
  .object({
    ok: z.boolean(),
    message: z.string(),
  })
  .strict();
export type LlmConnectionTestResultV1 = z.infer<typeof LlmConnectionTestResultV1>;

/** Legacy GET/PUT /api/admin/bedrock-config response — 1:1 alias of LlmProviderConfigV1
 *  (Python: BedrockConfigV1 = LlmProviderConfigV1, bedrock_config.py:41). */
export const BedrockConfigV1 = LlmProviderConfigV1;
export type BedrockConfigV1 = z.infer<typeof BedrockConfigV1>;

/**
 * PUT /api/admin/bedrock-config request body — the LEGACY shim shape (Python: _LegacyBedrockConfigUpdateBody,
 * bedrock_config.py:53-84). NOT a cross-process contract: provider/role are hardcoded by the shim to
 * bedrock/primary; region is REQUIRED (not nullable, unlike LlmProviderConfigUpdateV1); model_id uses the
 * bedrock pattern unconditionally. .strict() ⇔ Python extra="forbid" (a stray provider/role field → 422).
 */
export const LegacyBedrockConfigUpdateBodyV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    model_id: z.string().min(1).max(128).regex(/^(anthropic\.|claude-)/),
    region: z.string().min(1).max(32).regex(LLM_REGION_RE),
    api_key: z.string().min(20),
    enabled: z.boolean().default(true),
  })
  .strict();
export type LegacyBedrockConfigUpdateBodyV1 = z.infer<typeof LegacyBedrockConfigUpdateBodyV1>;

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

/** PUT /api/admin/flags/{flag_name} request body. 1:1 with flags.py `_PutFlagV1` (no schema_version). */
export const PutFlagRequestV1 = z
  .object({
    value_json: z.string().min(1).max(8192),
  })
  .strict();
export type PutFlagRequestV1 = z.infer<typeof PutFlagRequestV1>;

/** PUT /api/admin/flags/{flag_name} response — the post-write flag + which two-person approval path ran.
 *  1:1 with flags.py `_PutFlagResponseV1` (no schema_version). */
export const PutFlagResponseV1 = z
  .object({
    flag: FlagDetailV1,
    path: z.enum(["staged_first", "committed"]),
  })
  .strict();
export type PutFlagResponseV1 = z.infer<typeof PutFlagResponseV1>;

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

// ─── Members (GET /api/admin/members) ──────────────────────────────────────────────────────────────
// 1:1 with contracts/admin/members/v1.py. The role enum mirrors core.role_grants (ADR-0023 reduced
// shape: super_admin lives in core.local_users, NOT this enum). schema_version is 2 on the row
// contracts, 1 on the page envelope — matching the Python literals exactly.

/** One active role grant joined to core.users. `granted_by_user_id` is nullable (see members_read.ts —
 *  the production core.role_grants has no granter column, so the port emits null). */
export const MemberV1 = z
  .object({
    schema_version: z.literal(2).default(2),
    user_id: z.string().uuid(),
    email: z.string(),
    display_name: z.string(),
    role: z.enum(["platform_owner", "platform_operator", "reader"]),
    granted_at: z.string().datetime({ offset: true }),
    granted_by_user_id: z.string().uuid().nullable().default(null),
    scope: z.enum(["platform", "installation"]).default("installation"),
  })
  .strict();
export type MemberV1 = z.infer<typeof MemberV1>;

/** One queued grant/revoke from core.role_grant_pending awaiting a second-user approval. */
export const RoleChangePendingV1 = z
  .object({
    schema_version: z.literal(2).default(2),
    pending_id: z.string().uuid(),
    subject_kind: z.enum(["user", "team"]),
    subject_id: z.string().uuid(),
    role: z.enum(["platform_owner", "platform_operator", "reader"]),
    action: z.enum(["grant", "revoke"]),
    requested_at: z.string().datetime({ offset: true }),
    requested_by_user_id: z.string().uuid(),
    expires_at: z.string().datetime({ offset: true }),
    approved_at: z.string().datetime({ offset: true }).nullable().default(null),
    approved_by_user_id: z.string().uuid().nullable().default(null),
    applied_at: z.string().datetime({ offset: true }).nullable().default(null),
    state: z.enum(["pending", "approved", "applied", "rejected", "expired"]),
    scope: z.enum(["platform", "installation"]).default("installation"),
  })
  .strict();
export type RoleChangePendingV1 = z.infer<typeof RoleChangePendingV1>;

/** GET /api/admin/members — active members + every in-flight pending change in one round-trip. */
export const MembersPageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    members: z.array(MemberV1),
    pending_changes: z.array(RoleChangePendingV1),
  })
  .strict();
export type MembersPageV1 = z.infer<typeof MembersPageV1>;

/** POST /api/admin/members/{subject_kind}/{subject_id}/role-changes body — stage a grant/revoke. */
export const RoleChangeRequestV1 = z
  .object({
    schema_version: z.literal(2).default(2),
    subject_kind: z.enum(["user", "team"]),
    subject_id: z.string().uuid(),
    role: z.enum(["platform_owner", "platform_operator", "reader"]),
    action: z.enum(["grant", "revoke"]),
    scope: z.enum(["platform", "installation"]).default("installation"),
  })
  .strict();
export type RoleChangeRequestV1 = z.infer<typeof RoleChangeRequestV1>;

/** POST body for the approve / reject role-change routes — carries the SECOND user for the two-person rule. */
export const MemberApproverBodyV1 = z
  .object({
    approver_user_id: z.string().uuid(),
  })
  .strict();
export type MemberApproverBodyV1 = z.infer<typeof MemberApproverBodyV1>;

// ─── Embedder (GET /api/admin/embedder/{state,coverage,reembed/status}) ──────────────────────────────
// 1:1 with contracts/admin/embedder/v1.py. created_by_email/updated_by_email are EmailStr|None in
// Python; the API layer pre-coerces non-email strings (incl. the 'migration-seed' sentinel) to null via
// _coerce_email_or_none before they reach the contract. We mirror EmailStr with z.string().email() — real
// emails pass both; the only theoretical divergence is the email regex on pathological has-@-but-invalid
// strings, which the coercion + real data make unreachable.

/** Doubly-nested compatibility-validation report, parsed from embedding_generations.validation_report_json. */
export const ValidationReportV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    sample_size: z.number().int().min(1),
    tokenization_drift: z.record(z.string(), z.number()),
    norm_distribution_old: z.record(z.string(), z.number()),
    norm_distribution_new: z.record(z.string(), z.number()),
    truncation_count: z.number().int().min(0),
    retrieval_overlap: z.record(z.string(), z.number()),
    warnings: z.array(z.string()).max(20).default([]),
    passed: z.boolean(),
  })
  .strict();
export type ValidationReportV1 = z.infer<typeof ValidationReportV1>;

/** One row of core.embedding_generations (shared by /state's generations[] and /reembed/status). */
export const EmbeddingGenerationV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    generation_id: z.number().int().min(1),
    state: z.enum(["backfilling", "ready", "active", "retired"]),
    generation_label: z.string().nullable(),
    generation_reason: z.string().nullable(),
    provider_name: z.string(),
    provider_version: z.string().nullable(),
    model_name: z.string(),
    embedding_dimension: z.number().int().min(1),
    created_from_generation: z.number().int().nullable(),
    chunker_version: z.string(),
    preprocessing_version: z.string(),
    normalization_version: z.string(),
    created_at: z.string().datetime({ offset: true }),
    created_by_email: z.string().email().nullable(),
    backfill_started_at: z.string().datetime({ offset: true }).nullable(),
    backfill_completed_at: z.string().datetime({ offset: true }).nullable(),
    validation_started_at: z.string().datetime({ offset: true }).nullable(),
    validation_completed_at: z.string().datetime({ offset: true }).nullable(),
    validation_passed: z.boolean().nullable(),
    validation_report: ValidationReportV1.nullable().default(null),
    activated_at: z.string().datetime({ offset: true }).nullable(),
    retired_at: z.string().datetime({ offset: true }).nullable(),
    retire_reason: z.enum(["cancelled", "demoted", "manual_retire"]).nullable().default(null),
    gc_started_at: z.string().datetime({ offset: true }).nullable(),
    gc_completed_at: z.string().datetime({ offset: true }).nullable(),
    total_chunks: z.number().int().min(0),
    chunks_backfilled: z.number().int().min(0),
    chunks_failed: z.number().int().min(0),
    last_error: z.string().nullable(),
  })
  .strict();
export type EmbeddingGenerationV1 = z.infer<typeof EmbeddingGenerationV1>;

/** GET /api/admin/embedder/state — runtime-state singleton + the 20 most-recent generations. */
export const EmbedderStateV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    active_generation: z.number().int(),
    active_model_name: z.string(),
    pending_generation: z.number().int().nullable(),
    pending_model_name: z.string().nullable(),
    config_version: z.number().int(),
    retrieval_mode: z.enum(["fallback", "generation_only"]).default("fallback"),
    updated_at: z.string().datetime({ offset: true }),
    updated_by_email: z.string().email().nullable(),
    generations: z.array(EmbeddingGenerationV1).max(20).default([]),
  })
  .strict();
export type EmbedderStateV1 = z.infer<typeof EmbedderStateV1>;

/** GET /api/admin/embedder/coverage — re-embed coverage gate (gates the retrieval_mode flip). */
export const EmbedderCoverageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    confluence_missing: z.number().int().min(0),
    knowledge_missing: z.number().int().min(0),
    total_missing: z.number().int().min(0),
    active_generation: z.number().int().min(1),
  })
  .strict();
export type EmbedderCoverageV1 = z.infer<typeof EmbedderCoverageV1>;

// ─── Retrieval-trace inspector list (GET /api/admin/retrieval-traces) ────────────────────────────────
// 1:1 with contracts/admin/retrieval_traces/v1.py. One flattened row of the v_retrieval_traces_recent
// materialized view (all columns derived from the trace JSONB). The detail endpoint reuses the full
// RetrievalTraceV2 from #contracts/persist_retrieval_trace.v1.

/** One row of v_retrieval_traces_recent — compact, all-non-nullable. */
export const RetrievalTraceListEntryV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    trace_id: z.string().uuid(),
    review_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    captured_at: z.string().datetime({ offset: true }),
    taxonomy_version: z.number().int().min(0),
    pipeline_version: z.number().int().min(1),
    trace_schema_version: z.number().int().min(1),
    effective_labels_count: z.number().int().min(0),
    repo_include_attempts_filtered_count: z.number().int().min(0),
    starvation_observed: z.boolean(),
    selected_chunks_count: z.number().int().min(0),
    dropped_chunks_count: z.number().int().min(0),
    budget_total: z.number().int().min(0),
    budget_remaining: z.number().int().min(0),
  })
  .strict();
export type RetrievalTraceListEntryV1 = z.infer<typeof RetrievalTraceListEntryV1>;

/** GET /api/admin/retrieval-traces — offset-paginated list (next_cursor is a stringified offset). */
export const RetrievalTraceListPageV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    rows: z.array(RetrievalTraceListEntryV1),
    next_cursor: z.string().nullable().default(null),
  })
  .strict();
export type RetrievalTraceListPageV1 = z.infer<typeof RetrievalTraceListPageV1>;

// ─── Retrieval aggregates (GET /api/admin/retrieval-aggregates/{reviews,pull-requests}) ──────────────
// 1:1 with contracts/admin/retrieval_aggregate/v1.py. metadata_as_of comes from
// `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'` (a NAIVE timestamp string, no offset) so its datetime() guard
// permits both offset-bearing and local (offset-less) forms. captured-at fields are timestamptz → offset.

/** Lenient ISO-datetime guard: accepts Z, ±offset, or naive (the metadata_as_of / DB-emitted forms). */
const aggregateTs = () => z.string().datetime({ offset: true, local: true });

/** GET /api/admin/retrieval-aggregates/reviews/{review_id} — per-review historical rollup + meta snapshot. */
export const RetrievalAggregateV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    aggregate_snapshot_kind: z.literal("historical_review_scoped"),
    metadata_as_of: aggregateTs(),
    aggregation_scope: z.enum(["review_scoped"]),
    lineage_confidence: z.enum(["exact", "mixed_run_possible"]),
    lineage_warning: z.string().nullable().default(null),
    review_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    pr_number: z.number().int(),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    repo_full_name: z.string(),
    latest_run_id: z.string().uuid().nullable().default(null),
    latest_run_lifecycle_state: z.string().nullable().default(null),
    latest_run_terminal_reason: z.string().nullable().default(null),
    superseded_run_count: z.number().int().min(0),
    pr_current_head_sha: z.string(),
    total_trace_count: z.number().int().min(0),
    returned_trace_count: z.number().int().min(0),
    parsed_trace_count: z.number().int().min(0),
    invalid_trace_count: z.number().int().min(0),
    trace_count_truncated: z.boolean(),
    earliest_captured_at: aggregateTs().nullable().default(null),
    latest_captured_at: aggregateTs().nullable().default(null),
    starvation_any: z.boolean(),
    starvation_trace_count: z.number().int().min(0),
    effective_labels_union: z.array(z.string()).max(500).default([]),
    pipeline_versions_seen: z.array(z.number().int()).default([]),
    taxonomy_versions_seen: z.array(z.number().int()).default([]),
    version_drift_detected: z.boolean(),
    top_spaces_retrieved: z.array(z.string()).max(5).default([]),
    top_labels_retrieved: z.array(z.string()).max(5).default([]),
  })
  .strict();
export type RetrievalAggregateV1 = z.infer<typeof RetrievalAggregateV1>;

/** One per-review summary in the by-PR list. */
export const RetrievalAggregatePRReviewSummaryV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    review_id: z.string().uuid(),
    earliest_captured_at: aggregateTs().nullable().default(null),
    latest_captured_at: aggregateTs().nullable().default(null),
    trace_count: z.number().int().min(0),
    starvation_any: z.boolean(),
    starvation_trace_count: z.number().int().min(0),
    latest_run_id: z.string().uuid().nullable().default(null),
    latest_run_lifecycle_state: z.string().nullable().default(null),
    superseded_run_count: z.number().int().min(0).default(0),
  })
  .strict();
export type RetrievalAggregatePRReviewSummaryV1 = z.infer<typeof RetrievalAggregatePRReviewSummaryV1>;

/** GET /api/admin/retrieval-aggregates/pull-requests/{pr_id} — every review with traces for the PR. */
export const RetrievalAggregatePRListV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    pr_id: z.string().uuid(),
    pr_number: z.number().int(),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    repo_full_name: z.string(),
    pr_current_head_sha: z.string(),
    metadata_as_of: aggregateTs(),
    reviews: z.array(RetrievalAggregatePRReviewSummaryV1).max(500).default([]),
    total_review_count: z.number().int().min(0),
    returned_review_count: z.number().int().min(0),
    review_count_truncated: z.boolean(),
  })
  .strict();
export type RetrievalAggregatePRListV1 = z.infer<typeof RetrievalAggregatePRListV1>;

// ─── Pending proposals list (GET /api/admin/knowledge/proposals) ─────────────────────────────────────
// 1:1 with knowledge.py's private _ProposalHTTP / _ProposalListPageV1 wire models (no schema_version, to
// match the sibling LearningListItemV1 port). `state` is deliberately OMITTED from the wire shape — the
// queue only ever shows pending_approval rows, so the field carries no information.

/** One pending learning proposal (body column → body_markdown; repo from a LEFT JOIN to repositories). */
export const ProposalListItemV1 = z
  .object({
    proposal_id: z.string().uuid(),
    title: z.string(),
    body_markdown: z.string(),
    repo: z.string().nullable().default(null),
    proposed_by_user_id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProposalListItemV1 = z.infer<typeof ProposalListItemV1>;

/** GET /api/admin/knowledge/proposals — keyset-paginated pending-approval queue (DESC by created_at). */
export const ProposalListPageV1 = z
  .object({
    rows: z.array(ProposalListItemV1),
    next_cursor: z.string().nullable().default(null),
  })
  .strict();
export type ProposalListPageV1 = z.infer<typeof ProposalListPageV1>;

// ─── Repositories enable (PUT /api/admin/repositories/{github_repo_id}/enable) ───────────────────────
// 1:1 with contracts/admin/repositories/v1.py.

/** A repository row (the PUT-enable response). github_repo_id is bigint → coerced to number. */
export const RepositoryV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    repository_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    github_repo_id: z.number().int().gt(0),
    full_name: z.string().min(1).max(512),
    default_branch: z.string().min(1).max(255),
    enabled: z.boolean(),
    archived: z.boolean(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type RepositoryV1 = z.infer<typeof RepositoryV1>;

/** PUT /api/admin/repositories/{github_repo_id}/enable body — flips core.repositories.enabled. */
export const RepositoryEnableUpdateV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    enabled: z.boolean(),
  })
  .strict();
export type RepositoryEnableUpdateV1 = z.infer<typeof RepositoryEnableUpdateV1>;

// ─── Taxonomy suggestions (POST /api/admin/taxonomy/suggestions) ─────────────────────────────────────
// 1:1 with contracts/admin/taxonomy_gaps/v1.py. schema_version is a plain int in the Python (not Literal).

/** Operator-submitted suggestion to formalize an `unrecognized:*` label into a curated one. */
export const TaxonomySuggestionV1 = z
  .object({
    schema_version: z.number().int().default(1),
    label: z.string().min(14).regex(/^unrecognized:[a-z][a-z0-9_-]*$/),
    proposed_canonical_label: z
      .string()
      .min(3)
      .regex(/^(default|(lang|framework|infra|topic|org|version):[a-z][a-z0-9_-]*)$/),
    rationale: z.string().min(20).max(2000),
    suggester_email: z.string().email().nullable().default(null),
  })
  .strict();
export type TaxonomySuggestionV1 = z.infer<typeof TaxonomySuggestionV1>;

/** 201 response — the minted id + queued-for-review timestamp. */
export const TaxonomySuggestionAcceptedV1 = z
  .object({
    schema_version: z.number().int().default(1),
    suggestion_id: z.string().uuid(),
    queued_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type TaxonomySuggestionAcceptedV1 = z.infer<typeof TaxonomySuggestionAcceptedV1>;

// ─── Finding feedback (POST /api/admin/reviews/{review_id}/findings/{finding_id}/feedback) ───────────
// 1:1 with contracts/admin/v1.py. verb maps to core.feedback_events.kind (helpful→thumbs_up,
// not_helpful/wrong→thumbs_down); the verb is preserved only in the encrypted raw_payload.

export const SubmitFindingFeedbackRequestV1 = z
  .object({
    schema_version: z.number().int().default(1),
    verb: z.enum(["helpful", "not_helpful", "wrong"]),
  })
  .strict();
export type SubmitFindingFeedbackRequestV1 = z.infer<typeof SubmitFindingFeedbackRequestV1>;

/** 201 response — the persisted feedback event id. */
export const FindingFeedbackResponseV1 = z
  .object({
    schema_version: z.number().int().default(1),
    feedback_event_id: z.string().uuid(),
  })
  .strict();
export type FindingFeedbackResponseV1 = z.infer<typeof FindingFeedbackResponseV1>;
