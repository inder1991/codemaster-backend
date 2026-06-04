import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertCurrentRun, StaleWriteError } from "#backend/domain/stale_write_guard.js";

import { PendingEmits } from "#backend/infra/post_commit_emit.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (squashed baseline migrated). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green without
// a DB. We NEVER touch any other DB. Every test uses a UNIQUE installation_id; the FK chain
// (pull_request_reviews → review_runs) is cleaned up in `finally` blocks.

// 2099 routes every row into the audit.workflow_events_default partition (no 2099 range partition).
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
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
  /** The "current" (authoritative) run pointed at by pull_request_reviews.current_run_id. */
  currentRunId: string;
  /** A second valid review_runs row used as the "incoming stale" run (FK target for the emit). */
  staleRunId: string;
};

/**
 * Seed the FK chain assertCurrentRun + the STALE_WRITE_BLOCKED emit require:
 *   core.pull_request_reviews (review_id PK; provider/repo_id/pr_number/provider_pr_id NOT NULL) →
 *   TWO core.review_runs rows (run_id PK; review_id FK RESTRICT; trigger_type CHECK), one of which we
 *   then set as pull_request_reviews.current_run_id.
 * BOTH run rows exist so the emit's fk_workflow_events_run (run_id → review_runs RESTRICT) is satisfied
 * whether we assert with the current run or the stale run. installation_id has no FK on workflow_events.
 *
 * `currentNull=true` leaves current_run_id NULL (the NULL-mismatch case) — staleRunId is then the only
 * real run row, used as the incoming run for the emit FK.
 */
async function seedTenant(opts: { currentNull?: boolean } = {}): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const currentRunId = newUuid();
  const staleRunId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  // Both runs target the same review (review_runs.review_id → pull_request_reviews is RESTRICT/NOT NULL).
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', 'PENDING')`,
    [currentRunId, reviewId],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_synchronize', 'PENDING')`,
    [staleRunId, reviewId],
  );
  if (!opts.currentNull) {
    await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
      currentRunId,
      reviewId,
    ]);
  }
  return { installationId, reviewId, currentRunId, staleRunId };
}

/** Delete the seeded chain (events first — FKs to review_runs/pull_request_reviews are RESTRICT). */
async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1 OR run_id = $2`, [
    seed.currentRunId,
    seed.staleRunId,
  ]);
  // Break the circular current_run_id FK before deleting the run rows (FK ON DELETE SET NULL is on
  // pull_request_reviews, but review_runs.review_id → pull_request_reviews is RESTRICT, so order is:
  // null the pointer, drop runs, drop the review).
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = $1`, [
    seed.reviewId,
  ]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1 OR run_id = $2`, [
    seed.currentRunId,
    seed.staleRunId,
  ]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

/** Read the STALE_WRITE_BLOCKED rows for a run WITHIN the open tx (before the test rolls it back). */
async function blockedRowsInTx(
  tx: Transaction<unknown>,
  runId: string,
): Promise<Array<{ event_type: string; payload: unknown; installation_id: string | null }>> {
  const res = await sql<{ event_type: string; payload: unknown; installation_id: string | null }>`
    SELECT event_type, payload, installation_id
      FROM audit.workflow_events
     WHERE run_id = ${runId} AND event_type = ${"STALE_WRITE_BLOCKED"}
  `.execute(tx);
  return res.rows;
}

describeDb("assertCurrentRun (integration, disposable PG)", () => {
  it("resolves on the happy path (runId === current_run_id) and emits nothing", async () => {
    const seed = await seedTenant();
    try {
      await db.transaction().execute(async (txRaw) => {
        const tx = txRaw as unknown as Transaction<unknown>;
        const pending = new PendingEmits();
        await assertCurrentRun({
          tx,
          runId: seed.currentRunId,
          reviewId: seed.reviewId,
          site: "test.happy",
          pending,
          clock: FIXED_CLOCK,
        });
        // No emit queued on the happy path.
        expect(pending.size).toBe(0);
        const rows = await blockedRowsInTx(tx, seed.currentRunId);
        expect(rows.length).toBe(0);
        // The guard is read-only on the happy path (FOR SHARE lock only); the tx commits with no
        // rows written, and cleanup drops the seeded chain.
      });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("throws StaleWriteError on mismatch AND a STALE_WRITE_BLOCKED row is observable in-tx", async () => {
    const seed = await seedTenant();
    let thrown: unknown;
    let observedPayload: unknown;
    let observedInstallationId: string | null | undefined;
    let pendingSizeAfter = -1;
    try {
      // The mismatch path throws; capture state from inside the tx BEFORE the throw rolls it back by
      // doing the read+assert inside the callback and re-throwing only after observing.
      await db
        .transaction()
        .execute(async (txRaw) => {
          const tx = txRaw as unknown as Transaction<unknown>;
          const pending = new PendingEmits();
          try {
            await assertCurrentRun({
              tx,
              runId: seed.staleRunId, // != current_run_id
              reviewId: seed.reviewId,
              site: "test.mismatch",
              pending,
              clock: FIXED_CLOCK,
            });
          } catch (err) {
            thrown = err;
            // The forensic row is keyed by the *incoming* (stale) run_id and is observable within the
            // SAME tx before rollback.
            const rows = await blockedRowsInTx(tx, seed.staleRunId);
            expect(rows.length).toBe(1);
            observedPayload = rows[0]!.payload;
            observedInstallationId = rows[0]!.installation_id;
            pendingSizeAfter = pending.size;
            throw err; // re-throw → outer tx rolls back
          }
        })
        .catch((err: unknown) => {
          // Swallow the rollback re-throw so the test can assert on captured state.
          thrown = thrown ?? err;
        });

      expect(thrown).toBeInstanceOf(StaleWriteError);
      const e = thrown as StaleWriteError;
      expect(e.runId).toBe(seed.staleRunId);
      expect(e.reviewId).toBe(seed.reviewId);
      expect(e.currentRunId).toBe(seed.currentRunId);
      expect(e.site).toBe("test.mismatch");
      // payload = canonical JSON {"current":<cur>,"incoming":<stale>,"site":<site>} (sorted keys).
      expect(observedPayload).toEqual({
        current: seed.currentRunId,
        incoming: seed.staleRunId,
        site: "test.mismatch",
      });
      // STALE_WRITE_BLOCKED rows carry NULL installation_id (direct raw INSERT, BF-3 bypassed).
      expect(observedInstallationId).toBeNull();
      // The counter was QUEUED (not fired) — one pending emit.
      expect(pendingSizeAfter).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("throws StaleWriteError when current_run_id is NULL (no active run pointer) + emits a row", async () => {
    const seed = await seedTenant({ currentNull: true });
    let thrown: unknown;
    let observedPayload: unknown;
    try {
      await db
        .transaction()
        .execute(async (txRaw) => {
          const tx = txRaw as unknown as Transaction<unknown>;
          const pending = new PendingEmits();
          try {
            await assertCurrentRun({
              tx,
              runId: seed.staleRunId,
              reviewId: seed.reviewId,
              site: "test.null",
              pending,
              clock: FIXED_CLOCK,
            });
          } catch (err) {
            thrown = err;
            const rows = await blockedRowsInTx(tx, seed.staleRunId);
            expect(rows.length).toBe(1);
            observedPayload = rows[0]!.payload;
            throw err;
          }
        })
        .catch((err: unknown) => {
          thrown = thrown ?? err;
        });

      expect(thrown).toBeInstanceOf(StaleWriteError);
      const e = thrown as StaleWriteError;
      expect(e.currentRunId).toBeNull();
      // current serializes as JSON null when current_run_id is NULL.
      expect(observedPayload).toEqual({
        current: null,
        incoming: seed.staleRunId,
        site: "test.null",
      });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("throws StaleWriteError for a missing review_id WITHOUT writing a workflow_events row", async () => {
    const missingReviewId = newUuid();
    const someRunId = newUuid();
    let thrown: unknown;
    let blockedCount = -1;
    await db
      .transaction()
      .execute(async (txRaw) => {
        const tx = txRaw as unknown as Transaction<unknown>;
        const pending = new PendingEmits();
        try {
          await assertCurrentRun({
            tx,
            runId: someRunId,
            reviewId: missingReviewId,
            site: "test.orphan",
            pending,
            clock: FIXED_CLOCK,
          });
        } catch (err) {
          thrown = err;
          // No emit on the orphan branch — neither a queued counter nor a workflow_events row.
          expect(pending.size).toBe(0);
          const rows = await blockedRowsInTx(tx, someRunId);
          blockedCount = rows.length;
          throw err;
        }
      })
      .catch((err: unknown) => {
        thrown = thrown ?? err;
      });

    expect(thrown).toBeInstanceOf(StaleWriteError);
    const e = thrown as StaleWriteError;
    expect(e.currentRunId).toBeNull();
    expect(e.reviewId).toBe(missingReviewId);
    expect(blockedCount).toBe(0);
    // Nothing was persisted (the review row never existed); no cleanup needed.
  });

  it("the queued counter fires only via pending.drain() (post-commit emit semantics)", async () => {
    const seed = await seedTenant();
    let fired = 0;
    const pending = new PendingEmits();
    try {
      await db
        .transaction()
        .execute(async (txRaw) => {
          const tx = txRaw as unknown as Transaction<unknown>;
          // Push a sentinel alongside the guard's own queued counter to observe drain ordering/firing.
          try {
            await assertCurrentRun({
              tx,
              runId: seed.staleRunId,
              reviewId: seed.reviewId,
              site: "test.drain",
              pending,
              clock: FIXED_CLOCK,
            });
          } catch (err) {
            // Mismatch → one emit queued; NOT yet fired.
            expect(pending.size).toBe(1);
            expect(fired).toBe(0);
            // Add our own sentinel so we can prove drain() runs the queue.
            pending.push(() => {
              fired += 1;
            });
            throw err;
          }
        })
        .catch(() => undefined);

      // Before drain: still not fired.
      expect(fired).toBe(0);
      // Hypothetical commit path: the caller drains AFTER a successful resolve. (This test exercises
      // only the drain-fires-the-queue mechanic; the guard's counter add is a no-op without a meter
      // provider, but the sentinel proves drain() runs the queued callables.)
      pending.drain();
      expect(fired).toBe(1);
      expect(pending.isDrained).toBe(true);
      // Idempotent second drain is a no-op.
      pending.drain();
      expect(fired).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("rejects a non-transaction Kysely handle (the session.in_transaction() RuntimeError analogue)", async () => {
    const pending = new PendingEmits();
    await expect(
      assertCurrentRun({
        tx: db as unknown as Transaction<unknown>, // bare engine, NOT a Transaction
        runId: newUuid(),
        reviewId: newUuid(),
        site: "test.no-tx",
        pending,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toThrow(/requires an already-open transaction/);
  });
});

// Pure (no-DB) checks for the post-commit-emit primitive.
describe("PendingEmits post-commit-emit primitive (pure)", () => {
  it("drain fires queued callables in FIFO order and clears the queue", async () => {
    const { emitAfterCommit } = await import("#backend/infra/post_commit_emit.js");
    const order: Array<number> = [];
    const pending = new PendingEmits();
    emitAfterCommit(pending, () => order.push(1));
    emitAfterCommit(pending, () => order.push(2));
    emitAfterCommit(pending, () => order.push(3));
    expect(pending.size).toBe(3);
    pending.drain();
    expect(order).toEqual([1, 2, 3]);
    expect(pending.size).toBe(0);
    expect(pending.isDrained).toBe(true);
  });

  it("drain swallows + continues past a throwing callable (the must-not-raise contract)", async () => {
    const { emitAfterCommit } = await import("#backend/infra/post_commit_emit.js");
    const fired: Array<string> = [];
    const pending = new PendingEmits();
    emitAfterCommit(pending, () => fired.push("a"));
    emitAfterCommit(pending, () => {
      throw new Error("boom");
    });
    emitAfterCommit(pending, () => fired.push("c"));
    // drain must NOT throw — the buggy emit is swallowed + logged; the rest still fire.
    expect(() => pending.drain()).not.toThrow();
    expect(fired).toEqual(["a", "c"]);
  });

  it("a never-drained collector drops its queue (the rollback-drops semantics)", () => {
    const fired: Array<string> = [];
    const pending = new PendingEmits();
    pending.push(() => fired.push("x"));
    // No drain (simulating a rolled-back transaction) → nothing fires.
    expect(fired).toEqual([]);
    expect(pending.size).toBe(1);
    expect(pending.isDrained).toBe(false);
  });
});
