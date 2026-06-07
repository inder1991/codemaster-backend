/**
 * `applyArbitration` activity — 1:1 in intent with the frozen Python
 * `@activity.defn apply_arbitration_activity`
 * (`vendor/codemaster-py/codemaster/review/arbitration_apply_activity.py::ArbitrationApplyActivity.apply_arbitration_activity`).
 *
 * Runs the PURE {@link arbitrate} core over the in-memory inputs, then fans the resulting
 * {@link ArbitrationResultV1} out into durable persistence via {@link applyArbitration} (Tier-1 INSERTs,
 * Tier-2 UPDATEs, rejection rows). Returns the result so the workflow-body walkthrough-footer renderer can
 * fold suppressed-finding counts + tool-degradation notes (the footer wiring is a Workflow-phase concern,
 * out of scope here).
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Runs in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. Real I/O (the `pg.Pool` the repos
 * open through the ADR-0062 shared seam) + the policy load live here. `arbitrate` itself is pure and could
 * run in either context, but its caller is the activity.
 *
 * ## Inputs (CLAUDE.md invariant 11 — single typed positional input)
 *
 * The single positional input is an {@link ApplyArbitrationInputV1}. Notable wire shapes:
 *   - `tier2_findings` — the LIST-OF-PAIRS `[uuid, ReviewFindingV1][]` (JSON-safe; NOT a UUID-keyed dict).
 *   - `tier2_review_finding_id_by_arbitration_id` — `Record<string, string>` (STRING keys → uuid values):
 *     the JSON-safe shape the frozen Python adopted (`dict[str, uuid.UUID]`) after smoke #10 crashed on a
 *     `dict[UUID, UUID]` at the Temporal payload boundary. The keys are already strings; this activity
 *     passes the map straight into `applyArbitration` (no `uuid.UUID(k)` reconstruction is needed in TS —
 *     the map key + value are both wire strings, used directly as the `arbitration_id → review_finding_id`
 *     lookup).
 *   - `now` — the ISO instant the workflow sourced from `workflow.now()`; written onto SUPPRESSED_BY_LLM
 *     decisions' `suppressed_at`.
 *
 * ## Persistence wiring
 *
 * `installation_id` is carried on every repo write (tenancy). The findings repo records `created_at` from an
 * injected {@link Clock} (the bundled-default {@link WallClock}, or a {@link FakeClock} pinned at
 * `CODEMASTER_FAKE_CLOCK_ISO` for a deterministic dual-run — same seam as persist_review_findings.activity).
 * The decisions' OWN `suppressed_at` / `suppression_model` columns are independent of that clock.
 *
 * ## Idempotency
 *
 * Inherited from the repos: Tier-1 `ON CONFLICT (review_finding_id) DO NOTHING`, Tier-2 UPDATE is naturally
 * idempotent, rejections `ON CONFLICT (run_id, target_finding_id, reason_rejected) DO NOTHING`. A Temporal
 * retry re-firing this activity produces ZERO row drift.
 *
 * ## DSN
 *
 * Read from `CODEMASTER_PG_CORE_DSN`; both repos route it through the ADR-0062 process-shared single pool.
 */

import { PostgresReviewFindingsRepo, tenantKyselyForDsn } from "#backend/domain/repos/review_findings_repo.js";
import { ArbitrationRejectionsRepo } from "#backend/domain/repos/arbitration_rejections_repo.js";

import { arbitrate } from "#backend/review/arbitration/arbitrate.js";
import { applyArbitration } from "#backend/review/arbitration/arbitration_apply.js";
import { loadBundledPolicy } from "#backend/review/arbitration/suppression_policy.js";

import { FakeClock, WallClock, type Clock } from "#platform/clock.js";

import type { ApplyArbitrationInputV1 } from "#contracts/apply_arbitration_input.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";

/**
 * Resolve the {@link Clock} seam: a {@link FakeClock} pinned at `CODEMASTER_FAKE_CLOCK_ISO` when that env var
 * is a parseable ISO instant (deterministic `created_at` for a dual-run), else a {@link WallClock}. An
 * unparseable value throws loudly rather than silently degrading to wall-clock non-determinism. Static
 * `process.env.X` access (no dynamic indexing). Mirrors persist_review_findings.activity.ts.
 */
function resolveClock(): Clock {
  const iso = process.env.CODEMASTER_FAKE_CLOCK_ISO;
  if (iso === undefined || iso === "") {
    return new WallClock();
  }
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      `CODEMASTER_FAKE_CLOCK_ISO=${JSON.stringify(iso)} is not a parseable ISO-8601 instant`,
    );
  }
  return new FakeClock({ now: instant });
}

/**
 * Run the arbitration layer + persist its decisions. Returns the {@link ArbitrationResultV1} (the workflow
 * body folds it into the walkthrough footer).
 *
 * Composition: `arbitrate(...)` is pure (the injected policy + the caller-supplied `now`); the returned
 * result is handed to `applyArbitration(...)` which fans out into the repos. The bundled suppression policy
 * is loaded per-call (the load is a cheap parse of an in-module literal; no I/O), mirroring the Python's
 * injected `SuppressionPolicy`.
 */
export async function applyArbitrationActivity(
  input: ApplyArbitrationInputV1,
): Promise<ArbitrationResultV1> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot construct the arbitration repos");
  }

  const policy = loadBundledPolicy();

  const result = arbitrate({
    tier1Findings: input.tier1_findings,
    tier2Findings: input.tier2_findings,
    intents: input.intents,
    policy,
    model: input.model,
    promptVersion: input.prompt_version,
    now: input.now,
  });

  const db = tenantKyselyForDsn(dsn);
  const findingsRepo = new PostgresReviewFindingsRepo({ db, clock: resolveClock() });
  const rejectionsRepo = ArbitrationRejectionsRepo.fromDsn(dsn);

  await applyArbitration({
    findingsRepo,
    rejectionsRepo,
    installationId: input.installation_id,
    prId: input.pr_id,
    runId: input.run_id,
    reviewId: input.review_id,
    result,
    tier1Findings: input.tier1_findings,
    tier2ReviewFindingIdByArbitrationId: input.tier2_review_finding_id_by_arbitration_id,
    suppressionModel: input.model,
    suppressionPromptVersion: input.prompt_version,
  });

  return result;
}
