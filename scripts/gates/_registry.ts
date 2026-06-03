// PORTED VERBATIM from the frozen Python gate scripts/check_tenant_scoped_raw_sql.py
// (migration-source-freeze, 46 tables). Keep in sync if the Python registry ever changes
// (it won't — Python is frozen). These are the schema-qualified tables that carry installation_id
// (or whose tenancy is enforced transitively) and therefore MUST be filtered in raw SQL.
export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set([
  "audit.audit_events",
  "audit.webhook_events",
  "audit.workflow_events",
  "cache.cache_app_jwt",
  "cache.cache_idempotency",
  "cache.cache_rate_limits",
  "cache.cache_tokens",
  "core.ad_users",
  "core.api_tokens",
  "core.arbitration_rejections",
  "core.code_owners",
  "core.config_revisions",
  "core.diff_snapshots",
  "core.feedback_events",
  "core.fix_prompts",
  "core.gh_users",
  "core.global_config",
  "core.installations",
  "core.integrations",
  "core.knowledge_chunks",
  "core.learning_proposals",
  "core.learnings",
  "core.learnings_revisions",
  "core.local_users",
  "core.org_configs",
  "core.outbox",
  "core.pr_files",
  "core.pr_issue_links",
  "core.pr_review_mutex",
  "core.pr_state_transitions",
  "core.pull_request_reviews",
  "core.pull_requests",
  "core.repo_configs",
  "core.repo_symbols",
  "core.repositories",
  "core.review_findings",
  "core.review_runs",
  "core.review_tool_runs",
  "core.role_grant_pending",
  "core.role_grants",
  "core.team_memberships",
  "core.teams",
  "core.users",
  "core.v_review_findings_with_phase",
  "telemetry.llm_calls",
  "telemetry.llm_calls_daily",
]);

export interface ExemptedEntry {
  reason: string;
  /** Sprint-aligned story id (S\d+\.[A-Z]+\.\d+), hotfix (S\d+\.X-<slug>), or PERMANENT-EXEMPTION-*. */
  follow_up_story: string;
}

// Empty at landing — mirrors the Python gate (no long-lived exempted sites). New entries require a
// follow_up_story per S23.AR.17 P-2 rotation. Prefer the inline `// tenant:exempt` marker for one-offs.
export const EXEMPTED: Record<string, ExemptedEntry> = {};
