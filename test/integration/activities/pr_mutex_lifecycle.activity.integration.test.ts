/**
 * Integration test for the two PR-mutex-lifecycle activities — REAL de-stubbed ports of the frozen
 * Python `renew_pr_review_mutex_lease_activity` (→ bool) and `release_pr_review_mutex_activity`
 * (→ void), against a DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster —
 * NEVER the in-cluster DB). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS
 * otherwise so validate-fast stays green without a database.
 *
 * Each activity takes ONE positional argument `mutex_id: string` (1:1 with the frozen Python signature).
 * The activity resolves the mutex's `installation_id` by PK lookup, then delegates to the already-ported
 * `renewPrReviewMutexLease` / `releasePrReviewMutex` helpers in `#backend/concurrency/pr_mutex.js`.
 *
 * Connection discipline: the activities use the SHARED ADR-0062 pool (getPool / disposePool) — NEVER a
 * hand-rolled `new Pool(...)`. This test obtains the same shared pool to seed + assert. Every test uses a
 * UNIQUE installation_id so per-tenant rows never collide; cleanup runs in `finally`.
 *
 * Coverage:
 *   - renew extends a held lease (lease_expires_at moves forward) and returns true.
 *   - renew on an EXPIRED-then-reclaimed mutex (released) returns false (lost-claim signal).
 *   - renew on a MISSING (never-existed) mutex returns false (no live row → lost claim).
 *   - release marks released_at and is idempotent: a SECOND release does NOT throw and leaves the row
 *     released.
 *   - release on a MISSING mutex is a no-op (no throw).
 *   - renew rejects a non-UUID mutex_id (1:1 with the Python uuid.UUID parse).
 */

import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, expect, it } from "vitest";

import { renewPrReviewMutexLeaseActivity } from "#backend/activities/renew_pr_review_mutex_lease.activity.js";
import { releasePrReviewMutexActivity } from "#backend/activities/release_pr_review_mutex.activity.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

let pool: Pool;

if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

afterAll(async () => {
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** Deterministic-enough RFC4122 v4 UUID for test fixtures (NOT security-sensitive; unique-per-call). */
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

/** A small unique bigint so github_* unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
};

/** Seed the FK chain (installation → repository) for one tenant — the parents the mutex FKs point at. */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const repositoryId = newUuid();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();

  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `org/repo-${ghRepo}`],
  );
  return { installationId, repositoryId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.pr_review_mutex WHERE installation_id = $1`, [
    seed.installationId,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [
    seed.installationId,
  ]);
}

/** Insert a LIVE mutex row (lease in the future) and return its minted mutex_id. */
async function seedLiveMutex(seed: Seed, prNumber: number): Promise<string> {
  const r = await pool.query<{ mutex_id: string }>(
    `INSERT INTO core.pr_review_mutex
       (installation_id, repository_id, pr_number, holder_workflow_id,
        acquired_at, lease_expires_at, released_at)
     VALUES ($1, $2, $3, 'wf-live', now(), now() + interval '5 min', NULL)
     RETURNING mutex_id`,
    [seed.installationId, seed.repositoryId, prNumber],
  );
  return r.rows[0]!.mutex_id;
}

/** Read the current lease_expires_at + released_at for a mutex row. */
async function readMutex(
  mutexId: string,
): Promise<{ lease_expires_at: Date | null; released_at: Date | null } | undefined> {
  const r = await pool.query<{ lease_expires_at: Date | null; released_at: Date | null }>(
    `SELECT lease_expires_at, released_at FROM core.pr_review_mutex WHERE mutex_id = $1`,
    [mutexId],
  );
  return r.rows[0];
}

describeDb("renewPrReviewMutexLeaseActivity (integration, disposable PG)", () => {
  it("extends a held lease and returns true (lease_expires_at moves forward)", async () => {
    const seed = await seedTenant();
    const prNumber = 101;
    try {
      const mutexId = await seedLiveMutex(seed, prNumber);
      const before = await readMutex(mutexId);
      expect(before?.lease_expires_at).not.toBeNull();

      const held = await renewPrReviewMutexLeaseActivity(mutexId);
      expect(held).toBe(true);

      const after = await readMutex(mutexId);
      expect(after?.released_at).toBeNull();
      // The default TTL (1800s) pushes the lease well past the seeded `now() + 5 min`.
      expect(after!.lease_expires_at!.getTime()).toBeGreaterThan(before!.lease_expires_at!.getTime());
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("returns false (lost claim) after the mutex is released", async () => {
    const seed = await seedTenant();
    const prNumber = 102;
    try {
      const mutexId = await seedLiveMutex(seed, prNumber);
      // Release it directly, then renew — the row is no longer live, so renew returns false.
      await pool.query(`UPDATE core.pr_review_mutex SET released_at = now() WHERE mutex_id = $1`, [
        mutexId,
      ]);
      const held = await renewPrReviewMutexLeaseActivity(mutexId);
      expect(held).toBe(false);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("returns false (lost claim) for a mutex_id that never existed", async () => {
    const ghostMutexId = newUuid();
    const held = await renewPrReviewMutexLeaseActivity(ghostMutexId);
    expect(held).toBe(false);
  });

  it("rejects a non-UUID mutex_id", async () => {
    await expect(renewPrReviewMutexLeaseActivity("not-a-uuid")).rejects.toThrow();
  });
});

describeDb("releasePrReviewMutexActivity (integration, disposable PG)", () => {
  it("marks released_at and is IDEMPOTENT (second release does not throw)", async () => {
    const seed = await seedTenant();
    const prNumber = 201;
    try {
      const mutexId = await seedLiveMutex(seed, prNumber);

      await releasePrReviewMutexActivity(mutexId);
      const afterFirst = await readMutex(mutexId);
      expect(afterFirst?.released_at).not.toBeNull();
      const firstReleasedAt = afterFirst!.released_at!.getTime();

      // Second release: no throw, and the row stays released (the already-released row is not touched
      // because the UPDATE filters on released_at IS NULL — idempotent, safe in a finally block).
      await expect(releasePrReviewMutexActivity(mutexId)).resolves.toBeUndefined();
      const afterSecond = await readMutex(mutexId);
      expect(afterSecond?.released_at).not.toBeNull();
      expect(afterSecond!.released_at!.getTime()).toBe(firstReleasedAt);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("is a no-op for a mutex_id that never existed (no throw)", async () => {
    const ghostMutexId = newUuid();
    await expect(releasePrReviewMutexActivity(ghostMutexId)).resolves.toBeUndefined();
  });

  it("rejects a non-UUID mutex_id", async () => {
    await expect(releasePrReviewMutexActivity("not-a-uuid")).rejects.toThrow();
  });
});

// Reference the fixed clock so the import is not flagged unused; the release activity uses its own
// WallClock internally (the released_at audit stamp), matching the frozen Python `WallClock()`.
void FIXED_CLOCK;
