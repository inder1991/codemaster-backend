// load_parent_review_findings_activity (#6 — carry-forward parent loader). ENHANCEMENT beyond the frozen
// Python, which passed parent_findings=() / parent_review_id=None at the orchestrate() call. Loads the
// findings currently LIVE on the PR (delivered + not suppressed) so the orchestrator's selectCarryForward
// can carry forward the ones on UNCHANGED lines — avoiding a full re-review/re-post every sync.
//
// No schema migration needed (deep-dive 2026-06-06): review_finding_id is content-addressed +
// ON CONFLICT DO NOTHING, so core.review_findings already holds one content-deduplicated row per logical
// finding per PR, and the loader runs BEFORE the current run persists. parent_review_id = the PR's
// review_id (per-PR; pure provenance in select_carry_forward).
//
// Gated default-OFF behind the CODEMASTER_CARRY_FORWARD_ENABLED env flag (read in this activity, so it
// is operator-flippable + replay-safe) until the EXPLAIN/A-B validation the Python S22.DM.18 deferral
// required is done. The workflow ALWAYS dispatches this activity; when the flag is off it short-circuits
// to the empty parent set before any DB read, so the disabled path adds only a no-op activity round-trip.
//
// DSN: CODEMASTER_PG_CORE_DSN, routed through the ADR-0062 process-shared single pool.

import { PostgresReviewFindingsRepo, tenantKyselyForDsn } from "#backend/domain/repos/review_findings_repo.js";

import { FakeClock, WallClock, type Clock } from "#platform/clock.js";

import {
  LoadParentReviewFindingsResultV1,
  type LoadParentReviewFindingsInputV1,
} from "#contracts/load_parent_review_findings.v1.js";

/**
 * Resolve the {@link Clock} seam: a {@link FakeClock} pinned at `CODEMASTER_FAKE_CLOCK_ISO` when that env
 * var is a parseable ISO instant (dual-run determinism), else a {@link WallClock}. (The read path does not
 * read the clock; the repo constructor requires one.) Mirrors apply_arbitration.activity.ts.
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
 * Load the PR's currently-live findings as the carry-forward parent set. Returns
 * `parent_review_id = input.review_id` when there ARE live findings, else null (the selector's None path).
 */
export async function loadParentReviewFindingsActivity(
  input: LoadParentReviewFindingsInputV1,
): Promise<LoadParentReviewFindingsResultV1> {
  // Carry-forward rollout flag (default OFF) — CODEMASTER_CARRY_FORWARD_ENABLED. Operator-flippable via
  // env + worker restart, and replay-safe BECAUSE it is read here in the activity (Node), NOT in the
  // workflow sandbox (1:1 with the CODEMASTER_LIFECYCLE_WRITES_ENABLED pattern). Until the EXPLAIN/A-B
  // validation the Python S22.DM.18 deferral required is done, carry-forward stays disabled and this
  // short-circuits to the empty parent set (the Python parent_findings=() / parent_review_id=None
  // behavior) BEFORE the DSN read — no DB, zero hot-path cost.
  if ((process.env.CODEMASTER_CARRY_FORWARD_ENABLED ?? "false").toLowerCase() !== "true") {
    return LoadParentReviewFindingsResultV1.parse({ parent_review_id: null, parent_findings: [] });
  }

  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot load parent review findings");
  }

  const db = tenantKyselyForDsn(dsn);
  const repo = new PostgresReviewFindingsRepo({ db, clock: resolveClock() });
  const parentFindings = await repo.loadLiveFindingsForPr({
    installationId: input.installation_id,
    prId: input.pr_id,
  });

  return LoadParentReviewFindingsResultV1.parse({
    parent_review_id: parentFindings.length > 0 ? input.review_id : null,
    parent_findings: [...parentFindings],
  });
}
