/**
 * Integration test for the `transitionRun` lifecycle state-machine primitive (1:1 TS port of the frozen
 * Python `codemaster.workflow._lifecycle.transition_run`), against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green without a
 * DB. The suite runs SERIALLY; every test uses a UNIQUE installation_id / run_id / review_id so
 * tenant-scoped rows never collide.
 *
 * `core.review_runs` + `core.pull_request_reviews` + `core.repositories` ALREADY EXIST in the squashed
 * baseline. The BF-9 SELECT joins pull_request_reviews → repositories to resolve installation_id, so the
 * seed inserts the full chain (repositories row keyed on github_repo_id = pull_request_reviews.repo_id).
 *
 * Coverage:
 *   - RUNNING → COMPLETED = APPLIED: stamps completed_at + emits lifecycle_transition.
 *   - 2nd call RUNNING → COMPLETED (current already COMPLETED) = ALREADY_APPLIED: no zombie RUNNING, no
 *     duplicate event, no second completed_at stamp (idempotency — AD-8).
 *   - RUNNING → FAILED / RUNNING → CANCELLED stamp failed_at / cancelled_at + emit the event.
 *   - an illegal transition (current is COMPLETED, caller expects RUNNING → FAILED) raises StateDrift.
 *   - a missing run row raises StateDrift (actualState null).
 *   - validation: bad from_state / to_state / empty activity / attempt < 1 reject before any SQL.
 *   - the AD-5 OTel counters are queued behind PendingEmits (fire only on commit-drain).
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { transitionRun, TransitionOutcome } from "#backend/domain/transition_run.js";
import { PendingEmits } from "#backend/infra/post_commit_emit.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

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

/** A small unique bigint so unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  reviewId: string;
  runId: string;
  repoId: number;
};

// installation_id is FK'd into core.installations (ON DELETE CASCADE on repositories), so cleanup of the
// installations row removes the repositories row too.

/**
 * Seed the FK + BF-9 JOIN chain transitionRun needs:
 *   core.repositories(github_repo_id, installation_id) → resolves installation_id;
 *   core.pull_request_reviews(review_id, repo_id, provider) → the JOIN bridge;
 *   core.review_runs(run_id, review_id, lifecycle_state) → the row under transition.
 * Inserts the run at RUNNING so the happy-path RUNNING→terminal transitions are legal.
 */
async function seedTenant(): Promise<Seed> {
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
  await pool.query(
    `INSERT INTO core.review_runs
       (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', 'RUNNING')`,
    [runId, reviewId],
  );
  return { installationId, reviewId, runId, repoId };
}

/** Delete the seeded chain (events first — their FK to review_runs is RESTRICT). */
async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
  await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [seed.repoId]);
  // ON DELETE CASCADE from repositories' FK means deleting the installation also clears the repo; we
  // delete the repo explicitly first (above) for clarity, then the installation.
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

/** Read the run row's lifecycle_state + terminal timestamps. */
async function readRun(runId: string): Promise<{
  lifecycle_state: string;
  completed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
}> {
  const r = await pool.query(
    `SELECT lifecycle_state, completed_at, failed_at, cancelled_at
       FROM core.review_runs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0];
}

/** Count events of a given type for a run. */
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

function injectedTx(tx: unknown): Transaction<unknown> {
  return tx as unknown as Transaction<unknown>;
}

describeDb("transitionRun lifecycle state machine (integration, disposable PG)", () => {
  it("RUNNING → COMPLETED = APPLIED: stamps completed_at + emits lifecycle_transition", async () => {
    const seed = await seedTenant();
    const pending = new PendingEmits();
    try {
      const outcome = await db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: seed.runId,
          fromState: "RUNNING",
          toState: "COMPLETED",
          activity: "review_workflow.run",
          attempt: 1,
          workerId: "worker-3",
          durationMs: 4321,
          clock: FIXED_CLOCK,
          pending,
        }),
      );
      pending.drain();
      expect(outcome).toBe(TransitionOutcome.APPLIED);

      const row = await readRun(seed.runId);
      expect(row.lifecycle_state).toBe("COMPLETED");
      expect(row.completed_at).not.toBeNull();
      expect(new Date(row.completed_at!).toISOString()).toBe("2099-07-08T09:10:11.000Z");
      expect(row.failed_at).toBeNull();
      expect(row.cancelled_at).toBeNull();

      const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0]!.event_type).toBe("lifecycle_transition");
      expect(events.rows[0]!.payload).toEqual({
        from: "RUNNING",
        to: "COMPLETED",
        activity: "review_workflow.run",
        attempt: 1,
        worker_id: "worker-3",
        duration_ms: 4321,
        reason: null,
      });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("2nd RUNNING → COMPLETED (already COMPLETED) = ALREADY_APPLIED: no zombie, no duplicate event", async () => {
    const seed = await seedTenant();
    try {
      // First transition lands COMPLETED.
      await db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: seed.runId,
          fromState: "RUNNING",
          toState: "COMPLETED",
          activity: "review_workflow.run",
          attempt: 1,
          clock: FIXED_CLOCK,
          pending: new PendingEmits(),
        }),
      );
      const firstStamp = (await readRun(seed.runId)).completed_at;

      // Temporal at-least-once retry re-attempts the SAME transition.
      const outcome = await db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: seed.runId,
          fromState: "RUNNING",
          toState: "COMPLETED",
          activity: "review_workflow.run",
          attempt: 2,
          clock: new FakeClock({ now: new Date("2099-09-09T09:09:09.000Z") }),
          pending: new PendingEmits(),
        }),
      );
      expect(outcome).toBe(TransitionOutcome.ALREADY_APPLIED);

      const row = await readRun(seed.runId);
      // No zombie RUNNING; completed_at unchanged (no second stamp).
      expect(row.lifecycle_state).toBe("COMPLETED");
      expect(new Date(row.completed_at!).toISOString()).toBe(new Date(firstStamp!).toISOString());
      // Exactly ONE lifecycle_transition event (no duplicate).
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("RUNNING → FAILED stamps failed_at + emits the event", async () => {
    const seed = await seedTenant();
    try {
      const outcome = await db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: seed.runId,
          fromState: "RUNNING",
          toState: "FAILED",
          activity: "review_workflow.run_failed",
          attempt: 1,
          reason: "ValueError: boom",
          clock: FIXED_CLOCK,
          pending: new PendingEmits(),
        }),
      );
      expect(outcome).toBe(TransitionOutcome.APPLIED);
      const row = await readRun(seed.runId);
      expect(row.lifecycle_state).toBe("FAILED");
      expect(row.failed_at).not.toBeNull();
      expect(row.completed_at).toBeNull();
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("RUNNING → CANCELLED stamps cancelled_at + emits the event", async () => {
    const seed = await seedTenant();
    try {
      const outcome = await db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: seed.runId,
          fromState: "RUNNING",
          toState: "CANCELLED",
          activity: "review_workflow.run_cancelled",
          attempt: 1,
          reason: "temporal_cancellation",
          clock: FIXED_CLOCK,
          pending: new PendingEmits(),
        }),
      );
      expect(outcome).toBe(TransitionOutcome.APPLIED);
      const row = await readRun(seed.runId);
      expect(row.lifecycle_state).toBe("CANCELLED");
      expect(row.cancelled_at).not.toBeNull();
      expect(await countEvents(seed.runId, "lifecycle_transition")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("an illegal transition (current COMPLETED, caller expects RUNNING → FAILED) raises StateDrift", async () => {
    const seed = await seedTenant();
    try {
      await db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: seed.runId,
          fromState: "RUNNING",
          toState: "COMPLETED",
          activity: "review_workflow.run",
          attempt: 1,
          clock: FIXED_CLOCK,
          pending: new PendingEmits(),
        }),
      );
      // Now the run is COMPLETED; a FAILED transition from RUNNING drifts (current is neither RUNNING
      // nor FAILED).
      await expect(
        db.transaction().execute((tx) =>
          transitionRun({
            tx: injectedTx(tx),
            runId: seed.runId,
            fromState: "RUNNING",
            toState: "FAILED",
            activity: "review_workflow.run_failed",
            attempt: 1,
            reason: "late failure",
            clock: FIXED_CLOCK,
            pending: new PendingEmits(),
          }),
        ),
      ).rejects.toMatchObject({ name: "StateDrift", actualState: "COMPLETED" });
      // The run is unchanged by the failed transition (still COMPLETED, no failed_at).
      const row = await readRun(seed.runId);
      expect(row.lifecycle_state).toBe("COMPLETED");
      expect(row.failed_at).toBeNull();
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("a MISSING run row raises StateDrift with actualState null", async () => {
    const missingRunId = newUuid();
    await expect(
      db.transaction().execute((tx) =>
        transitionRun({
          tx: injectedTx(tx),
          runId: missingRunId,
          fromState: "RUNNING",
          toState: "COMPLETED",
          activity: "review_workflow.run",
          attempt: 1,
          clock: FIXED_CLOCK,
          pending: new PendingEmits(),
        }),
      ),
    ).rejects.toMatchObject({ name: "StateDrift", actualState: null });
  });
});

// Pure (no-DB) validation: the boundary rejects bad inputs before any SQL round-trip.
describe("transitionRun pure validation", () => {
  it("LIFECYCLE_STATES carries the exact frozen 7-state vocabulary", async () => {
    const { LIFECYCLE_STATES } = await import("#backend/domain/transition_run.js");
    expect([...LIFECYCLE_STATES].sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
      "FAILED",
      "PARTIAL",
      "PENDING",
      "RUNNING",
      "WAITING_RETRY",
    ]);
  });

  it("rejects a from_state not in LIFECYCLE_STATES before any SQL", async () => {
    await expect(
      transitionRun({
        tx: {} as unknown as Transaction<unknown>,
        runId: newUuid(),
        fromState: "BOGUS",
        toState: "COMPLETED",
        activity: "x",
        attempt: 1,
        pending: new PendingEmits(),
      }),
    ).rejects.toThrow(/from_state/);
  });

  it("rejects a to_state not in LIFECYCLE_STATES before any SQL", async () => {
    await expect(
      transitionRun({
        tx: {} as unknown as Transaction<unknown>,
        runId: newUuid(),
        fromState: "RUNNING",
        toState: "BOGUS",
        activity: "x",
        attempt: 1,
        pending: new PendingEmits(),
      }),
    ).rejects.toThrow(/to_state/);
  });

  it("rejects an empty activity before any SQL", async () => {
    await expect(
      transitionRun({
        tx: {} as unknown as Transaction<unknown>,
        runId: newUuid(),
        fromState: "RUNNING",
        toState: "COMPLETED",
        activity: "",
        attempt: 1,
        pending: new PendingEmits(),
      }),
    ).rejects.toThrow(/activity/);
  });

  it("rejects attempt < 1 before any SQL", async () => {
    await expect(
      transitionRun({
        tx: {} as unknown as Transaction<unknown>,
        runId: newUuid(),
        fromState: "RUNNING",
        toState: "COMPLETED",
        activity: "x",
        attempt: 0,
        pending: new PendingEmits(),
      }),
    ).rejects.toThrow(/attempt/);
  });

  it("rejects a non-Transaction handle (the open-txn RuntimeError analogue)", async () => {
    await expect(
      transitionRun({
        tx: {} as unknown as Transaction<unknown>,
        runId: newUuid(),
        fromState: "RUNNING",
        toState: "COMPLETED",
        activity: "x",
        attempt: 1,
        pending: new PendingEmits(),
      }),
    ).rejects.toThrow(/already-open transaction/);
  });
});
