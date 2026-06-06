// Integration test for PostgresOutboxRepo (the producer write-surface) — runs against the DISPOSABLE
// Postgres (CODEMASTER_PG_CORE_DSN — localhost:5434 ONLY, NEVER the cluster). Verifies the three append
// methods insert valid core.outbox rows: the sink value, JSONB payload round-trip, installation_id /
// run_id handling, and the ck_outbox_installation_id_required exemption for the reconcile sink.

import { randomInt, randomUUID } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";

import { getPool, disposePool, tenantKysely } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

const repo = new PostgresOutboxRepo();
// A unique tag so each run's rows are isolatable for assertion + cleanup.
const RUN_TAG = `outbox-it-${randomUUID()}`;
const installationId = randomUUID();
const reviewId = randomUUID();
const runId = randomUUID();
const ghRepo = randomInt(1, 2_000_000_000);

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghRepo, `acct-${ghRepo}`],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, 1, $3, NULL)`,
    [reviewId, ghRepo, `pr-${ghRepo}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [runId, reviewId],
  );
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  // Order matters: outbox.run_id → review_runs is ON DELETE RESTRICT, so drop outbox rows first.
  await pool.query(`DELETE FROM core.outbox WHERE delivery_id LIKE $1`, [`${RUN_TAG}%`]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [reviewId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
  await disposePool(INTEGRATION_DSN);
});

async function fetchByDelivery(delivery: string): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT sink, payload, schema_version, run_id, installation_id, state, attempts, delivery_id
       FROM core.outbox WHERE delivery_id = $1`,
    [delivery],
  );
  return res.rows[0];
}

describeDb("PostgresOutboxRepo (integration, disposable PG)", () => {
  describe("the three typed producer methods", () => {
    it("appendReconcile → installation_reconcile sink, NULL installation_id (the schema exemption)", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const delivery = `${RUN_TAG}-reconcile`;
      await repo.appendReconcile({ db, payload: { account: "octo" }, schemaVersion: 1, deliveryId: delivery });
      const row = await fetchByDelivery(delivery);
      expect(row).toBeDefined();
      expect(row!["sink"]).toBe("installation_reconcile");
      expect(row!["installation_id"]).toBeNull();
      expect(row!["run_id"]).toBeNull();
      expect(row!["state"]).toBe("pending");
      expect(Number(row!["attempts"])).toBe(0);
      expect(row!["payload"]).toEqual({ account: "octo" });
    });

    it("appendNonReviewDispatch → temporal_workflow_start sink, installation_id set, NULL run_id", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const delivery = `${RUN_TAG}-nonreview`;
      await repo.appendNonReviewDispatch({
        db,
        workflowType: "syncCodeOwners",
        payload: { workflow_type: "syncCodeOwners", args: [] },
        schemaVersion: 2,
        installationId,
        deliveryId: delivery,
      });
      const row = await fetchByDelivery(delivery);
      expect(row!["sink"]).toBe("temporal_workflow_start");
      expect(row!["installation_id"]).toBe(installationId);
      expect(row!["run_id"]).toBeNull();
    });

    it("appendReviewDispatch → temporal_workflow_start sink, run_id + installation_id both set", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const delivery = `${RUN_TAG}-review`;
      await repo.appendReviewDispatch({
        db,
        runId,
        payload: { workflow_type: "reviewPullRequest", args: [{ pr_id: "x" }] },
        schemaVersion: 2,
        installationId,
        deliveryId: delivery,
      });
      const row = await fetchByDelivery(delivery);
      expect(row!["sink"]).toBe("temporal_workflow_start");
      expect(row!["run_id"]).toBe(runId);
      expect(row!["installation_id"]).toBe(installationId);
      expect(row!["schema_version"]).toBe(2);
    });
  });

  describe("the consumer methods (claim lease + mark transitions)", () => {
    const fakeClock = new FakeClock({ now: new Date("2026-06-06T12:00:00.000Z") });
    const cRepo = new PostgresOutboxRepo({ clock: fakeClock });

    async function seedPending(tag: string): Promise<string> {
      const db = tenantKysely(INTEGRATION_DSN!);
      await cRepo.appendNonReviewDispatch({
        db,
        workflowType: "syncCodeOwners",
        payload: {},
        schemaVersion: 2,
        installationId,
        deliveryId: `${RUN_TAG}-${tag}`,
      });
      const res = await pool.query<{ id: string }>(`SELECT id FROM core.outbox WHERE delivery_id = $1`, [
        `${RUN_TAG}-${tag}`,
      ]);
      return res.rows[0]!.id;
    }
    async function stateOf(id: string): Promise<{ state: string; attempts: number; leased: boolean }> {
      const res = await pool.query<{ state: string; attempts: number; leased_until: Date | null }>(
        `SELECT state, attempts, leased_until FROM core.outbox WHERE id = $1`,
        [id],
      );
      const r = res.rows[0]!;
      return { state: r.state, attempts: Number(r.attempts), leased: r.leased_until !== null };
    }

    it("claimPending claims a pending row, holds the lease, then re-claims after expiry", async () => {
      fakeClock.set({ now: new Date("2026-06-06T12:00:00.000Z") });
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("claim");

      const claim1 = await cRepo.claimPending({ db, leaseSeconds: 60 });
      expect(claim1.some((r) => r.id === id)).toBe(true);

      const claim2 = await cRepo.claimPending({ db, leaseSeconds: 60 });
      expect(claim2.some((r) => r.id === id)).toBe(false); // leased — not re-claimed within the window

      fakeClock.advance({ seconds: 61 });
      const claim3 = await cRepo.claimPending({ db, leaseSeconds: 60 });
      expect(claim3.some((r) => r.id === id)).toBe(true); // lease expired → re-claimable

      await cRepo.markDispatched({ db, id });
    });

    it("markAttemptFailed bumps attempts + releases the lease; markDead is terminal; markDispatched succeeds", async () => {
      const db = tenantKysely(INTEGRATION_DSN!);
      const id = await seedPending("marks");
      await cRepo.claimPending({ db, leaseSeconds: 60 }); // lease it

      await cRepo.markAttemptFailed({ db, id, error: "boom" });
      const s = await stateOf(id);
      expect(s.attempts).toBe(1);
      expect(s.leased).toBe(false); // lease released → immediate retry
      expect(s.state).toBe("pending");

      await cRepo.markDead({ db, id, error: "give up" });
      expect((await stateOf(id)).state).toBe("dead");

      const id2 = await seedPending("dispatched");
      await cRepo.markDispatched({ db, id: id2 });
      expect((await stateOf(id2)).state).toBe("dispatched");
    });
  });
});
