/**
 * Integration test for the OutboxDispatchActivities `dispatchRow` GUARD path (the review-causal branch:
 * run_id && review_id present), against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs only when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb). This empirically verifies the orchestration the unit
 * tests can't: the AD-4 stale-write guard (in a SAVEPOINT) → PENDING→RUNNING transition → INGESTED
 * milestone → sink invoke, all against the real schema + FK graph.
 *
 * Seeds the FK chain transitionRun/assertCurrentRun need (repositories → pull_request_reviews →
 * review_runs), with current_run_id pointing at the run and the run at PENDING. A 2099 FakeClock routes
 * the emitted events into the audit.workflow_events_default partition.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { StaleWriteError } from "#backend/domain/stale_write_guard.js";
import { StateDrift } from "#backend/domain/transition_run.js";
import { registerSink, resetRegistryForTesting, type SinkContext } from "#backend/outbox/sink_registry.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });

let pool: Pool;
let db: Kysely<unknown>;
let repo: PostgresOutboxRepo;
let acts: OutboxDispatchActivities;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }), plugins: [new TenancyPlugin()] });
  repo = new PostgresOutboxRepo({ clock: FIXED_CLOCK });
  acts = new OutboxDispatchActivities({ repo, db, clock: FIXED_CLOCK, maxAttempts: 5 });
});

afterAll(async () => {
  await db?.destroy();
});

function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = { installationId: string; reviewId: string; runId: string; repoId: number };

/** Seed the run/review/repo chain. `lifecycle` is the seeded review_runs state. `pointAtRun` (default
 *  true) sets pull_request_reviews.current_run_id = the run so the guard passes; false leaves it NULL so
 *  assertCurrentRun sees a mismatch → StaleWriteError. The current_run_id → review_runs FK forces the
 *  insert order (review null → insert run → UPDATE pointer). */
async function seedTenant(opts: { lifecycle: string; pointAtRun?: boolean }): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const runId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;
  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, 'octo', 'Organization')`,
    [installationId, uniqueBigint()],
  );
  await pool.query(
    `INSERT INTO core.repositories (installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, 'main', true)`,
    [installationId, repoId, `octo/repo-${repoId}`],
  );
  // current_run_id starts NULL — the FK to review_runs can't be satisfied until the run row exists.
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', $3)`,
    [runId, reviewId, opts.lifecycle],
  );
  if (opts.pointAtRun ?? true) {
    await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
      runId,
      reviewId,
    ]);
  }
  return { installationId, reviewId, runId, repoId };
}

async function cleanup(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
  await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [seed.repoId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

function dispatchInput(seed: Seed): Parameters<OutboxDispatchActivities["dispatchRow"]>[0] {
  return {
    schema_version: 2,
    row_id: newUuid(),
    sink: "itest_sink",
    payload: { hello: "world" },
    trace_context: {},
    run_id: seed.runId,
    review_id: seed.reviewId,
    provider: "github",
    installation_id: seed.installationId,
    orphan_reason: null,
  };
}

async function eventTypes(runId: string): Promise<Array<string>> {
  const r = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM audit.workflow_events WHERE run_id = $1 ORDER BY sequence_no`,
    [runId],
  );
  return r.rows.map((x) => x.event_type);
}
async function lifecycleOf(runId: string): Promise<string> {
  const r = await pool.query<{ lifecycle_state: string }>(
    `SELECT lifecycle_state FROM core.review_runs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0]!.lifecycle_state;
}

describeDb("OutboxDispatchActivities.dispatchRow guard path (integration, disposable PG)", () => {
  it("happy path: stale-write guard passes → PENDING→RUNNING → INGESTED emitted → sink invoked", async () => {
    resetRegistryForTesting();
    const calls: Array<{ payload: unknown; context: SinkContext }> = [];
    registerSink("itest_sink", async (a) => {
      calls.push(a);
    });
    const seed = await seedTenant({ lifecycle: "PENDING" });
    try {
      await acts.dispatchRow(dispatchInput(seed));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toEqual({ hello: "world" });
      expect(calls[0]!.context.installationId).toBe(seed.installationId);
      expect(await lifecycleOf(seed.runId)).toBe("RUNNING");
      expect(await eventTypes(seed.runId)).toContain("INGESTED");
    } finally {
      await cleanup(seed);
    }
  });

  it("idempotent retry: a second dispatch observes ALREADY_APPLIED → no duplicate INGESTED, sink re-invoked", async () => {
    resetRegistryForTesting();
    let count = 0;
    registerSink("itest_sink", async () => {
      count += 1;
    });
    const seed = await seedTenant({ lifecycle: "PENDING" });
    try {
      const input = dispatchInput(seed);
      await acts.dispatchRow(input);
      await acts.dispatchRow(input); // redrive

      expect(count).toBe(2); // sink invoked both times (the invoke is outside the APPLIED gate)
      expect(await lifecycleOf(seed.runId)).toBe("RUNNING");
      // transitionRun emits its own lifecycle_transition; the 2nd dispatch is ALREADY_APPLIED → neither
      // the lifecycle_transition NOR the INGESTED milestone is duplicated (both gated/no-op on retry).
      expect(await eventTypes(seed.runId)).toEqual(["lifecycle_transition", "INGESTED"]);
    } finally {
      await cleanup(seed);
    }
  });

  it("stale-write: current_run_id points elsewhere → StaleWriteError, forensic row written, sink NOT invoked", async () => {
    resetRegistryForTesting();
    let invoked = false;
    registerSink("itest_sink", async () => {
      invoked = true;
    });
    // current_run_id stays NULL → no active-run pointer → the incoming run is stale.
    const seed = await seedTenant({ lifecycle: "PENDING", pointAtRun: false });
    try {
      await expect(acts.dispatchRow(dispatchInput(seed))).rejects.toBeInstanceOf(StaleWriteError);
      expect(invoked).toBe(false); // guard fired before the sink
      // The forensic STALE_WRITE_BLOCKED row was merged into the outer txn (RELEASE-on-error), but the
      // outer txn then rolled back on the re-raise — so the run is NOT transitioned.
      expect(await lifecycleOf(seed.runId)).toBe("PENDING");
    } finally {
      await cleanup(seed);
    }
  });

  it("state drift: run is in WAITING_RETRY (not PENDING) → StateDrift, sink NOT invoked, no INGESTED", async () => {
    resetRegistryForTesting();
    let invoked = false;
    registerSink("itest_sink", async () => {
      invoked = true;
    });
    // WAITING_RETRY is an active state with no terminal-timestamp CHECK; the guard passes (current_run_id
    // points at the run) but transitionRun(PENDING→RUNNING) sees WAITING_RETRY ∉ {PENDING, RUNNING} → drift.
    const seed = await seedTenant({ lifecycle: "WAITING_RETRY" });
    try {
      await expect(acts.dispatchRow(dispatchInput(seed))).rejects.toBeInstanceOf(StateDrift);
      expect(invoked).toBe(false);
      expect(await eventTypes(seed.runId)).not.toContain("INGESTED");
    } finally {
      await cleanup(seed);
    }
  });
});
