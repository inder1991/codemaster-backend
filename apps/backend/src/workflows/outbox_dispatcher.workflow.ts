// OutboxDispatcherWorkflow — the singleton that drains core.outbox (1:1 with the frozen Python
// codemaster/workflows/outbox_dispatcher.py). ONE execution per Temporal namespace, started once at worker
// boot and re-claimed on pod restart (see ensureOutboxDispatcherSingleton in the boot wiring).
//
// ── Sandbox purity (ADR-0031) ──
// Runs in the Temporal V8-isolate workflow sandbox. It imports ONLY `@temporalio/workflow` (the
// sandbox-safe API) + TYPE-ONLY contract / repo-type imports (erased at emit under verbatimModuleSyntax —
// they pull NO runtime graph into the bundle). NO node:crypto, NO clock, NO RNG, NO DB. All durable state
// lives in `core.outbox`; the workflow holds nothing in memory across continue-as-new.

import { continueAsNew, isCancellation, log, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";

import type { OutboxRow } from "#backend/domain/repos/outbox_repo.js";
import type {
  ClaimPendingRowsInputV1,
  DispatchRowInputV1,
  MarkAttemptFailedInputV1,
  MarkDispatchedInputV1,
} from "#contracts/outbox_dispatch.v1.js";

// Loop tuning (1:1 with the Python module constants). DEFAULT_LEASE_SECONDS=10 is passed EXPLICITLY on
// every claim — it intentionally differs from the contract default (60); the heartbeat (when activated)
// re-extends to a 10s window, so a "simplification" that drops this would silently 6× the lease.
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_SECONDS = 10;
const DEFAULT_DRAIN_INTERVAL_SECONDS = 2;

// Retry curves, transcribed from the Python RetryPolicy(...) definitions (outbox_dispatcher.py:77-91).
const retryDb = {
  initialInterval: "200ms",
  maximumInterval: "10 seconds",
  maximumAttempts: 5,
  backoffCoefficient: 2,
};
const retryDispatch = {
  // Inline dispatch retries are bounded (2); the row's `attempts` column controls cross-restart retry.
  initialInterval: "200ms",
  maximumInterval: "2 seconds",
  maximumAttempts: 2,
  backoffCoefficient: 2,
};

// One proxyActivities() call per activity so each keeps its own timeout + retry curve (the codebase idiom —
// a single shared options object cannot express per-activity curves).
const { claimPendingRows } = proxyActivities<{
  claimPendingRows(input: ClaimPendingRowsInputV1): Promise<Array<OutboxRow>>;
}>({ startToCloseTimeout: "10 seconds", retry: retryDb });

const { dispatchRow } = proxyActivities<{ dispatchRow(input: DispatchRowInputV1): Promise<void> }>({
  startToCloseTimeout: "1 minute",
  retry: retryDispatch,
});

const { markDispatched } = proxyActivities<{ markDispatched(input: MarkDispatchedInputV1): Promise<void> }>({
  startToCloseTimeout: "10 seconds",
  retry: retryDb,
});

const { markAttemptFailed } = proxyActivities<{
  markAttemptFailed(input: MarkAttemptFailedInputV1): Promise<void>;
}>({ startToCloseTimeout: "10 seconds", retry: retryDb });

/**
 * The dispatcher loop. Claim a batch → dispatch + mark each row → idle when empty. continue-as-new BEFORE
 * each claim (never mid-drain) keeps history bounded. The function never returns under normal operation;
 * it ends only via continue-as-new (a fresh execution) or cancellation (worker shutdown).
 */
export async function OutboxDispatcherWorkflow(): Promise<void> {
  while (true) {
    // BF-12 — history boundary. Checked BEFORE claiming so the prior batch's per-row loop has fully drained
    // (every claimed row dispatched+marked or marked-failed). continue-as-new does NOT return — it transfers
    // to a fresh execution with the same workflowId + a fresh history; durable state is in core.outbox.
    if (workflowInfo().continueAsNewSuggested) {
      log.info(`outbox-dispatcher: continue_as_new triggered (history-length=${workflowInfo().historyLength})`);
      await continueAsNew();
    }

    const rows = await claimPendingRows({ batch_size: DEFAULT_BATCH_SIZE, lease_seconds: DEFAULT_LEASE_SECONDS });

    if (rows.length === 0) {
      // Idle wait via the durable workflow timer `sleep` (deterministic; survives worker restarts) — never
      // a raw JS timer, which the sandbox forbids and replay cannot reproduce.
      await sleep(DEFAULT_DRAIN_INTERVAL_SECONDS * 1000);
      continue;
    }

    // Busy-loop on success: drain the batch then immediately re-claim (no sleep between dispatch + re-claim).
    for (const row of rows) {
      try {
        await dispatchRow({
          schema_version: 2,
          row_id: row.id,
          sink: row.sink,
          payload: row.payload,
          trace_context: row.traceContext as Record<string, string>,
          run_id: row.runId,
          review_id: row.reviewId,
          provider: row.provider,
          installation_id: row.installationId,
          // Tagged-union: a null installation_id MUST carry orphan_reason='bootstrap_sink' (the DispatchRow
          // contract validator). Review-causal rows always have a UUID installation_id → orphan_reason null.
          orphan_reason: row.installationId === null ? "bootstrap_sink" : null,
        });
        await markDispatched({ row_id: row.id });
      } catch (e) {
        // Cancellation (worker shutdown) is NOT a dispatch failure — re-propagate so it isn't recorded as an
        // attempt (1:1 with Python's `except Exception` skipping the BaseException CancelledError).
        if (isCancellation(e)) {
          throw e;
        }
        // mark_attempt_failed atomically dead-letters at the threshold; expected_attempts=row.attempts (the
        // pre-attempt snapshot from claimPendingRows) makes a Temporal redrive a no-op (R-6).
        await markAttemptFailed({
          row_id: row.id,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 1024),
          expected_attempts: row.attempts,
        });
      }
    }
  }
}
