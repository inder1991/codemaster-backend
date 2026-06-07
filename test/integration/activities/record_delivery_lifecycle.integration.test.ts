import { createHash, randomInt } from "node:crypto";

import { ApplicationFailure } from "@temporalio/common";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  recordDeliveryFinalized,
  recordDeliverySkipped,
  recordDeliveryDegraded,
} from "#backend/activities/record_delivery_lifecycle.activity.js";
import { PostgresReviewFindingsRepo } from "#backend/domain/repos/review_findings_repo.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";
import { disposeAllPools } from "#platform/db/database.js";

import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { FinalizedInputV1, SkippedInputV1, DegradedInputV1 } from "#contracts/finding_lifecycle_inputs.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the THREE finding-delivery lifecycle setter activities, against the
// DISPOSABLE Postgres (migrations applied). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb);
// SKIPS otherwise so validate-fast stays green without a DB. NEVER touches any other DB. Each test uses a
// UNIQUE installation_id so per-tenant rows never collide, and cleans up its FK chain in `finally`.
//
// The activities are thin wrappers — 1:1 in intent with the frozen Python lifecycle_activities.py
// (RecordDeliveryFinalizedActivity / RecordDeliverySkippedActivity / RecordDeliveryDegradedActivity).
// The repo-level flips are proved exhaustively in review_findings_repo.integration.test.ts; THIS test
// proves the ACTIVITY layer: (a) the typed input is unpacked + threaded to the repo and the row flips
// land on disk; (b) the activity returns the integer count of rows actually flipped (the Python `int`
// return = len(flipped)); (c) the writes_enabled kill switch (CODEMASTER_LIFECYCLE_WRITES_ENABLED) gates
// the write; (d) a repo invariant violation (ValueError analogue) is re-raised as a NON-RETRYABLE
// ApplicationFailure with the Python type string.

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;
let repo: PostgresReviewFindingsRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // The activities read the DSN from process.env; mirror it so the seeding repo + the activity-owned repo
  // both point at the disposable DB. Default the kill switch ON for this file (individual tests override).
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
  process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED = "true";
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
  repo = new PostgresReviewFindingsRepo({
    db: db as unknown as ConstructorParameters<typeof PostgresReviewFindingsRepo>[0]["db"],
    clock: FIXED_CLOCK,
  });
});

afterAll(async () => {
  await db?.destroy(); // also ends the `pool` it was constructed over (do NOT also call pool.end()).
  await disposeAllPools(); // the activity-owned shared pool teardown (ADR-0062)
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

type Seed = {
  installationId: string;
  prId: string;
  reviewId: string;
  currentRunId: string;
  ghUserId: string;
};

/**
 * Seed the FK chain (installation → repository → gh_user → pull_request) + a pull_request_reviews row
 * with its authoritative current_run_id (the circular-FK insert dance: review with NULL pointer → run →
 * UPDATE pointer). Mirrors review_findings_repo.integration.test.ts::seedTenant. (The lifecycle setters
 * pass a NEW run/review per call as their stale-write keys, but the persistAggregated seed write needs a
 * real current_run_id.)
 */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const repositoryId = newUuid();
  const ghUserId = newUuid();
  const prId = newUuid();
  const reviewId = newUuid();
  const currentRunId = newUuid();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();
  const ghUser = uniqueBigint();
  const ghPr = uniqueBigint();

  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `org/repo-${ghRepo}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type) VALUES ($1, $2, $3, 'User')`,
    [ghUserId, ghUser, `user-${ghUser}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
        state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 'Test PR', 'main', $7, 'feature', $8, now())`,
    [prId, installationId, repositoryId, ghPr, (ghPr % 9999) + 1, ghUserId, "a".repeat(40), "b".repeat(40)],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, NULL)`,
    [reviewId, ghRepo, (ghPr % 9999) + 1, `pr-${ghRepo}-${ghPr}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [currentRunId, reviewId],
  );
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    currentRunId,
    reviewId,
  ]);
  return { installationId, prId, reviewId, currentRunId, ghUserId };
}

async function seedPostedReview(prId: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.posted_reviews (pr_id, marker) VALUES ($1, $2) ON CONFLICT (pr_id) DO NOTHING`,
    [prId, "<!-- codemaster -->"],
  );
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.review_findings WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.posted_reviews WHERE pr_id = $1`, [seed.prId]);
  await pool.query(`DELETE FROM audit.workflow_events WHERE review_id = $1`, [seed.reviewId]);
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = $1`, [
    seed.reviewId,
  ]);
  await pool.query(`DELETE FROM core.review_runs WHERE review_id = $1`, [seed.reviewId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
  await pool.query(`DELETE FROM core.pull_requests WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.gh_users WHERE gh_user_id = $1`, [seed.ghUserId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

function mkFinding(file: string): AggregatedFindingsV1["findings"][number] {
  return {
    schema_version: 1,
    file,
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: `t-${file}`,
    body: "body",
    suggestion: null,
    confidence: 0.6,
    sources: [],
    scope: "chunk_observed",
    evidence_refs: [],
  };
}

/** Seed N findings via persistAggregated, return their ids + a posted_reviews row to FK against. The
 *  ids are returned MUTABLE (`Array<string>`) so they assign cleanly into the contract's `rfids: string[]`. */
async function seedFindings(seed: Seed, files: ReadonlyArray<string>): Promise<Array<string>> {
  const ids = await repo.persistAggregated({
    prId: seed.prId,
    installationId: seed.installationId,
    aggregated: {
      schema_version: 1,
      findings: files.map(mkFinding),
      dedupe_stats: {
        input_count: files.length,
        exact_dropped: 0,
        semantic_merged: 0,
        capped: 0,
        semantic_skipped: false,
      },
      policy_revision: 0,
    },
    runId: seed.currentRunId,
    reviewId: seed.reviewId,
  });
  await seedPostedReview(seed.prId);
  return [...ids];
}

async function readRow(rfid: string): Promise<{
  delivery_eligibility: string | null;
  delivery_outcome: string | null;
  github_comment_id: string | null;
  eligibility_reason: string | null;
  posted_review_pr_id: string | null;
}> {
  const r = await pool.query(
    `SELECT delivery_eligibility, delivery_outcome, github_comment_id::text AS github_comment_id,
            eligibility_reason, posted_review_pr_id::text AS posted_review_pr_id
       FROM core.review_findings WHERE review_finding_id = $1`,
    [rfid],
  );
  return r.rows[0];
}

// ─── recordDeliveryFinalized ────────────────────────────────────────────────────────────────────────

describeDb("recordDeliveryFinalized activity (integration, disposable PG)", () => {
  it("flips rows to inline_delivered, returns the count flipped, and is idempotent", async () => {
    const seed = await seedTenant();
    try {
      const ids = await seedFindings(seed, ["f.py"]);
      const inp: FinalizedInputV1 = {
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: ids,
        comment_ids: [12345],
        posted_review_pr_id: seed.prId,
      };

      const flipped = await recordDeliveryFinalized(inp);
      expect(flipped).toBe(1); // count of rows flipped (Python `int` return = len(flipped))

      const row = await readRow(ids[0]!);
      expect(row.delivery_eligibility).toBe("eligible");
      expect(row.delivery_outcome).toBe("inline_delivered");
      expect(Number(row.github_comment_id)).toBe(12345);
      expect(row.posted_review_pr_id).toBe(seed.prId);

      // Idempotent: a second call finds delivery_outcome already set → 0 flipped.
      const second = await recordDeliveryFinalized({ ...inp, comment_ids: [99999] });
      expect(second).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("re-raises a length-mismatch (ValueError analogue) as a non-retryable ApplicationFailure", async () => {
    const seed = await seedTenant();
    try {
      const inp: FinalizedInputV1 = {
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: [newUuid(), newUuid()],
        comment_ids: [1], // mismatch
        posted_review_pr_id: seed.prId,
      };
      await expect(recordDeliveryFinalized(inp)).rejects.toBeInstanceOf(ApplicationFailure);
      await expect(recordDeliveryFinalized(inp)).rejects.toMatchObject({
        nonRetryable: true,
        type: "FinalizedParityViolation",
      });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("writes_enabled=false (env off) returns 0 and writes nothing", async () => {
    const seed = await seedTenant();
    const prev = process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED;
    try {
      const ids = await seedFindings(seed, ["g.py"]);
      process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED = "false";
      const flipped = await recordDeliveryFinalized({
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: ids,
        comment_ids: [7],
        posted_review_pr_id: seed.prId,
      });
      expect(flipped).toBe(0);
      const row = await readRow(ids[0]!);
      expect(row.delivery_outcome).toBeNull(); // untouched
    } finally {
      process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED = prev;
      await cleanupTenant(seed);
    }
  });
});

// ─── recordDeliverySkipped ──────────────────────────────────────────────────────────────────────────

describeDb("recordDeliverySkipped activity (integration, disposable PG)", () => {
  it("flips rows to not_applicable/skipped with per-row reason and returns the count", async () => {
    const seed = await seedTenant();
    try {
      const ids = await seedFindings(seed, ["s.py"]);
      const flipped = await recordDeliverySkipped({
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: ids,
        reasons: ["line_in_unchanged_gap"],
        posted_review_pr_id: seed.prId,
      });
      expect(flipped).toBe(1);

      const row = await readRow(ids[0]!);
      expect(row.delivery_eligibility).toBe("skipped");
      expect(row.delivery_outcome).toBe("not_applicable");
      expect(row.eligibility_reason).toBe("line_in_unchanged_gap");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("re-raises an unknown eligibility_reason as a non-retryable ApplicationFailure", async () => {
    const seed = await seedTenant();
    try {
      const ids = await seedFindings(seed, ["s2.py"]);
      const inp: SkippedInputV1 = {
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: ids,
        reasons: ["not_a_real_reason"],
        posted_review_pr_id: seed.prId,
      };
      await expect(recordDeliverySkipped(inp)).rejects.toMatchObject({
        nonRetryable: true,
        type: "SkippedParityViolation",
      });
    } finally {
      await cleanupTenant(seed);
    }
  });
});

// ─── recordDeliveryDegraded ─────────────────────────────────────────────────────────────────────────

describeDb("recordDeliveryDegraded activity (integration, disposable PG)", () => {
  it("flips rows to a degraded outcome and returns the count", async () => {
    const seed = await seedTenant();
    try {
      const ids = await seedFindings(seed, ["d.py"]);
      const flipped = await recordDeliveryDegraded({
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: ids,
        outcome: "body_only_fallback",
        posted_review_pr_id: seed.prId,
      });
      expect(flipped).toBe(1);

      const row = await readRow(ids[0]!);
      expect(row.delivery_eligibility).toBe("eligible");
      expect(row.delivery_outcome).toBe("body_only_fallback");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("re-raises an out-of-set outcome as a non-retryable ApplicationFailure (even with writes off)", async () => {
    const seed = await seedTenant();
    const prev = process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED;
    try {
      process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED = "false";
      const inp: DegradedInputV1 = {
        schema_version: 1,
        installation_id: seed.installationId,
        run_id: newUuid(),
        review_id: newUuid(),
        rfids: [newUuid()],
        outcome: "failed", // a VALID degraded outcome at the contract layer …
        posted_review_pr_id: seed.prId,
      };
      // … but if we hand the repo an out-of-set outcome directly the repo raises BEFORE the writes_enabled
      // short-circuit. The contract's regex would reject a truly-bogus value, so exercise the repo guard by
      // passing an outcome the finalize/skip setters own (inline_delivered) past the contract via a cast.
      const bad = { ...inp, outcome: "inline_delivered" } as DegradedInputV1;
      await expect(recordDeliveryDegraded(bad)).rejects.toMatchObject({
        nonRetryable: true,
        type: "DegradedOutcomeViolation",
      });
    } finally {
      process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED = prev;
      await cleanupTenant(seed);
    }
  });
});
