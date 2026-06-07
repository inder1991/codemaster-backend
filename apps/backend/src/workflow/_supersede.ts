// supersedeRun — the atomic SERIAL+SUPERSEDE cancel primitive (AD-5 Layer 1; 1:1 with the frozen Python
// codemaster/workflow/_supersede.py). Cancels the active run on a review, emits RUN_SUPERSEDED for the old
// run, and returns the lineage. INSERT-free so non-allocator callers (operator-cancel, drain) can reuse it.

import { type Kysely, sql } from "kysely";

import { assertOpenTransaction } from "#backend/domain/tx_guard.js";
import { emitWorkflowEvent } from "#backend/ingest/_workflow_events_repository.js";
import { CrossInstallationViolation, RepositoriesResolveFailed } from "#backend/workspace/errors.js";

import { type Clock, WallClock } from "#platform/clock.js";

/** AD-5 cancellation reasons (1:1 with domain/models/review_run.py::CANCEL_REASONS). */
export const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "superseded",
  "operator_cancelled",
  "timeout",
  "repository_disabled",
  "installation_suspended",
  "shutdown",
]);

export type SupersedeOutcome = { oldRunId: string | null; wasSupersede: boolean };

export async function supersedeRun(
  db: Kysely<unknown>,
  args: {
    reviewId: string;
    newRunId: string;
    provider: string;
    cancelReason?: string;
    expectedInstallationId?: string;
    clock?: Clock;
  },
): Promise<SupersedeOutcome> {
  const cancelReason = args.cancelReason ?? "superseded";
  if (!CANCEL_REASONS.has(cancelReason)) {
    throw new Error(`supersedeRun: cancel_reason=${cancelReason} is not in CANCEL_REASONS`);
  }
  assertOpenTransaction(db, "supersedeRun");
  const clock = args.clock ?? new WallClock();

  // BF-9 SELECT — MANDATORY (resolves installation_id for the RUN_SUPERSEDED emit's tenancy attribution),
  // NOT gated on expectedInstallationId. FOR UPDATE OF prr pins the review row + serializes vs concurrent
  // flips. Fail-closed: a missing repositories row / NULL installation_id → RepositoriesResolveFailed.
  const v = await sql<{ installation_id: string | null }>`
    SELECT r.installation_id FROM core.pull_request_reviews prr
      JOIN core.repositories r ON r.github_repo_id = prr.repo_id
     WHERE prr.review_id = ${args.reviewId}
       FOR UPDATE OF prr
  `.execute(db);
  const actualInstallationId = v.rows[0]?.installation_id ?? null;
  if (actualInstallationId === null) {
    throw new RepositoriesResolveFailed(
      `supersedeRun: cannot resolve core.repositories.installation_id for review_id=${args.reviewId} ` +
        `(missing repositories row or NULL installation_id — data-integrity break).`,
    );
  }
  if (args.expectedInstallationId === undefined) {
    console.warn(
      JSON.stringify({ event: "cross_installation.supersede_run_without_expected", review_id: args.reviewId }),
    );
  } else if (actualInstallationId !== args.expectedInstallationId) {
    throw new CrossInstallationViolation({
      primitive: "supersede_run",
      keyKind: "review_id",
      keyValue: args.reviewId,
      expectedInstallationId: args.expectedInstallationId,
      actualInstallationId,
    });
  }

  // Step 1: optimistic cancel UPDATE. The WHERE lifecycle_state IN (active) is the guard — concurrent
  // supersedes both observe an active run, only one returns a row. cancelled_at + state flip in one UPDATE
  // (AD-7 inverse CHECK never sees a mid-transition row).
  const r = await sql<{ run_id: string }>`
    UPDATE core.review_runs
       SET lifecycle_state = 'CANCELLED', cancelled_at = ${clock.now()},
           cancel_reason = ${cancelReason}, superseded_by_run_id = ${args.newRunId}
     WHERE review_id = ${args.reviewId}
       AND lifecycle_state IN ('PENDING', 'RUNNING', 'WAITING_RETRY')
     RETURNING run_id
  `.execute(db);
  const oldRunId = r.rows[0]?.run_id ?? null;
  const wasSupersede = oldRunId !== null;

  // Step 2: emit RUN_SUPERSEDED for the OLD run — strictly on the supersede-happened branch.
  if (wasSupersede && oldRunId !== null) {
    await emitWorkflowEvent({
      dbOrTx: db,
      provider: args.provider,
      runId: oldRunId,
      reviewId: args.reviewId,
      eventType: "RUN_SUPERSEDED",
      payload: { new_run_id: args.newRunId, reason: cancelReason },
      deliveryId: null,
      installationId: actualInstallationId,
      clock,
    });
    // SEAM (OTel — DEFER): the AD-5 _runs_cancelled / _runs_draining counters slot in here when the
    // post-commit OTel emit surface is wired (matching the transition_run CANCELLED branch).
  }

  return { oldRunId, wasSupersede };
}
