/**
 * Integration test for the webhook-persistence DB primitives (W2), against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the cluster). Runs only when
 * CODEMASTER_PG_CORE_DSN is set (describeDb). Covers the resolvers, upsertReview, and the SERIAL+SUPERSEDE
 * allocator (allocateRun composing supersedeRun + INSERT + flipCurrentRun + WEBHOOK_RECEIVED) end-to-end.
 * A 2099 FakeClock routes emitted workflow_events into the default partition.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { allocateRun } from "#backend/ingest/_review_run_allocator.js";
import { upsertReview } from "#backend/ingest/_reviews_repository.js";
import {
  resolveInternalInstallationId,
  resolveInternalRepositoryId,
} from "#backend/ingest/_webhook_resolvers.js";
import { supersedeRun } from "#backend/workflow/_supersede.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const CLOCK = new FakeClock({ now: new Date("2099-07-08T09:10:11.000Z") });

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }), plugins: [new TenancyPlugin()] });
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

type Seed = { installationId: string; githubInstallationId: number; githubRepoId: number };

async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const githubInstallationId = uniqueBigint();
  const githubRepoId = uniqueBigint();
  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, 'octo', 'Organization')`,
    [installationId, githubInstallationId],
  );
  await pool.query(
    `INSERT INTO core.repositories (installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, 'main', true)`,
    [installationId, githubRepoId, `octo/repo-${githubRepoId}`],
  );
  return { installationId, githubInstallationId, githubRepoId };
}
async function cleanup(seed: Seed, reviewId?: string): Promise<void> {
  if (reviewId) {
    await pool.query(`DELETE FROM audit.workflow_events WHERE review_id = $1`, [reviewId]);
    await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = $1`, [reviewId]);
    await pool.query(`DELETE FROM core.review_runs WHERE review_id = $1`, [reviewId]);
    await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [reviewId]);
  }
  await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [seed.githubRepoId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

async function runState(runId: string): Promise<{ lifecycle_state: string; superseded_by_run_id: string | null }> {
  const r = await pool.query<{ lifecycle_state: string; superseded_by_run_id: string | null }>(
    `SELECT lifecycle_state, superseded_by_run_id FROM core.review_runs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0]!;
}
async function currentRunId(reviewId: string): Promise<string | null> {
  const r = await pool.query<{ current_run_id: string | null }>(
    `SELECT current_run_id FROM core.pull_request_reviews WHERE review_id = $1`,
    [reviewId],
  );
  return r.rows[0]!.current_run_id;
}
async function eventTypesFor(runId: string): Promise<Array<string>> {
  const r = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM audit.workflow_events WHERE run_id = $1`,
    [runId],
  );
  return r.rows.map((x) => x.event_type);
}

describeDb("webhook persistence DB primitives (integration, disposable PG)", () => {
  it("resolvers map GitHub ids → internal UUIDs (repo resolve is tenant-scoped)", async () => {
    const seed = await seedTenant();
    try {
      const iid = await resolveInternalInstallationId(db, seed.githubInstallationId);
      expect(iid).toBe(seed.installationId);
      expect(await resolveInternalInstallationId(db, 999_999_999 + uniqueBigint())).toBeNull();

      const repoId = await resolveInternalRepositoryId(db, seed.githubRepoId, seed.installationId);
      expect(repoId).not.toBeNull();
      // wrong installation → no scoped row (tenancy)
      expect(await resolveInternalRepositoryId(db, seed.githubRepoId, newUuid())).toBeNull();
    } finally {
      await cleanup(seed);
    }
  });

  it("upsertReview is get-or-create: same (provider,repo,pr) → stable review_id, refreshes provider_pr_id", async () => {
    const seed = await seedTenant();
    let reviewId: string | undefined;
    try {
      const prNumber = (uniqueBigint() % 9000) + 1;
      reviewId = await db.transaction().execute((tx) =>
        upsertReview(tx, { provider: "github", repoId: seed.githubRepoId, prNumber, providerPrId: "node-1", prNodeId: "node-1", branch: "feat/x" }),
      );
      const second = await db.transaction().execute((tx) =>
        upsertReview(tx, { provider: "github", repoId: seed.githubRepoId, prNumber, providerPrId: "node-2", prNodeId: "node-2", branch: "feat/y" }),
      );
      expect(second).toBe(reviewId); // identity preserved
      const r = await pool.query<{ provider_pr_id: string }>(
        `SELECT provider_pr_id FROM core.pull_request_reviews WHERE review_id = $1`,
        [reviewId],
      );
      expect(r.rows[0]!.provider_pr_id).toBe("node-2"); // refreshed
    } finally {
      await cleanup(seed, reviewId);
    }
  });

  it("allocateRun: fresh review allocates a PENDING run, flips current_run_id, emits WEBHOOK_RECEIVED", async () => {
    const seed = await seedTenant();
    let reviewId: string | undefined;
    try {
      const prNumber = (uniqueBigint() % 9000) + 1;
      const out = await db.transaction().execute(async (tx) => {
        reviewId = await upsertReview(tx, { provider: "github", repoId: seed.githubRepoId, prNumber, providerPrId: "n1", prNodeId: "n1", branch: "main" });
        return allocateRun(tx, { reviewId, installationId: seed.installationId, triggerType: "pr_opened", triggeredBy: "user:octocat", provider: "github", deliveryId: "delivery-1", clock: CLOCK });
      });

      expect(out.supersededRunId).toBeNull();
      expect(out.wasSupersede).toBe(false);
      expect((await runState(out.newRunId)).lifecycle_state).toBe("PENDING");
      expect(await currentRunId(reviewId!)).toBe(out.newRunId);
      expect(await eventTypesFor(out.newRunId)).toContain("WEBHOOK_RECEIVED");
    } finally {
      await cleanup(seed, reviewId);
    }
  });

  it("allocateRun: second allocate SUPERSEDES the first (cancels it, RUN_SUPERSEDED, flips pointer)", async () => {
    const seed = await seedTenant();
    let reviewId: string | undefined;
    try {
      const prNumber = (uniqueBigint() % 9000) + 1;
      const first = await db.transaction().execute(async (tx) => {
        reviewId = await upsertReview(tx, { provider: "github", repoId: seed.githubRepoId, prNumber, providerPrId: "n1", prNodeId: "n1", branch: "main" });
        return allocateRun(tx, { reviewId, installationId: seed.installationId, triggerType: "pr_opened", triggeredBy: null, provider: "github", deliveryId: "d1", clock: CLOCK });
      });
      const second = await db.transaction().execute((tx) =>
        allocateRun(tx, { reviewId: reviewId!, installationId: seed.installationId, triggerType: "pr_synchronize", triggeredBy: null, provider: "github", deliveryId: "d2", clock: CLOCK }),
      );

      expect(second.wasSupersede).toBe(true);
      expect(second.supersededRunId).toBe(first.newRunId);
      const oldRun = await runState(first.newRunId);
      expect(oldRun.lifecycle_state).toBe("CANCELLED");
      expect(oldRun.superseded_by_run_id).toBe(second.newRunId);
      expect(await currentRunId(reviewId!)).toBe(second.newRunId);
      expect(await eventTypesFor(first.newRunId)).toContain("RUN_SUPERSEDED");
    } finally {
      await cleanup(seed, reviewId);
    }
  });

  it("supersedeRun on a review with no active run is a no-op (no emit)", async () => {
    const seed = await seedTenant();
    let reviewId: string | undefined;
    try {
      const prNumber = (uniqueBigint() % 9000) + 1;
      const outcome = await db.transaction().execute(async (tx) => {
        reviewId = await upsertReview(tx, { provider: "github", repoId: seed.githubRepoId, prNumber, providerPrId: "n1", prNodeId: "n1", branch: "main" });
        return supersedeRun(tx, { reviewId, newRunId: newUuid(), provider: "github", clock: CLOCK });
      });
      expect(outcome.oldRunId).toBeNull();
      expect(outcome.wasSupersede).toBe(false);
    } finally {
      await cleanup(seed, reviewId);
    }
  });

  it("allocateRun rejects an unknown trigger_type and a non-transaction executor", async () => {
    const seed = await seedTenant();
    let reviewId: string | undefined;
    try {
      const prNumber = (uniqueBigint() % 9000) + 1;
      reviewId = await db.transaction().execute((tx) =>
        upsertReview(tx, { provider: "github", repoId: seed.githubRepoId, prNumber, providerPrId: "n1", prNodeId: "n1", branch: "main" }),
      );
      const rid = reviewId;
      await expect(
        db.transaction().execute((tx) =>
          allocateRun(tx, { reviewId: rid, installationId: seed.installationId, triggerType: "bogus", triggeredBy: null, provider: "github", deliveryId: null, clock: CLOCK }),
        ),
      ).rejects.toThrow(/TRIGGER_TYPES/);
      // not-in-transaction (bare Kysely engine) → throws
      await expect(
        allocateRun(db, { reviewId: rid, installationId: seed.installationId, triggerType: "pr_opened", triggeredBy: null, provider: "github", deliveryId: null, clock: CLOCK }),
      ).rejects.toThrow(/transaction/);
    } finally {
      await cleanup(seed, reviewId);
    }
  });
});
