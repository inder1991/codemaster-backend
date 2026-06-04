/**
 * Activity registry — the map the worker passes to `Worker.create({ activities })`. A thin re-export so
 * the worker bootstrap (`main.ts`) and the bundle self-check stay decoupled from the individual activity
 * modules, and so 2.1 grows the registered surface by adding ONE entry here (additively) rather than
 * editing the worker bootstrap.
 *
 * Phase 2.0 walking skeleton: exactly ONE activity. The key MUST match the name the workflow's
 * `proxyActivities<{ persistReviewFindings(...) }>` calls — Temporal resolves the activity by this key.
 *
 * Phase 2.1: adds `aggregateFindings`, `classifyFiles`, `loadRepoConfigActivity`,
 * `computePolicyRules`, and `postCheckRun` (the ported core-loop activities). Each is registered here but
 * NOT yet wired into a workflow body (orchestration wiring is Phase 2.2) — registration is additive and
 * independent of the workflow.
 */

import { aggregateFindings } from "../activities/aggregate_findings.activity.js";
import { classifyFiles } from "../activities/classify_files.activity.js";
import { computePolicyRules } from "../activities/compute_policy_rules.activity.js";
import { loadRepoConfigActivity } from "../activities/load_repo_config.activity.js";
import { persistReviewFindings } from "../activities/persist_review_findings.activity.js";
import { postCheckRun } from "../activities/post_check_run.activity.js";

/** The activities map the worker registers. Grown additively in Phase 2.1. */
export const activities = {
  persistReviewFindings,
  aggregateFindings,
  classifyFiles,
  loadRepoConfigActivity,
  computePolicyRules,
  postCheckRun,
};
