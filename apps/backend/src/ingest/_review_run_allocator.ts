// allocateRun — the atomic SERIAL+SUPERSEDE allocator for core.review_runs (AD-2; 1:1 with the frozen
// Python codemaster/ingest/_review_run_allocator.py). Composes 4 steps inside the caller's transaction:
// supersede the active run → INSERT the new PENDING run (uuid7) → flip current_run_id → emit
// WEBHOOK_RECEIVED. The caller MUST already be in an open transaction.

import { type Kysely, sql } from "kysely";

import { assertOpenTransaction } from "#backend/domain/tx_guard.js";
import { flipCurrentRun } from "#backend/ingest/_reviews_repository.js";
import { emitWorkflowEvent } from "#backend/ingest/_workflow_events_repository.js";
import { supersedeRun } from "#backend/workflow/_supersede.js";

import { type Clock, WallClock } from "#platform/clock.js";
import { uuid7 } from "#platform/randomness.js";

/** Allowed review-run trigger types (1:1 with domain/models/review_run.py::TRIGGER_TYPES). */
export const TRIGGER_TYPES: ReadonlySet<string> = new Set([
  "pr_opened",
  "pr_synchronize",
  "manual_rerun",
  "comment_trigger",
  "retry",
  "scheduled",
]);

export type AllocationOutcome = {
  newRunId: string;
  supersededRunId: string | null;
  wasSupersede: boolean;
};

export async function allocateRun(
  db: Kysely<unknown>,
  args: {
    reviewId: string;
    installationId: string;
    triggerType: string;
    triggeredBy: string | null;
    provider: string;
    deliveryId: string | null;
    clock?: Clock;
    parentRunId?: string | null;
    attemptNumber?: number;
  },
): Promise<AllocationOutcome> {
  const attemptNumber = args.attemptNumber ?? 1;
  const parentRunId = args.parentRunId ?? null;
  if (!TRIGGER_TYPES.has(args.triggerType)) {
    throw new Error(`allocateRun: trigger_type=${args.triggerType} is not in TRIGGER_TYPES`);
  }
  if (attemptNumber > 1 && parentRunId === null) {
    throw new Error(
      `allocateRun: parent_run_id must be non-null when attempt_number > 1 (got ${attemptNumber}) — AD-6`,
    );
  }
  assertOpenTransaction(db, "allocateRun");
  const clock = args.clock ?? new WallClock();
  const newRunId = uuid7({ clock });

  // Step 1: optimistic supersede (skipped on retry — AD-6 parent_run_id XOR supersedes_run_id).
  let supersededRunId: string | null = null;
  if (parentRunId === null) {
    const outcome = await supersedeRun(db, {
      reviewId: args.reviewId,
      newRunId,
      provider: args.provider,
      cancelReason: "superseded",
      clock,
    });
    supersededRunId = outcome.oldRunId;
  }
  const wasSupersede = supersededRunId !== null;

  // Step 2: INSERT the new PENDING run.
  await sql`
    INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, triggered_by, attempt_number, lifecycle_state,
       parent_run_id, supersedes_run_id, started_at, created_at)
    VALUES (${newRunId}, ${args.reviewId}, ${args.triggerType}, ${args.triggeredBy}, ${attemptNumber},
            'PENDING', ${parentRunId}, ${supersededRunId}, now(), now())
  `.execute(db);

  // Step 3: flip the authoritative pointer. The optimistic guard fires only when a supersede happened
  // (current_run_id MUST equal supersededRunId then); fresh/retry → null guard (skip).
  await flipCurrentRun(db, {
    reviewId: args.reviewId,
    newRunId,
    oldRunIdExpected: wasSupersede ? supersededRunId : null,
  });

  // Step 4: emit WEBHOOK_RECEIVED for the new run (only when a provider delivery key is present).
  if (args.deliveryId !== null) {
    await emitWorkflowEvent({
      dbOrTx: db,
      provider: args.provider,
      runId: newRunId,
      reviewId: args.reviewId,
      eventType: "WEBHOOK_RECEIVED",
      payload: { trigger_type: args.triggerType, attempt_number: attemptNumber },
      deliveryId: args.deliveryId,
      installationId: args.installationId,
      clock,
    });
  }

  return { newRunId, supersededRunId, wasSupersede };
}
