// Composition root for the OutboxDispatcherWorkflow's activities — the dispatcher's analogue of
// build_activities.ts (1:1 with the Python `outbox.configure(session_factory=..., clock=...,
// max_attempts=...)` call at worker boot). Constructs the repo + clock + the dispatcher's own cached
// Kysely (ADR-0062 single cached engine via tenantKysely) and returns the 4 arrow-property activities,
// keyed by the names the workflow's proxyActivities() expects.

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";

import { tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

/** The dead-letter threshold (Python configure() default max_attempts=5); env-overridable for ops tuning. */
const OUTBOX_MAX_ATTEMPTS = Number(process.env["CODEMASTER_OUTBOX_MAX_ATTEMPTS"] ?? "5");

/** Read the canonical core-store DSN, fail-loud when unset (mirrors build_activities.ts::requireCoreDsn). */
function requireCoreDsn(): string {
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; the outbox-dispatcher worker composition root cannot wire its " +
        "Postgres pool.",
    );
  }
  return dsn;
}

/**
 * Build the dispatcher's 4 activities, wired to real collaborators. Called once at worker boot (after the
 * env is populated) and passed to `Worker.create({ activities })`. The cast matches build_activities.ts —
 * the arrow-property methods are single-arg Temporal activity functions.
 */
export function buildOutboxActivities(): Record<string, (input: never) => Promise<unknown>> {
  const clock = new WallClock();
  const repo = new PostgresOutboxRepo({ clock });
  const db = tenantKysely(requireCoreDsn());
  const acts = new OutboxDispatchActivities({ repo, db, clock, maxAttempts: OUTBOX_MAX_ATTEMPTS });

  return {
    claimPendingRows: acts.claimPendingRows,
    dispatchRow: acts.dispatchRow,
    markDispatched: acts.markDispatched,
    markAttemptFailed: acts.markAttemptFailed,
  } as unknown as Record<string, (input: never) => Promise<unknown>>;
}
