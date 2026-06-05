/**
 * Integration test for `startReviewForWebhook` (the gate activity) — 1:1 port of the frozen Python
 * `codemaster/activities/start_review_for_webhook.py::start_review_for_webhook_activity`. Runs against a
 * DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster
 * DB). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast
 * stays green without a DB.
 *
 * Connection discipline: the activity reads CODEMASTER_PG_CORE_DSN and routes through the SHARED
 * ADR-0062 pool (getPool); the test shares the SAME getPool seam for seeding/cleanup so there is exactly
 * one pool per DSN. Every test uses a UNIQUE installation_id so per-tenant rows never collide; the FK
 * chain (installation → repository) is seeded per test and torn down in `finally`.
 *
 * Coverage (mirrors the Python gate's status surface — the in-scope Stage-2 behaviour):
 *   - free PR (repository.enabled=true, no live mutex) → status='accepted', mutex_id minted, one live row.
 *   - a 2nd concurrent acquire while the first lease is valid → status='skipped_busy', mutex_id null.
 *   - repository.enabled=false → status='skipped_disabled', NO mutex acquired (default-deny re-check).
 *   - the v1-tolerance shim: a legacy payload (no pr_id) → status='skipped_legacy_payload'.
 *   - a missing repository row (reconcile race) → the activity RAISES (Temporal retries / dead-letters).
 *
 * NOTE: the gate now emits an `audit.audit_events` row on each branch via the encrypted (AES-256-GCM
 * AAD) audit-emit subsystem — the Stage-3 wire-through of the previously-deferred
 * FOLLOW-UP-stage3-gate-audit-emit. These tests install a deterministic dev key registry in `beforeAll`
 * so the encryption path has a key (encrypt fails closed otherwise), and clean up the audit rows. The
 * `after`-payload assertions for each branch live in the dedicated
 * test/integration/audit/gate_audit_emit.integration.test.ts; here we assert the gate's return-value
 * semantics (the original Stage-2 surface) still hold with audit-emit wired.
 */

import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startReviewForWebhook } from "#backend/activities/start_review_for_webhook.activity.js";

import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

if (INTEGRATION_DSN) {
  // The shared pool is lazy (no socket until first query), so it is safe to obtain at module load when
  // the DSN is present; describeDb gates the actual queries. The activity reads CODEMASTER_PG_CORE_DSN
  // and resolves the SAME shared pool, so seeding here and the activity's mutex acquire share one pool.
  pool = getPool(INTEGRATION_DSN);
}

beforeAll(() => {
  // The gate's audit-emit encrypts before/after via the audit field-encryption codec — install a
  // deterministic dev key so the encryption path has a key (fail-closed without one).
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** Deterministic-but-unique UUID for test fixtures (NOT security-sensitive; just unique-per-call). */
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

/** A unique 40-hex SHA so the payload's exactly-40-char head_sha constraint is satisfied per test. */
function newHeadSha(): string {
  return createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest("hex")
    .padEnd(40, "0")
    .slice(0, 40);
}

/** A small unique bigint so github_* unique columns never collide across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  ghOwner: string;
  ghRepoName: string;
};

/**
 * Seed the FK chain (installation → repository) for one tenant — the parents the mutex FKs point at.
 * `enabled` controls the gate's tenancy re-check branch.
 */
async function seedTenant(enabled: boolean): Promise<Seed> {
  const installationId = newUuid();
  const repositoryId = newUuid();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();
  const ghOwner = `org-${ghRepo}`;
  const ghRepoName = `repo-${ghRepo}`;

  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', $5)`,
    [repositoryId, installationId, ghRepo, `${ghOwner}/${ghRepoName}`, enabled],
  );
  return { installationId, repositoryId, ghOwner, ghRepoName };
}

/** Drop every audit + mutex row + the FK parents for a tenant. */
async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [
    seed.installationId,
  ]);
  await pool.query(`DELETE FROM core.pr_review_mutex WHERE installation_id = $1`, [
    seed.installationId,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [
    seed.installationId,
  ]);
}

/** Count the LIVE (released_at IS NULL) mutex rows for a PR. */
async function liveRowCount(seed: Seed, prNumber: number): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM core.pr_review_mutex
       WHERE installation_id = $1 AND repository_id = $2 AND pr_number = $3 AND released_at IS NULL`,
    [seed.installationId, seed.repositoryId, prNumber],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Build a v2 ReviewPullRequestPayloadV1-shaped raw dict for a tenant + PR. */
function buildPayloadDict(
  seed: Seed,
  prNumber: number,
  headSha: string,
): Record<string, unknown> {
  return {
    schema_version: 2,
    installation_id: seed.installationId,
    repository_id: seed.repositoryId,
    pr_id: newUuid(),
    pr_number: prNumber,
    head_sha: headSha,
    gh_owner: seed.ghOwner,
    gh_repo_name: seed.ghRepoName,
    pr_title: "Add a feature",
    pr_description: "Implements the thing.",
    delivery_id: `delivery-${prNumber}-${headSha.slice(0, 8)}`,
    policy_revision: 0,
    run_id: newUuid(),
    review_id: newUuid(),
  };
}

describeDb("startReviewForWebhook (integration, disposable PG)", () => {
  it("accepts on a free PR (status='accepted', mutex_id minted, one live row)", async () => {
    const seed = await seedTenant(true);
    const prNumber = 101;
    const headSha = newHeadSha();
    try {
      const result = await startReviewForWebhook(buildPayloadDict(seed, prNumber, headSha));
      expect(result.status).toBe("accepted");
      expect(result.pr_number).toBe(prNumber);
      expect(result.mutex_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(await liveRowCount(seed, prNumber)).toBe(1);

      // The mutex row records the Python holder_workflow_id format exactly:
      //   ReviewPR-{owner}/{repo}-{pr_number}-{head_sha[:8]}
      const expectedHolder = `ReviewPR-${seed.ghOwner}/${seed.ghRepoName}-${prNumber}-${headSha.slice(0, 8)}`;
      const holderRow = await pool.query<{ holder_workflow_id: string }>(
        `SELECT holder_workflow_id FROM core.pr_review_mutex
           WHERE installation_id = $1 AND repository_id = $2 AND pr_number = $3 AND released_at IS NULL`,
        [seed.installationId, seed.repositoryId, prNumber],
      );
      expect(holderRow.rows[0]?.holder_workflow_id).toBe(expectedHolder);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("a 2nd concurrent acquire while the lease is valid → status='skipped_busy', mutex_id null", async () => {
    const seed = await seedTenant(true);
    const prNumber = 202;
    try {
      const first = await startReviewForWebhook(buildPayloadDict(seed, prNumber, newHeadSha()));
      expect(first.status).toBe("accepted");

      const second = await startReviewForWebhook(buildPayloadDict(seed, prNumber, newHeadSha()));
      expect(second.status).toBe("skipped_busy");
      expect(second.pr_number).toBe(prNumber);
      expect(second.mutex_id).toBeNull();
      // Still exactly one live row (the partial-unique index enforces it).
      expect(await liveRowCount(seed, prNumber)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("repository.enabled=false → status='skipped_disabled', NO mutex acquired", async () => {
    const seed = await seedTenant(false);
    const prNumber = 303;
    try {
      const result = await startReviewForWebhook(buildPayloadDict(seed, prNumber, newHeadSha()));
      expect(result.status).toBe("skipped_disabled");
      expect(result.pr_number).toBe(prNumber);
      expect(result.mutex_id).toBeNull();
      // Default-deny re-check fires BEFORE the mutex acquire — no live row exists.
      expect(await liveRowCount(seed, prNumber)).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("a legacy v1 payload (no pr_id) → status='skipped_legacy_payload' (the v1-tolerance shim)", async () => {
    const seed = await seedTenant(true);
    const prNumber = 404;
    try {
      // v1 outbox shape: 5 fields, NO pr_id. The gate detects this by the missing pr_id and routes to
      // the legacy shim WITHOUT validating against the v2 contract or touching the mutex.
      const legacy: Record<string, unknown> = {
        schema_version: 1,
        installation_id: seed.installationId,
        repository_id: seed.repositoryId,
        pr_number: prNumber,
        delivery_id: "legacy-delivery-1",
      };
      const result = await startReviewForWebhook(legacy);
      expect(result.status).toBe("skipped_legacy_payload");
      // Python returns max(1, pr_number) — 404 stays 404.
      expect(result.pr_number).toBe(prNumber);
      expect(result.mutex_id).toBeNull();
      // The shim acquires no mutex.
      expect(await liveRowCount(seed, prNumber)).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("a missing repository row (reconcile race) → the activity RAISES", async () => {
    // A well-formed v2 payload whose repository_id has NO row (the parents were never seeded). The gate's
    // tenancy SELECT returns no row → it raises so Temporal retries / dead-letters.
    const installationId = newUuid();
    const repositoryId = newUuid();
    const payload: Record<string, unknown> = {
      schema_version: 2,
      installation_id: installationId,
      repository_id: repositoryId,
      pr_id: newUuid(),
      pr_number: 505,
      head_sha: newHeadSha(),
      gh_owner: "org-x",
      gh_repo_name: "repo-x",
      pr_title: "t",
      pr_description: "d",
      delivery_id: "delivery-505",
      policy_revision: 0,
      run_id: newUuid(),
      review_id: newUuid(),
    };
    await expect(startReviewForWebhook(payload)).rejects.toThrow(/not found|reconcile race/i);
  });
});
