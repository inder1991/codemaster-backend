/**
 * Integration test for the webhook-persistence SPINE (W3) — persistWebhook end-to-end + the route via
 * app.inject — against the DISPOSABLE Postgres (:5434, NEVER the cluster). Proves the F1→F3 loop: a
 * pull_request.opened webhook produces the audit row + idempotency row + review + PENDING run +
 * current_run_id flip + exactly one temporal_workflow_start outbox row carrying a valid v2
 * ReviewPullRequestPayloadV1 with workflow_type="reviewPullRequest".
 */

import { createHash, createHmac, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildApp } from "#backend/api/app.js";
import { registerGithubWebhookRoutes } from "#backend/api/github_webhook_routes.js";
import { persistWebhook } from "#backend/ingest/github_webhook_persistence.js";

import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

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

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}
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

type Seed = { installationId: string; githubInstallationId: number; githubRepoId: number; prNumber: number };

async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const githubInstallationId = uniqueBigint();
  const githubRepoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9000) + 1;
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
  return { installationId, githubInstallationId, githubRepoId, prNumber };
}

function prBody(seed: Seed, action = "opened"): string {
  const account = { id: 7, login: "octocat", type: "User" };
  return JSON.stringify({
    action,
    number: seed.prNumber,
    pull_request: {
      number: seed.prNumber,
      title: "Add widget",
      body: "a description",
      node_id: `PR_kw${seed.prNumber}`,
      head: { sha: "a".repeat(40), repo: { full_name: `octo/repo-${seed.githubRepoId}` }, ref: "feat/x" },
      base: { sha: "b".repeat(40), repo: { full_name: `octo/repo-${seed.githubRepoId}` }, ref: "main" },
      user: account,
      draft: false,
      merged: false,
      id: 99,
      created_at: "2026-01-01T00:00:00Z",
    },
    repository: {
      id: seed.githubRepoId,
      full_name: `octo/repo-${seed.githubRepoId}`,
      owner: { id: 1, login: "octo", type: "Organization" },
    },
    installation: { id: seed.githubInstallationId },
    sender: account,
  });
}

async function cleanup(seed: Seed): Promise<void> {
  // FK order: core.outbox + audit.workflow_events + audit.webhook_events all reference review_runs(run_id),
  // and pull_request_reviews.current_run_id too — clear the referrers before the runs.
  await pool.query(`DELETE FROM core.outbox WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(
    `DELETE FROM audit.workflow_events WHERE review_id IN (SELECT review_id FROM core.pull_request_reviews WHERE repo_id = $1)`,
    [seed.githubRepoId],
  );
  await pool.query(`DELETE FROM audit.webhook_events WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM cache.cache_idempotency WHERE cache_key LIKE $1`, [
    `github-webhook:${seed.githubInstallationId}:%`,
  ]);
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE repo_id = $1`, [
    seed.githubRepoId,
  ]);
  await pool.query(
    `DELETE FROM core.review_runs WHERE review_id IN (SELECT review_id FROM core.pull_request_reviews WHERE repo_id = $1)`,
    [seed.githubRepoId],
  );
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE repo_id = $1`, [seed.githubRepoId]);
  await pool.query(`DELETE FROM core.repositories WHERE github_repo_id = $1`, [seed.githubRepoId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

describeDb("github webhook persistence spine (integration, disposable PG)", () => {
  it("pull_request.opened → audit + idempotency + review + PENDING run + ONE outbox row (valid v2 payload)", async () => {
    const seed = await seedTenant();
    const delivery = `d-${seed.githubRepoId}-1`;
    try {
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(prBody(seed)),
        headers: { "x-github-delivery": delivery, "x-github-event": "pull_request" },
        signatureValid: true,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);
      expect(result.installationId).toBe(seed.installationId);

      // (1) audit row, run_id backfilled
      const audit = await pool.query<{ run_id: string | null }>(
        `SELECT run_id FROM audit.webhook_events WHERE webhook_event_id = $1`,
        [result.webhookEventId],
      );
      expect(audit.rows[0]!.run_id).not.toBeNull();

      // (2) idempotency row
      const idem = await pool.query(`SELECT 1 FROM cache.cache_idempotency WHERE cache_key = $1`, [
        `github-webhook:${seed.githubInstallationId}:${delivery}`,
      ]);
      expect(idem.rows).toHaveLength(1);

      // (4) review + PENDING run + current_run_id
      const review = await pool.query<{ review_id: string; current_run_id: string | null }>(
        `SELECT review_id, current_run_id FROM core.pull_request_reviews WHERE repo_id = $1 AND pr_number = $2`,
        [seed.githubRepoId, seed.prNumber],
      );
      expect(review.rows).toHaveLength(1);
      const run = await pool.query<{ lifecycle_state: string }>(
        `SELECT lifecycle_state FROM core.review_runs WHERE run_id = $1`,
        [review.rows[0]!.current_run_id],
      );
      expect(run.rows[0]!.lifecycle_state).toBe("PENDING");

      // (5) exactly ONE outbox row, correct sink + payload
      const outbox = await pool.query<{ sink: string; installation_id: string; payload: Record<string, unknown> }>(
        `SELECT sink, installation_id, payload FROM core.outbox WHERE installation_id = $1`,
        [seed.installationId],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]!.sink).toBe("temporal_workflow_start");
      const payload = outbox.rows[0]!.payload;
      expect(payload["workflow_type"]).toBe("reviewPullRequest");
      const args = payload["args"] as Array<unknown>;
      const reviewPayload = ReviewPullRequestPayloadV1.parse(args[0]); // valid v2 envelope
      expect(reviewPayload.run_id).toBe(review.rows[0]!.current_run_id);
      expect(reviewPayload.review_id).toBe(review.rows[0]!.review_id);
      expect(reviewPayload.pr_number).toBe(seed.prNumber);
      expect(reviewPayload.github_installation_id).toBe(seed.githubInstallationId);
    } finally {
      await cleanup(seed);
    }
  });

  it("re-delivery of the same x-github-delivery is deduped (no second run / outbox row)", async () => {
    const seed = await seedTenant();
    const delivery = `d-${seed.githubRepoId}-redeliver`;
    const body = new TextEncoder().encode(prBody(seed));
    try {
      const first = await persistWebhook({ db, body, headers: { "x-github-delivery": delivery, "x-github-event": "pull_request" }, signatureValid: true, clock: CLOCK });
      const second = await persistWebhook({ db, body, headers: { "x-github-delivery": delivery, "x-github-event": "pull_request" }, signatureValid: true, clock: CLOCK });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      const outbox = await pool.query(`SELECT 1 FROM core.outbox WHERE installation_id = $1`, [seed.installationId]);
      expect(outbox.rows).toHaveLength(1); // not two
      const runs = await pool.query(
        `SELECT 1 FROM core.review_runs WHERE review_id IN (SELECT review_id FROM core.pull_request_reviews WHERE repo_id = $1)`,
        [seed.githubRepoId],
      );
      expect(runs.rows).toHaveLength(1);
    } finally {
      await cleanup(seed);
    }
  });

  it("invalid signature → audit row written, NO idempotency / outbox row (forensics-first)", async () => {
    const seed = await seedTenant();
    const delivery = `d-${seed.githubRepoId}-spoof`;
    try {
      const result = await persistWebhook({
        db,
        body: new TextEncoder().encode(prBody(seed)),
        headers: { "x-github-delivery": delivery, "x-github-event": "pull_request" },
        signatureValid: false,
        clock: CLOCK,
      });
      expect(result.deduped).toBe(false);
      const audit = await pool.query(`SELECT 1 FROM audit.webhook_events WHERE webhook_event_id = $1`, [result.webhookEventId]);
      expect(audit.rows).toHaveLength(1); // audit written
      const idem = await pool.query(`SELECT 1 FROM cache.cache_idempotency WHERE cache_key = $1`, [
        `github-webhook:${seed.githubInstallationId}:${delivery}`,
      ]);
      expect(idem.rows).toHaveLength(0); // NOT cached
      const outbox = await pool.query(`SELECT 1 FROM core.outbox WHERE installation_id = $1`, [seed.installationId]);
      expect(outbox.rows).toHaveLength(0); // NOT enqueued
    } finally {
      await cleanup(seed);
    }
  });

  it("route (app.inject): valid HMAC → 204 + outbox row; invalid → 401 + audit row (persist-before-401)", async () => {
    const seed = await seedTenant();
    const secret = "whsec_test_secret";
    const app = buildApp();
    await registerGithubWebhookRoutes(app, {
      secretProvider: { currentSecret: async () => new TextEncoder().encode(secret) },
      persist: (a) =>
        persistWebhook({ db, body: a.body, headers: a.headers, signatureValid: a.signatureValid, clock: CLOCK }),
    });
    const validDelivery = `d-${seed.githubRepoId}-route-ok`;
    const spoofDelivery = `d-${seed.githubRepoId}-route-spoof`;
    try {
      const body = prBody(seed);
      const sig = "sha256=" + createHmac("sha256", Buffer.from(secret)).update(Buffer.from(body)).digest("hex");

      const ok = await app.inject({
        method: "POST",
        url: "/v1/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "pull_request",
          "x-github-delivery": validDelivery,
        },
        payload: body,
      });
      expect(ok.statusCode).toBe(204);
      const outbox = await pool.query(`SELECT 1 FROM core.outbox WHERE installation_id = $1`, [seed.installationId]);
      expect(outbox.rows).toHaveLength(1);

      const spoof = await app.inject({
        method: "POST",
        url: "/v1/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
          "x-github-event": "pull_request",
          "x-github-delivery": spoofDelivery,
        },
        payload: body,
      });
      expect(spoof.statusCode).toBe(401);
      const spoofAudit = await pool.query(`SELECT 1 FROM audit.webhook_events WHERE delivery_id = $1`, [spoofDelivery]);
      expect(spoofAudit.rows).toHaveLength(1); // forensic audit written even for the spoof
    } finally {
      await app.close();
      await cleanup(seed);
    }
  });
});
