/**
 * Integration test for the run-state lifecycle activities — REAL de-stubbed ports of the frozen Python
 * `@activity.defn` record_review_lifecycle_event_activity / finalize_review_run_activity /
 * record_run_failed_activity / record_run_cancelled_activity
 * (vendor/codemaster-py/codemaster/activities/record_review_lifecycle.py), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. The suite runs SERIALLY; every test
 * uses a UNIQUE installation_id / run_id / review_id so tenant-scoped rows never collide.
 *
 * Each activity is injected a disposable-PG `db` + a FakeClock + a fresh PendingEmits (production resolves
 * the db from CODEMASTER_PG_CORE_DSN via the ADR-0062 shared pool + drives its own PendingEmits). The
 * tests assert the on-disk state machine + idempotency:
 *
 *   record_review_lifecycle_event_activity:
 *     - emits one ANALYSIS_STARTED / ANALYZED audit.workflow_events row.
 *     - idempotent on the SAME (run_id, event_type) — a 2nd call is a no-op (no duplicate row).
 *     - rejects an event_type outside {ANALYSIS_STARTED, ANALYZED}.
 *   finalize_review_run_activity:
 *     - moves review_runs RUNNING → COMPLETED; idempotent on the 2nd call (no zombie RUNNING).
 *     - raises StateDrift on an illegal transition (current CANCELLED).
 *   record_run_failed_activity:    RUNNING → FAILED; idempotent.
 *   record_run_cancelled_activity: RUNNING → CANCELLED; idempotent.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  finalizeReviewRun,
  recordReviewLifecycleEvent,
  recordRunCancelled,
  recordRunFailed,
} from "#backend/activities/record_review_lifecycle.activity.js";
import { StateDrift } from "#backend/domain/transition_run.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import {
  FinalizeReviewRunInput,
  RecordReviewLifecycleEventInput,
  RecordRunCancelledInput,
  RecordRunFailedInput,
} from "#contracts/record_review_lifecycle_inputs.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// 2099 routes every emitted event into the audit.workflow_events_default partition (no 2099 range).
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
});

afterAll(async () => {
  await db?.destroy();
});

/** Deterministic-enough RFC4122 v4 UUID for test fixtures (NOT security-sensitive). */
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  reviewId: string;
  runId: string;
  repoId: number;
};

/** Seed the FK + BF-9 JOIN chain (installations → repositories → pull_request_reviews → review_runs). */
async function seedTenant(lifecycleState = "RUNNING"): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const runId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;
  const githubInstallationId = uniqueBigint();

  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, 'octo', 'Organization')`,
    [installationId, githubInstallationId],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, 'main', true)`,
    [installationId, repoId, `octo/repo-${repoId}`],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  // AD-7 biconditional CHECKs require the terminal timestamp present when seeding a terminal state, so
  // stamp the matching column (completed_at / failed_at / cancelled_at) when the seed state is terminal.
  const terminalCol: Record<string, string | undefined> = {
    COMPLETED: "completed_at",
    FAILED: "failed_at",
    CANCELLED: "cancelled_at",
  };
  const tcol = terminalCol[lifecycleState];
  if (tcol === undefined) {
    await pool.query(
      `INSERT INTO core.review_runs
         (run_id, review_id, trigger_type, lifecycle_state)
       VALUES ($1, $2, 'pr_opened', $3)`,
      [runId, reviewId, lifecycleState],
    );
  } else {
    await pool.query(
      `INSERT INTO core.review_runs
         (run_id, review_id, trigger_type, lifecycle_state, ${tcol})
       VALUES ($1, $2, 'pr_opened', $3, now())`,
      [runId, reviewId, lifecycleState],
    );
  }
  return { installationId, reviewId, runId, repoId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
  await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [seed.repoId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

async function runState(runId: string): Promise<string> {
  const r = await pool.query<{ lifecycle_state: string }>(
    `SELECT lifecycle_state FROM core.review_runs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0]!.lifecycle_state;
}

async function countEvents(runId: string, eventType?: string): Promise<number> {
  const q =
    eventType === undefined
      ? await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
          [runId],
        )
      : await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1 AND event_type = $2`,
          [runId, eventType],
        );
  return Number(q.rows[0]?.n);
}

/** Widen the schema-typed test engine to the schema-agnostic Kysely<unknown> the activities accept. */
function injectedDb(): Kysely<unknown> {
  return db as unknown as Kysely<unknown>;
}

describeDb("record_review_lifecycle activities (integration, disposable PG)", () => {
  it("recordReviewLifecycleEvent emits ANALYZED once and is idempotent on retry", async () => {
    const seed = await seedTenant();
    try {
      const req = RecordReviewLifecycleEventInput.parse({
        installation_id: seed.installationId,
        run_id: seed.runId,
        review_id: seed.reviewId,
        event_type: "ANALYZED",
        payload: { findings_count: 5 },
      });

      await recordReviewLifecycleEvent(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await countEvents(seed.runId, "ANALYZED")).toBe(1);

      const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(events.rows[0]!.payload).toEqual({ findings_count: 5 });

      // Temporal at-least-once retry: a second call is a no-op (the pre-INSERT SELECT short-circuits).
      await recordReviewLifecycleEvent(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await countEvents(seed.runId, "ANALYZED")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordReviewLifecycleEvent emits ANALYSIS_STARTED + ANALYZED as distinct rows", async () => {
    const seed = await seedTenant();
    try {
      await recordReviewLifecycleEvent(
        RecordReviewLifecycleEventInput.parse({
          installation_id: seed.installationId,
          run_id: seed.runId,
          review_id: seed.reviewId,
          event_type: "ANALYSIS_STARTED",
        }),
        { db: injectedDb(), clock: FIXED_CLOCK },
      );
      await recordReviewLifecycleEvent(
        RecordReviewLifecycleEventInput.parse({
          installation_id: seed.installationId,
          run_id: seed.runId,
          review_id: seed.reviewId,
          event_type: "ANALYZED",
        }),
        { db: injectedDb(), clock: FIXED_CLOCK },
      );
      expect(await countEvents(seed.runId, "ANALYSIS_STARTED")).toBe(1);
      expect(await countEvents(seed.runId, "ANALYZED")).toBe(1);
      expect(await countEvents(seed.runId)).toBe(2);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordReviewLifecycleEvent rejects an event_type outside the granular allow-list", async () => {
    const seed = await seedTenant();
    try {
      const req = RecordReviewLifecycleEventInput.parse({
        installation_id: seed.installationId,
        run_id: seed.runId,
        review_id: seed.reviewId,
        event_type: "FINDINGS_PERSISTED",
      });
      await expect(
        recordReviewLifecycleEvent(req, { db: injectedDb(), clock: FIXED_CLOCK }),
      ).rejects.toThrow(/not allowed via this path/);
      // No row was emitted.
      expect(await countEvents(seed.runId)).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("finalizeReviewRun moves RUNNING → COMPLETED and is idempotent on retry", async () => {
    const seed = await seedTenant("RUNNING");
    try {
      const req = FinalizeReviewRunInput.parse({
        run_id: seed.runId,
        review_id: seed.reviewId,
        attempt: 1,
        duration_ms: 1234,
        worker_id: "worker-5",
      });
      await finalizeReviewRun(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await runState(seed.runId)).toBe("COMPLETED");
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);

      // Idempotent retry: no zombie RUNNING, no duplicate event.
      await finalizeReviewRun(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await runState(seed.runId)).toBe("COMPLETED");
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("finalizeReviewRun raises StateDrift when the run drifted to CANCELLED", async () => {
    const seed = await seedTenant("CANCELLED");
    try {
      const req = FinalizeReviewRunInput.parse({ run_id: seed.runId, review_id: seed.reviewId });
      await expect(
        finalizeReviewRun(req, { db: injectedDb(), clock: FIXED_CLOCK }),
      ).rejects.toBeInstanceOf(StateDrift);
      // Still CANCELLED (unchanged by the failed transition).
      expect(await runState(seed.runId)).toBe("CANCELLED");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordRunFailed moves RUNNING → FAILED and is idempotent on retry", async () => {
    const seed = await seedTenant("RUNNING");
    try {
      const req = RecordRunFailedInput.parse({
        run_id: seed.runId,
        review_id: seed.reviewId,
        reason: "ValueError: boom",
        attempt: 2,
      });
      await recordRunFailed(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await runState(seed.runId)).toBe("FAILED");
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);

      await recordRunFailed(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await runState(seed.runId)).toBe("FAILED");
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordRunCancelled moves RUNNING → CANCELLED and is idempotent on retry", async () => {
    const seed = await seedTenant("RUNNING");
    try {
      const req = RecordRunCancelledInput.parse({
        run_id: seed.runId,
        review_id: seed.reviewId,
        reason: "temporal_cancellation",
      });
      await recordRunCancelled(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await runState(seed.runId)).toBe("CANCELLED");
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);

      await recordRunCancelled(req, { db: injectedDb(), clock: FIXED_CLOCK });
      expect(await runState(seed.runId)).toBe("CANCELLED");
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });
});
