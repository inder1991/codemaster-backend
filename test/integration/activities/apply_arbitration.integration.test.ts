import { createHash, randomInt } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { applyArbitrationActivity } from "#backend/activities/apply_arbitration.activity.js";
import {
  ArbitrationRejectionsRepo,
  type InsertRejectionInput,
} from "#backend/domain/repos/arbitration_rejections_repo.js";

import { disposeAllPools, getPool } from "#platform/db/database.js";

import { ApplyArbitrationInputV1 } from "#contracts/apply_arbitration_input.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied — core.arbitration_rejections
// from migration 0086 + core.review_findings suppression columns from 0083). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. We NEVER touch any other DB. Every test
// uses a UNIQUE installation_id; the FK chain is seeded + cleaned per test.
//
// Two surfaces:
//   1. ArbitrationRejectionsRepo.insertRejection — round-trip + ON CONFLICT (run_id, target_finding_id,
//      reason_rejected) idempotency + tenancy column.
//   2. applyArbitrationActivity end-to-end — arbitrate() + persist (Tier-1 INSERT into review_findings +
//      rejection rows), driven by the env-var DSN exactly as the worker constructs it.

let pool: Pool;
let rejectionsRepo: ArbitrationRejectionsRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = getPool(INTEGRATION_DSN);
  rejectionsRepo = ArbitrationRejectionsRepo.fromDsn(INTEGRATION_DSN);
});

afterAll(async () => {
  await disposeAllPools();
});

/** Deterministic-ish UUID for test fixtures (NOT security-sensitive; unique-per-call). */
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

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  ghUserId: string;
  prId: string;
  reviewId: string;
  currentRunId: string;
};

/** Seed installation → repository → gh_user → pull_request → pull_request_reviews → review_runs. */
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
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
     VALUES ($1, $2, $3, 'User')`,
    [ghUserId, ghUser, `user-${ghUser}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
        author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 'Test PR',
             'main', $7, 'feature', $8, now())`,
    [prId, installationId, repositoryId, ghPr, (ghPr % 9999) + 1, ghUserId, "a".repeat(40), "b".repeat(40)],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
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
  return { installationId, repositoryId, ghUserId, prId, reviewId, currentRunId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.arbitration_rejections WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.review_findings WHERE installation_id = $1`, [seed.installationId]);
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

function rejectionInput(seed: Seed, overrides: Partial<InsertRejectionInput> = {}): InsertRejectionInput {
  return {
    installationId: seed.installationId,
    runId: seed.currentRunId,
    reviewId: seed.reviewId,
    targetFindingId: newUuid(),
    reasonRejected: "policy_forbids",
    intentConfidence: "0.99",
    intentReason: "swears it is a test fixture",
    suppressionModel: "claude-test",
    suppressionPromptVersion: "v1",
    ...overrides,
  };
}

describeDb("ArbitrationRejectionsRepo (integration, disposable PG)", () => {
  it("insertRejection round-trips a row; ON CONFLICT (run_id, target, reason) is idempotent", async () => {
    const seed = await seedTenant();
    try {
      const input = rejectionInput(seed);
      await rejectionsRepo.insertRejection(input);

      const row = await pool.query<{
        installation_id: string;
        target_finding_id: string;
        reason_rejected: string;
        intent_confidence: string;
        intent_reason: string;
        suppression_model: string;
      }>(
        `SELECT installation_id, target_finding_id, reason_rejected, intent_confidence,
                intent_reason, suppression_model
           FROM core.arbitration_rejections WHERE run_id = $1`,
        [seed.currentRunId],
      );
      expect(row.rows).toHaveLength(1);
      const r = row.rows[0]!;
      expect(r.installation_id).toBe(seed.installationId);
      expect(r.target_finding_id).toBe(input.targetFindingId);
      expect(r.reason_rejected).toBe("policy_forbids");
      // numeric column ingested the canonical-decimal string losslessly.
      expect(Number(r.intent_confidence)).toBe(0.99);
      expect(r.intent_reason).toBe("swears it is a test fixture");
      expect(r.suppression_model).toBe("claude-test");

      // Re-insert the SAME (run, target, reason) → DO NOTHING; still exactly one row.
      await rejectionsRepo.insertRejection(input);
      const n = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.arbitration_rejections WHERE run_id = $1`,
        [seed.currentRunId],
      );
      expect(Number(n.rows[0]?.n)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("null intent_confidence + intent_reason persist as NULL (target_not_found path)", async () => {
    const seed = await seedTenant();
    try {
      await rejectionsRepo.insertRejection(
        rejectionInput(seed, {
          reasonRejected: "target_not_found",
          intentConfidence: null,
          intentReason: null,
        }),
      );
      const row = await pool.query<{ intent_confidence: string | null; intent_reason: string | null }>(
        `SELECT intent_confidence, intent_reason FROM core.arbitration_rejections WHERE run_id = $1`,
        [seed.currentRunId],
      );
      expect(row.rows[0]!.intent_confidence).toBeNull();
      expect(row.rows[0]!.intent_reason).toBeNull();
    } finally {
      await cleanupTenant(seed);
    }
  });
});

describeDb("applyArbitrationActivity (integration, disposable PG)", () => {
  it("end-to-end: a SUPPRESS-honored Tier-1 finding → review_findings row + a rejected ghost intent → rejection row", async () => {
    const seed = await seedTenant();
    const prevDsn = process.env.CODEMASTER_PG_CORE_DSN;
    const prevClock = process.env.CODEMASTER_FAKE_CLOCK_ISO;
    process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
    process.env.CODEMASTER_FAKE_CLOCK_ISO = "2099-03-04T05:06:07.000Z";
    try {
      const t1Id = newUuid();
      const ghostId = newUuid();
      const input = ApplyArbitrationInputV1.parse({
        installation_id: seed.installationId,
        pr_id: seed.prId,
        run_id: seed.currentRunId,
        review_id: seed.reviewId,
        tier1_findings: [
          {
            finding_id: t1Id,
            tool: "ruff",
            rule_id: "F401",
            file: "src/app.py",
            start_line: 7,
            end_line: 7,
            severity_raw: "warning",
            message: "unused import os",
          },
        ],
        tier2_findings: [],
        tier2_review_finding_id_by_arbitration_id: {},
        intents: [
          // honored: ruff F401 @ 0.95 ≥ min 0.90 → SUPPRESSED_BY_LLM
          { target_finding_id: t1Id, confidence: "0.95", reason: "side-effect import" },
          // ghost: no matching tier-1 finding → rejected target_not_found
          { target_finding_id: ghostId, confidence: "0.80", reason: "hallucinated" },
        ],
        model: "claude-test",
        prompt_version: "v1",
        now: "2099-03-04T05:06:07+00:00",
      });

      const result = await applyArbitrationActivity(input);

      // Returned result (for the workflow-body footer): one SUPPRESSED_BY_LLM decision + one rejection.
      const suppressed = result.decisions.filter((d) => d.suppression_state === "SUPPRESSED_BY_LLM");
      expect(suppressed).toHaveLength(1);
      expect(result.rejected_intents.some((r) => r.reason_rejected === "target_not_found")).toBe(true);

      // The Tier-1 finding landed in review_findings. insert_tier1_finding uses the AnalysisFindingV1
      // finding_id AS the review_finding_id directly (NOT a uuid5 derivation — that is the Tier-2 path).
      const expectedRfid = t1Id;
      const findingRow = await pool.query<{
        tier: number;
        source_tool: string;
        suppression_state: string;
        suppression_confidence: string;
        suppression_model: string;
        suppressed_at: Date;
      }>(
        `SELECT tier, source_tool, suppression_state, suppression_confidence, suppression_model, suppressed_at
           FROM core.review_findings WHERE review_finding_id = $1 AND installation_id = $2`,
        [expectedRfid, seed.installationId],
      );
      expect(findingRow.rows).toHaveLength(1);
      const fr = findingRow.rows[0]!;
      expect(fr.tier).toBe(1);
      expect(fr.source_tool).toBe("ruff");
      expect(fr.suppression_state).toBe("SUPPRESSED_BY_LLM");
      expect(Number(fr.suppression_confidence)).toBe(0.95);
      expect(fr.suppression_model).toBe("claude-test");

      // The ghost intent landed as a rejection row.
      const rejRow = await pool.query<{ reason_rejected: string; target_finding_id: string }>(
        `SELECT reason_rejected, target_finding_id FROM core.arbitration_rejections
           WHERE run_id = $1 AND reason_rejected = 'target_not_found'`,
        [seed.currentRunId],
      );
      expect(rejRow.rows).toHaveLength(1);
      expect(rejRow.rows[0]!.target_finding_id).toBe(ghostId);

      // Idempotent re-run: same inputs → no row drift.
      await applyArbitrationActivity(input);
      const findCount = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.review_findings WHERE installation_id = $1`,
        [seed.installationId],
      );
      const rejCount = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.arbitration_rejections WHERE run_id = $1`,
        [seed.currentRunId],
      );
      expect(Number(findCount.rows[0]?.n)).toBe(1);
      expect(Number(rejCount.rows[0]?.n)).toBe(1);
    } finally {
      restoreEnv("CODEMASTER_PG_CORE_DSN", prevDsn);
      restoreEnv("CODEMASTER_FAKE_CLOCK_ISO", prevClock);
      await cleanupTenant(seed);
    }
  });
});

/** Restore (or delete) an env var to its prior value after a test mutates it. */
function restoreEnv(key: "CODEMASTER_PG_CORE_DSN" | "CODEMASTER_FAKE_CLOCK_ISO", prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}
