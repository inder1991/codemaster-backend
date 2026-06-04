import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";

import { Kysely, PostgresDialect, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BF3InstallationIdMissing,
  emitWorkflowEvent,
  EVENT_TYPES,
  ORPHAN_REASONS,
  runIdToLockKey,
  WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE,
} from "#backend/ingest/_workflow_events_repository.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (squashed baseline migrated). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green without
// a DB. We NEVER touch any other DB. Every test uses a UNIQUE installation_id; the FK chain
// (pull_request_reviews → review_runs) is cleaned up in `finally` blocks.

// 2099 routes every row into the audit.workflow_events_default partition (no 2099 range partition).
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

const PY = "/Users/ascoe/Projects/codemaster-backend/vendor/codemaster-py/.venv/bin/python";
const PY_REPO = "/Users/ascoe/Projects/codemaster-backend/vendor/codemaster-py";

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
  runId: string;
};

/**
 * Seed the FK chain audit.workflow_events requires: a core.pull_request_reviews row (review_id PK,
 * provider/repo_id/pr_number/provider_pr_id NOT NULL; current_run_id NULL initially to break the
 * circular FK) → a core.review_runs row (run_id PK; review_id FK RESTRICT; trigger_type CHECK).
 * The installation_id column on workflow_events has NO FK, so no installations row is required.
 */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const runId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  // pull_request_reviews first, current_run_id NULL (the FK to review_runs is ON DELETE SET NULL and
  // nullable, so we can fill it later; review_runs.review_id → here is RESTRICT and NOT NULL).
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs
       (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', 'PENDING')`,
    [runId, reviewId],
  );
  return { installationId, reviewId, runId };
}

/** Delete the seeded chain (events first — FKs to review_runs/pull_request_reviews are RESTRICT). */
async function cleanupTenant(seed: Seed): Promise<void> {
  // installation_id has no FK, but scope the audit cleanup to the tenant for tidy isolation.
  await pool.query(`DELETE FROM audit.workflow_events WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

describeDb("emitWorkflowEvent (integration, disposable PG)", () => {
  it("inserts monotonic sequence_no (1 then 2) per run inside the caller's transaction", async () => {
    const seed = await seedTenant();
    try {
      const id1 = await db.transaction().execute((tx) =>
        emitWorkflowEvent({
          dbOrTx: tx as unknown as Transaction<unknown>,
          provider: "github",
          runId: seed.runId,
          reviewId: seed.reviewId,
          eventType: "FINDINGS_PERSISTED",
          payload: { count: 3 },
          installationId: seed.installationId,
          clock: FIXED_CLOCK,
        }),
      );
      const id2 = await db.transaction().execute((tx) =>
        emitWorkflowEvent({
          dbOrTx: tx as unknown as Transaction<unknown>,
          provider: "github",
          runId: seed.runId,
          reviewId: seed.reviewId,
          eventType: "ANALYZED",
          installationId: seed.installationId,
          clock: FIXED_CLOCK,
        }),
      );

      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id2).not.toBe(id1);

      const rows = await pool.query<{
        event_id: string;
        provider: string;
        run_id: string;
        review_id: string;
        sequence_no: number;
        event_type: string;
        payload: unknown;
        installation_id: string | null;
        delivery_id: string | null;
        received_at: Date;
      }>(
        `SELECT event_id, provider, run_id, review_id, sequence_no, event_type, payload,
                installation_id, delivery_id, received_at
           FROM audit.workflow_events WHERE run_id = $1 ORDER BY sequence_no`,
        [seed.runId],
      );
      expect(rows.rows.map((r) => r.sequence_no)).toEqual([1, 2]);
      const first = rows.rows[0]!;
      expect(first.event_id).toBe(id1);
      expect(first.provider).toBe("github");
      expect(first.event_type).toBe("FINDINGS_PERSISTED");
      expect(first.payload).toEqual({ count: 3 });
      expect(first.installation_id).toBe(seed.installationId);
      expect(first.delivery_id).toBeNull();
      expect(new Date(first.received_at).toISOString()).toBe("2099-03-04T05:06:07.000Z");
      expect(rows.rows[1]!.event_type).toBe("ANALYZED");
      expect(rows.rows[1]!.payload).toEqual({}); // payload omitted → {} default
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("rejects an unknown eventType with a typed error before any DB write", async () => {
    const seed = await seedTenant();
    try {
      await expect(
        db.transaction().execute((tx) =>
          emitWorkflowEvent({
            dbOrTx: tx as unknown as Transaction<unknown>,
            provider: "github",
            runId: seed.runId,
            reviewId: seed.reviewId,
            eventType: "NOT_A_REAL_EVENT",
            installationId: seed.installationId,
            clock: FIXED_CLOCK,
          }),
        ),
      ).rejects.toThrow(/is not in EVENT_TYPES/);

      const n = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(n.rows[0]?.n)).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("throws BF3InstallationIdMissing when installationId is null without a valid orphan_reason", async () => {
    const seed = await seedTenant();
    try {
      await expect(
        db.transaction().execute((tx) =>
          emitWorkflowEvent({
            dbOrTx: tx as unknown as Transaction<unknown>,
            provider: "github",
            runId: seed.runId,
            reviewId: seed.reviewId,
            eventType: "FINDINGS_PERSISTED",
            installationId: null, // no orphan_reason → guard fires
            clock: FIXED_CLOCK,
          }),
        ),
      ).rejects.toBeInstanceOf(BF3InstallationIdMissing);

      const n = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(Number(n.rows[0]?.n)).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("inserts a NULL-installation_id row when a valid orphan_reason tags the payload", async () => {
    const seed = await seedTenant();
    try {
      const id = await db.transaction().execute((tx) =>
        emitWorkflowEvent({
          dbOrTx: tx as unknown as Transaction<unknown>,
          provider: "github",
          runId: seed.runId,
          reviewId: seed.reviewId,
          eventType: "RUN_CANCELLED",
          payload: { orphan_reason: "orphan_retire" },
          installationId: null, // legitimate orphan — tagged
          clock: FIXED_CLOCK,
        }),
      );
      const row = await pool.query<{ installation_id: string | null; payload: unknown; event_id: string }>(
        `SELECT installation_id, payload, event_id FROM audit.workflow_events WHERE run_id = $1`,
        [seed.runId],
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0]!.event_id).toBe(id);
      expect(row.rows[0]!.installation_id).toBeNull();
      expect(row.rows[0]!.payload).toEqual({ orphan_reason: "orphan_retire" });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("rejects a non-transaction Kysely handle (the session.in_transaction() RuntimeError analogue)", async () => {
    await expect(
      emitWorkflowEvent({
        dbOrTx: db as unknown as Kysely<unknown>, // bare engine, NOT a Transaction
        provider: "github",
        runId: newUuid(),
        reviewId: newUuid(),
        eventType: "FINDINGS_PERSISTED",
        installationId: newUuid(),
        clock: FIXED_CLOCK,
      }),
    ).rejects.toThrow(/requires an already-open transaction/);
  });
});

// Pure (no-DB) checks: registry contents + runIdToLockKey known-answer parity with frozen Python.
describe("workflow-events repo pure contract", () => {
  it("EVENT_TYPES + ORPHAN_REASONS + namespace carry the exact frozen vocabulary", () => {
    expect(EVENT_TYPES.has("FINDINGS_PERSISTED")).toBe(true);
    expect(EVENT_TYPES.has("STALE_WRITE_BLOCKED")).toBe(true);
    expect(EVENT_TYPES.has("NOPE")).toBe(false);
    expect([...ORPHAN_REASONS].sort()).toEqual(["bootstrap_sink", "orphan_retire"]);
    expect(WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE).toBe(0x5742_4555);
  });

  it("runIdToLockKey is byte-identical to the frozen Python _run_id_to_lock_key", () => {
    const vectors = [
      "00000000-0000-4000-8000-000000000000",
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
      "12345678-9abc-4def-8000-000000000000",
    ];
    // Compute the ground truth from the frozen Python so this never drifts (run only when the venv
    // exists — same disposable-env contract as the DB gate; skip otherwise).
    let pyValues: Array<number>;
    try {
      const script =
        "import sys, uuid; " +
        `sys.path.insert(0, ${JSON.stringify(PY_REPO)}); ` +
        "from codemaster.ingest._workflow_events_repository import _run_id_to_lock_key as f; " +
        `print(','.join(str(f(uuid.UUID(u))) for u in ${JSON.stringify(vectors)}))`;
      const out = execFileSync(PY, ["-c", script], { encoding: "utf-8" }).trim();
      pyValues = out.split(",").map((s) => Number(s));
    } catch {
      // Frozen Python unavailable — fall back to the captured known-answer vector (computed live
      // 2026-06-04 via the venv: see the test's parity comment). Keeps the assertion meaningful.
      pyValues = [0, -1, 305419896];
    }
    expect(vectors.map(runIdToLockKey)).toEqual(pyValues);
    // Hard-pin the known answers too (defends against a Python that returns something absurd).
    expect(vectors.map(runIdToLockKey)).toEqual([0, -1, 305419896]);
  });
});
