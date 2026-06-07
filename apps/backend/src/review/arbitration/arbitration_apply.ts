/**
 * Arbitration persistence glue — 1:1 port of the frozen Python
 * `vendor/codemaster-py/codemaster/review/arbitration_apply.py::apply_arbitration` (Phase D Task D.7).
 *
 * Turns the in-memory output of {@link arbitrate} into `core.review_findings` row writes (Tier-1 INSERT /
 * Tier-2 UPDATE, via the {@link ReviewFindingsArbitrationPort}) and `core.arbitration_rejections` row writes
 * (via the {@link ArbitrationRejectionsRepoPort}).
 *
 * Per-decision flow (1:1 with the Python):
 *
 *  1. **Tier-1 decision** (`finding_id` is in `tier1Findings`) → INSERT a new `core.review_findings` row
 *     carrying `tier=1`, `source_tool=<tool>`, the decision's suppression columns. Idempotent via
 *     `ON CONFLICT (review_finding_id) DO NOTHING` — the same Temporal replay produces the same
 *     `review_finding_id` (the caller passes `AnalysisFindingV1.finding_id` through, deterministic across
 *     the pipeline pass).
 *
 *  2. **Tier-2 decision** (`finding_id` is a KEY in `tier2ReviewFindingIdByArbitrationId`) → UPDATE the
 *     existing row's suppression metadata. The row was INSERTed earlier in the pipeline by
 *     `persistReviewFindings`. The map is `arbitration_id (string) → review_finding_id (uuid string)`.
 *
 *  3. **Neither** → DEFENSIVELY skipped with a WARN log. The orchestrator should never produce such a
 *     decision; the skip is a belt-and-braces guard for a future bug.
 *
 * After the decisions, every {@link RejectedIntent} the policy refused writes a durable audit row to
 * `core.arbitration_rejections` (closes the smoke-#18 observability gap). Idempotent via the repo's
 * `ON CONFLICT (run_id, target_finding_id, reason_rejected) DO NOTHING`.
 *
 * ## Suppressed-at conversion
 *
 * A SUPPRESSED_* decision carries `suppressed_at` as the ISO string the arbitration layer wrote (from the
 * caller's `now`). The findings repo's setters take a `Date | null` (the `timestamptz` column binds a JS
 * `Date`), so the ISO string is parsed to a `Date` here (a KNOWN instant — outside the clock/random gate).
 * A NONE decision carries `suppressed_at: null` → `null`.
 *
 * ## suppression_model / suppression_prompt_version
 *
 * Mirrors the Python signature: `suppressionModel` / `suppressionPromptVersion` are threaded into the
 * REJECTION rows (provenance), NOT re-derived. The DECISION rows carry the decision's OWN
 * suppression_model / suppression_prompt_version (already populated by the arbitration layer for the
 * SUPPRESSED_BY_LLM path; null for NONE).
 */

import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";
import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";

import type { ArbitrationRejectionsRepoPort } from "#backend/domain/repos/arbitration_rejections_repo.js";

/**
 * The subset of the review-findings repo the arbitration-apply path needs (the two Phase-D setters). The
 * `PostgresReviewFindingsRepo` satisfies this structurally; a fake satisfies it for unit tests.
 */
export type ReviewFindingsArbitrationPort = {
  insertTier1Finding(args: {
    installationId: string;
    prId: string;
    reviewFindingId: string;
    file: string;
    startLine: number;
    endLine: number;
    tool: string;
    ruleId: string;
    suppressionState: string;
    suppressionReason: string | null;
    suppressionConfidence: number | null;
    suppressionModel: string | null;
    suppressionPromptVersion: string | null;
    suppressedAt: Date | null;
  }): Promise<void>;
  updateTier2Arbitration(args: {
    installationId: string;
    reviewFindingId: string;
    suppressionState: string;
    suppressionReason: string | null;
    suppressionConfidence: number | null;
    suppressionModel: string | null;
    suppressionPromptVersion: string | null;
    suppressedAt: Date | null;
  }): Promise<void>;
};

/** Anything satisfying `.warning(msg)` — the Temporal workflow logger qualifies; a console adapter is the
 *  default sink (Node's `console` exposes `.warn`, not `.warning`, so the default adapts it). */
export type ApplyLogger = {
  warning(msg: string): void;
};

/** Default WARN sink — adapts Node's `console.warn` to the `.warning(msg)` shape. */
const CONSOLE_LOGGER: ApplyLogger = {
  warning: (msg: string): void => {
    console.warn(msg);
  },
};

/**
 * Persist an {@link ArbitrationResultV1} to `core.review_findings` (+ `core.arbitration_rejections`). 1:1
 * with the frozen Python `apply_arbitration`.
 *
 * `tier2ReviewFindingIdByArbitrationId` is the reconstructed `arbitration_id → review_finding_id` map (the
 * activity rebuilds it from the JSON-safe `Record<string, string>` wire shape). `suppressedAt` strings on
 * the decisions are parsed to `Date`s; `suppression_confidence` strings are parsed to `number`s for the
 * repo's `numeric` columns (the column ingests the float; provenance precision lives on the rejection rows).
 */
export async function applyArbitration(args: {
  findingsRepo: ReviewFindingsArbitrationPort;
  rejectionsRepo: ArbitrationRejectionsRepoPort;
  installationId: string;
  prId: string;
  runId: string;
  reviewId: string;
  result: ArbitrationResultV1;
  tier1Findings: ReadonlyArray<AnalysisFindingV1>;
  tier2ReviewFindingIdByArbitrationId: Readonly<Record<string, string>>;
  suppressionModel: string | null;
  suppressionPromptVersion: string | null;
  logger?: ApplyLogger;
}): Promise<void> {
  const {
    findingsRepo,
    rejectionsRepo,
    installationId,
    prId,
    runId,
    reviewId,
    result,
    tier1Findings,
    tier2ReviewFindingIdByArbitrationId,
    suppressionModel,
    suppressionPromptVersion,
  } = args;
  const logger: ApplyLogger = args.logger ?? CONSOLE_LOGGER;

  // Tier-1 index by finding_id — the Python `{f.finding_id: f for f in tier1_findings}`.
  const tier1ById = new Map<string, AnalysisFindingV1>(tier1Findings.map((f) => [f.finding_id, f]));

  for (const decision of result.decisions) {
    const suppressedAt =
      decision.suppressed_at === null ? null : new Date(decision.suppressed_at);
    const suppressionConfidence =
      decision.suppression_confidence === null ? null : Number(decision.suppression_confidence);

    const t1 = tier1ById.get(decision.finding_id);
    if (t1 !== undefined) {
      await findingsRepo.insertTier1Finding({
        installationId,
        prId,
        reviewFindingId: decision.finding_id,
        file: t1.file,
        startLine: t1.start_line,
        endLine: t1.end_line,
        tool: t1.tool,
        ruleId: t1.rule_id,
        suppressionState: decision.suppression_state,
        suppressionReason: decision.suppression_reason,
        suppressionConfidence,
        suppressionModel: decision.suppression_model,
        suppressionPromptVersion: decision.suppression_prompt_version,
        suppressedAt,
      });
      continue;
    }
    // Tier-2 decision: finding_id is an arbitration_id KEY in the map (→ the persisted review_finding_id).
    if (Object.hasOwn(tier2ReviewFindingIdByArbitrationId, decision.finding_id)) {
      const rfid = tier2ReviewFindingIdByArbitrationId[decision.finding_id];
      if (rfid !== undefined) {
        await findingsRepo.updateTier2Arbitration({
          installationId,
          reviewFindingId: rfid,
          suppressionState: decision.suppression_state,
          suppressionReason: decision.suppression_reason,
          suppressionConfidence,
          suppressionModel: decision.suppression_model,
          suppressionPromptVersion: decision.suppression_prompt_version,
          suppressedAt,
        });
        continue;
      }
    }
    // Neither Tier-1 nor Tier-2 — defensive skip with a WARN (the orchestrator should never produce this).
    logger.warning(
      `apply_arbitration: skipping decision with unmapped finding_id ` +
        `finding_id=${decision.finding_id} suppression_state=${decision.suppression_state}`,
    );
  }

  // Persist the rejected-intent channel. Idempotent via ON CONFLICT (run_id, target_finding_id,
  // reason_rejected) DO NOTHING so Temporal retries are absorbed.
  for (const rejection of result.rejected_intents) {
    await rejectionsRepo.insertRejection({
      installationId,
      runId,
      reviewId,
      targetFindingId: rejection.target_finding_id,
      reasonRejected: rejection.reason_rejected,
      // Canonical-decimal string (or null) — bound losslessly into the `numeric` column.
      intentConfidence: rejection.intent_confidence,
      intentReason: rejection.intent_reason,
      suppressionModel,
      suppressionPromptVersion,
    });
  }
}
