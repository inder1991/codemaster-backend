import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  deriveReviewFindingId,
  PostgresReviewFindingsRepo,
} from "#backend/domain/repos/review_findings_repo.js";
import { StaleWriteError } from "#backend/domain/stale_write_guard.js";

import { TenancyPlugin } from "#platform/db/tenancy_plugin.js";
import { FakeClock } from "#platform/clock.js";

import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green
// without a DB. We NEVER touch any other DB. Every test uses a UNIQUE installation_id so per-tenant
// rows never collide, and cleans up its FK chain in afterEach-style `finally` blocks.

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;
let repo: PostgresReviewFindingsRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // ADR-0062: ONE memoized pool + Kysely (TenancyPlugin installed) for the whole file.
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new TenancyPlugin()],
  });
  // The repo's Kysely DB schema is internal; cast the bare instance through unknown for the test
  // harness (the repo only needs the TenancyPlugin-installed engine).
  repo = new PostgresReviewFindingsRepo({
    db: db as unknown as ConstructorParameters<typeof PostgresReviewFindingsRepo>[0]["db"],
    clock: FIXED_CLOCK,
  });
});

afterAll(async () => {
  await db?.destroy();
});

/** Deterministic UUID for test fixtures (NOT security-sensitive; just a unique-per-call id). */
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
  ghUserId: string;
  prId: string;
  /** core.pull_request_reviews.review_id — FK target of audit.workflow_events.review_id. */
  reviewId: string;
  /** The run set as core.pull_request_reviews.current_run_id (the AUTHORITATIVE run for this review). */
  currentRunId: string;
};

/**
 * Seed the FK chain (installation → repository → gh_user → pull_request) for one tenant, PLUS a
 * core.pull_request_reviews row and the core.review_runs row that is its authoritative current_run_id.
 *
 * The stale-write guard now wired into persistAggregated reads
 * core.pull_request_reviews.current_run_id under FOR SHARE and throws StaleWriteError unless the caller
 * passes runId === current_run_id, so every persistAggregated call in this suite must reference a real
 * (review_id, current_run_id) pair. The review→run→review insert dance resolves the circular FK
 * (review_runs.review_id RESTRICT vs pull_request_reviews.current_run_id SET NULL): INSERT the review
 * with current_run_id NULL, INSERT the run, then UPDATE current_run_id.
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
  // pull_request_reviews + review_runs (circular-FK insert dance; see docstring).
  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, NULL)`,
    [reviewId, ghRepo, (ghPr % 9999) + 1, `pr-${ghRepo}-${ghPr}`],
  );
  await seedRun(reviewId, currentRunId);
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    currentRunId,
    reviewId,
  ]);
  return { installationId, repositoryId, ghUserId, prId, reviewId, currentRunId };
}

/** Seed a core.review_runs row for `reviewId` (FK target of workflow_events.run_id; review FK RESTRICT). */
async function seedRun(reviewId: string, runId: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [runId, reviewId],
  );
}

/** Count audit.workflow_events rows of a given event_type for a review (chain-link assertions). */
async function countEvents(reviewId: string, eventType: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit.workflow_events WHERE review_id = $1 AND event_type = $2`,
    [reviewId, eventType],
  );
  return Number(r.rows[0]?.n);
}

/** Count core.review_findings rows for a tenant. */
async function countFindings(installationId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM core.review_findings WHERE installation_id = $1`,
    [installationId],
  );
  return Number(r.rows[0]?.n);
}

/** Seed a posted_reviews row (FK target for posted_review_pr_id; pr_id is its PK). */
async function seedPostedReview(prId: string): Promise<void> {
  // Default publication_outcome='degraded_unposted' + github_review_id NULL satisfies the IFF CHECK.
  await pool.query(
    `INSERT INTO core.posted_reviews (pr_id, marker) VALUES ($1, $2)
     ON CONFLICT (pr_id) DO NOTHING`,
    [prId, "<!-- codemaster -->"],
  );
}

/** Delete the whole FK chain for a tenant (findings first — installations FK is ON DELETE RESTRICT). */
async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.review_findings WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.posted_reviews WHERE pr_id = $1`, [seed.prId]);
  // workflow_events (run_id/review_id FK RESTRICT) must go before the runs/review. Then null the
  // review's current_run_id pointer so review_runs can be deleted (review_runs.review_id is RESTRICT).
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

/** Build an AggregatedFindingsV1 with the given findings (already-validated shapes). */
function aggregatedOf(findings: AggregatedFindingsV1["findings"]): AggregatedFindingsV1 {
  return {
    schema_version: 1,
    findings,
    dedupe_stats: {
      input_count: findings.length,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    },
    policy_revision: 0,
  };
}

describeDb("PostgresReviewFindingsRepo (integration, disposable PG)", () => {
  it("persistAggregated round-trips findings; ids are uuid5-derived and ON CONFLICT-idempotent", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        {
          schema_version: 1,
          file: "src/app.py",
          start_line: 10,
          end_line: 12,
          severity: "issue",
          category: "bug",
          title: "Off-by-one",
          body: "The loop bound is wrong.",
          suggestion: "Use <= instead of <.",
          confidence: 0.875,
          sources: [{ kind: "repo_path", locator: "src/app.py", excerpt: null }],
          scope: "chunk_observed",
          evidence_refs: ["ev_0123456789abcdef"],
        },
        {
          schema_version: 1,
          file: "src/db.py",
          start_line: 5,
          end_line: 5,
          severity: "blocker",
          category: "security",
          title: "SQLi",
          body: "Unparameterized query.",
          suggestion: null,
          confidence: 1.0,
          sources: [],
          scope: "cross_chunk",
          evidence_refs: [],
        },
      ]);

      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });

      // Returned ids are uuid5-derived (stable per finding tuple), in input order.
      expect(ids.length).toBe(2);
      expect(ids[0]).toBe(
        deriveReviewFindingId({
          prId: seed.prId,
          file: "src/app.py",
          startLine: 10,
          endLine: 12,
          severity: "issue",
          title: "Off-by-one",
        }),
      );

      // Read-back equals (byte-faithful JSONB + numeric + scope + evidence_refs).
      const rows = await pool.query<{
        review_finding_id: string;
        file_path: string;
        start_line: number;
        end_line: number;
        severity: string;
        category: string;
        title: string;
        body: string;
        suggestion: string | null;
        confidence: string;
        citations: unknown;
        policy_metadata: unknown;
        scope: string;
        evidence_refs: unknown;
        tier: number;
        created_at: Date;
      }>(
        `SELECT review_finding_id, file_path, start_line, end_line, severity, category, title, body,
                suggestion, confidence, citations, policy_metadata, scope, evidence_refs, tier, created_at
           FROM core.review_findings
          WHERE installation_id = $1 ORDER BY start_line`,
        [seed.installationId],
      );
      expect(rows.rows.length).toBe(2);
      const first = rows.rows.find((r) => r.file_path === "src/db.py")!; // start_line 5
      const second = rows.rows.find((r) => r.file_path === "src/app.py")!; // start_line 10
      expect(first.severity).toBe("blocker");
      expect(first.category).toBe("security");
      expect(Number(first.confidence)).toBe(1.0);
      expect(first.scope).toBe("cross_chunk");
      expect(first.evidence_refs).toEqual([]);
      expect(first.citations).toEqual([]);
      expect(first.policy_metadata).toEqual({});
      expect(first.tier).toBe(2); // column DEFAULT

      expect(second.suggestion).toBe("Use <= instead of <.");
      expect(Number(second.confidence)).toBe(0.875);
      expect(second.scope).toBe("chunk_observed");
      expect(second.evidence_refs).toEqual(["ev_0123456789abcdef"]);
      expect(second.citations).toEqual([
        { kind: "repo_path", locator: "src/app.py", excerpt: null },
      ]);
      // created_at honored the injected clock.
      expect(new Date(second.created_at).toISOString()).toBe("2099-03-04T05:06:07.000Z");

      // Idempotent re-persist (ON CONFLICT (review_finding_id) DO NOTHING) — same ids, no duplication.
      const ids2 = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      expect(ids2).toEqual(ids);
      const countAfter = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.review_findings WHERE installation_id = $1`,
        [seed.installationId],
      );
      expect(Number(countAfter.rows[0]?.n)).toBe(2);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("persistAggregated with 0 findings returns [] and writes no rows", async () => {
    const seed = await seedTenant();
    try {
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated: aggregatedOf([]),
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      expect(ids).toEqual([]);
      const n = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.review_findings WHERE installation_id = $1`,
        [seed.installationId],
      );
      expect(Number(n.rows[0]?.n)).toBe(0);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("persistAggregated writes per-finding policy_metadata aligned by index", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        {
          schema_version: 1,
          file: "a.py",
          start_line: 1,
          end_line: 1,
          severity: "nit",
          category: "style",
          title: "T0",
          body: "b0",
          suggestion: null,
          confidence: 0.5,
          sources: [],
          scope: "chunk_observed",
          evidence_refs: [],
        },
        {
          schema_version: 1,
          file: "b.py",
          start_line: 2,
          end_line: 2,
          severity: "nit",
          category: "style",
          title: "T1",
          body: "b1",
          suggestion: null,
          confidence: 0.5,
          sources: [],
          scope: "chunk_observed",
          evidence_refs: [],
        },
      ]);
      await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
        policyMetadata: [{ rule: "R0", matched: true }], // index 1 out-of-range → {} default
      });
      const rows = await pool.query<{ title: string; policy_metadata: unknown }>(
        `SELECT title, policy_metadata FROM core.review_findings WHERE installation_id = $1`,
        [seed.installationId],
      );
      const byTitle = new Map(rows.rows.map((r) => [r.title, r.policy_metadata]));
      expect(byTitle.get("T0")).toEqual({ rule: "R0", matched: true });
      expect(byTitle.get("T1")).toEqual({}); // out-of-range → column default semantics
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("tenant isolation: a query for installation A does not see B's rows", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    try {
      const mk = (file: string): AggregatedFindingsV1 =>
        aggregatedOf([
          {
            schema_version: 1,
            file,
            start_line: 1,
            end_line: 1,
            severity: "issue",
            category: "bug",
            title: `t-${file}`,
            body: "x",
            suggestion: null,
            confidence: 0.9,
            sources: [],
            scope: "chunk_observed",
            evidence_refs: [],
          },
        ]);
      await repo.persistAggregated({
        prId: a.prId,
        installationId: a.installationId,
        aggregated: mk("a.py"),
        runId: a.currentRunId,
        reviewId: a.reviewId,
      });
      await repo.persistAggregated({
        prId: b.prId,
        installationId: b.installationId,
        aggregated: mk("b.py"),
        runId: b.currentRunId,
        reviewId: b.reviewId,
      });

      // Flip A's row to skipped so it surfaces in fetchSkippedForWalkthrough.
      const aIds = await pool.query<{ id: string }>(
        `SELECT review_finding_id AS id FROM core.review_findings WHERE installation_id = $1`,
        [a.installationId],
      );
      await seedPostedReview(a.prId);
      await repo.recordDeliverySkipped({
        installationId: a.installationId,
        rfids: aIds.rows.map((r) => r.id),
        reasons: ["file_not_in_diff"],
        postedReviewPrId: a.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: true,
      });

      // A's walkthrough read sees only A's row; querying with B's installation returns nothing.
      const aSkipped = await repo.fetchSkippedForWalkthrough({
        installationId: a.installationId,
        prId: a.prId,
      });
      expect(aSkipped.map((r) => r.filePath)).toEqual(["a.py"]);

      const bForA = await repo.fetchSkippedForWalkthrough({
        installationId: b.installationId,
        prId: a.prId, // B's tenant, A's pr — tenant filter must yield nothing
      });
      expect(bForA).toEqual([]);
    } finally {
      await cleanupTenant(a);
      await cleanupTenant(b);
    }
  });

  it("insertTier1Finding inserts a tier-1 row with suppression metadata; ON CONFLICT idempotent", async () => {
    const seed = await seedTenant();
    try {
      const rfid = newUuid();
      const suppressedAt = new Date("2099-03-04T05:06:07.000Z");
      await repo.insertTier1Finding({
        installationId: seed.installationId,
        prId: seed.prId,
        reviewFindingId: rfid,
        file: "src/secrets.py",
        startLine: 3,
        endLine: 3,
        tool: "gitleaks",
        ruleId: "aws-access-token",
        suppressionState: "SUPPRESSED_BY_LLM",
        suppressionReason: "test fixture, not a real secret",
        suppressionConfidence: 0.95,
        suppressionModel: "claude-test",
        suppressionPromptVersion: "v1",
        suppressedAt,
      });

      const row = await pool.query<{
        title: string;
        body: string;
        severity: string;
        category: string;
        confidence: string;
        tier: number;
        source_tool: string;
        scope: string;
        suppression_state: string;
        suppression_confidence: string;
      }>(
        `SELECT title, body, severity, category, confidence, tier, source_tool, scope,
                suppression_state, suppression_confidence
           FROM core.review_findings WHERE review_finding_id = $1`,
        [rfid],
      );
      const r = row.rows[0]!;
      expect(r.title).toBe("gitleaks:aws-access-token");
      expect(r.body).toBe("gitleaks:aws-access-token");
      expect(r.severity).toBe("issue");
      expect(r.category).toBe("other");
      expect(Number(r.confidence)).toBe(1.0);
      expect(r.tier).toBe(1);
      expect(r.source_tool).toBe("gitleaks");
      expect(r.scope).toBe("chunk_observed");
      expect(r.suppression_state).toBe("SUPPRESSED_BY_LLM");
      expect(Number(r.suppression_confidence)).toBe(0.95);

      // Idempotent re-insert (same rfid) — DO NOTHING; still exactly one row.
      await repo.insertTier1Finding({
        installationId: seed.installationId,
        prId: seed.prId,
        reviewFindingId: rfid,
        file: "src/secrets.py",
        startLine: 3,
        endLine: 3,
        tool: "gitleaks",
        ruleId: "aws-access-token",
        suppressionState: "SUPPRESSED_BY_LLM",
        suppressionReason: "test fixture, not a real secret",
        suppressionConfidence: 0.95,
        suppressionModel: "claude-test",
        suppressionPromptVersion: "v1",
        suppressedAt,
      });
      const n = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM core.review_findings WHERE review_finding_id = $1`,
        [rfid],
      );
      expect(Number(n.rows[0]?.n)).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("updateTier2Arbitration sets suppression metadata under the tenant WHERE; no cross-tenant write", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        {
          schema_version: 1,
          file: "x.py",
          start_line: 1,
          end_line: 1,
          severity: "issue",
          category: "bug",
          title: "tier2",
          body: "body",
          suggestion: null,
          confidence: 0.7,
          sources: [],
          scope: "chunk_observed",
          evidence_refs: [],
        },
      ]);
      const ids = await repo.persistAggregated({
        prId: a.prId,
        installationId: a.installationId,
        aggregated,
        runId: a.currentRunId,
        reviewId: a.reviewId,
      });
      const rfid = ids[0]!;

      // Wrong-tenant update is a no-op (WHERE installation_id = B excludes A's row).
      await repo.updateTier2Arbitration({
        installationId: b.installationId,
        reviewFindingId: rfid,
        suppressionState: "SUPPRESSED_BY_POLICY",
        suppressionReason: "should not apply",
        suppressionConfidence: 0.1,
        suppressionModel: "m",
        suppressionPromptVersion: "v1",
        suppressedAt: new Date("2099-03-04T05:06:07.000Z"),
      });
      let row = await pool.query<{ suppression_state: string; tier: number }>(
        `SELECT suppression_state, tier FROM core.review_findings WHERE review_finding_id = $1`,
        [rfid],
      );
      expect(row.rows[0]?.suppression_state).toBe("NONE"); // untouched by the wrong tenant

      // Correct-tenant update applies.
      await repo.updateTier2Arbitration({
        installationId: a.installationId,
        reviewFindingId: rfid,
        suppressionState: "SUPPRESSED_BY_POLICY",
        suppressionReason: "duplicate of policy rule",
        suppressionConfidence: 0.88,
        suppressionModel: "claude-test",
        suppressionPromptVersion: "v2",
        suppressedAt: new Date("2099-03-04T05:06:07.000Z"),
      });
      row = await pool.query<{ suppression_state: string; tier: number }>(
        `SELECT suppression_state, tier FROM core.review_findings WHERE review_finding_id = $1`,
        [rfid],
      );
      expect(row.rows[0]?.suppression_state).toBe("SUPPRESSED_BY_POLICY");
      expect(row.rows[0]?.tier).toBe(2);
    } finally {
      await cleanupTenant(a);
      await cleanupTenant(b);
    }
  });

  it("recordDeliveryFinalized flips rows to inline_delivered and is idempotent + writes_enabled-gated", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        {
          schema_version: 1,
          file: "f.py",
          start_line: 1,
          end_line: 1,
          severity: "issue",
          category: "bug",
          title: "final",
          body: "body",
          suggestion: null,
          confidence: 0.6,
          sources: [],
          scope: "chunk_observed",
          evidence_refs: [],
        },
      ]);
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      await seedPostedReview(seed.prId);

      // writes_enabled=false → no DB access, returns [].
      const disabled = await repo.recordDeliveryFinalized({
        installationId: seed.installationId,
        rfids: ids,
        commentIds: [12345],
        postedReviewPrId: seed.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: false,
      });
      expect(disabled).toEqual([]);

      const flipped = await repo.recordDeliveryFinalized({
        installationId: seed.installationId,
        rfids: ids,
        commentIds: [12345],
        postedReviewPrId: seed.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: true,
      });
      expect(flipped).toEqual(ids);

      const row = await pool.query<{
        delivery_eligibility: string;
        delivery_outcome: string;
        github_comment_id: string;
        posted_review_pr_id: string;
      }>(
        `SELECT delivery_eligibility, delivery_outcome, github_comment_id, posted_review_pr_id
           FROM core.review_findings WHERE review_finding_id = $1`,
        [ids[0]],
      );
      expect(row.rows[0]?.delivery_eligibility).toBe("eligible");
      expect(row.rows[0]?.delivery_outcome).toBe("inline_delivered");
      expect(Number(row.rows[0]?.github_comment_id)).toBe(12345);
      expect(row.rows[0]?.posted_review_pr_id).toBe(seed.prId);

      // Idempotent: a second call finds delivery_outcome already set → flips nothing.
      const second = await repo.recordDeliveryFinalized({
        installationId: seed.installationId,
        rfids: ids,
        commentIds: [99999],
        postedReviewPrId: seed.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: true,
      });
      expect(second).toEqual([]);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordDeliveryFinalized raises on rfids/comment_ids length mismatch BEFORE any DB write", async () => {
    const seed = await seedTenant();
    try {
      await expect(
        repo.recordDeliveryFinalized({
          installationId: seed.installationId,
          rfids: [newUuid(), newUuid()],
          commentIds: [1], // mismatch
          postedReviewPrId: seed.prId,
          runId: newUuid(),
          reviewId: newUuid(),
          writesEnabled: true,
        }),
      ).rejects.toThrow(/length mismatch/);
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordDeliverySkipped flips rows to not_applicable/skipped and rejects unknown reasons", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        {
          schema_version: 1,
          file: "s.py",
          start_line: 1,
          end_line: 1,
          severity: "suggestion",
          category: "style",
          title: "skip",
          body: "body",
          suggestion: null,
          confidence: 0.4,
          sources: [],
          scope: "chunk_observed",
          evidence_refs: [],
        },
      ]);
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      await seedPostedReview(seed.prId);

      // Unknown eligibility reason rejected BEFORE DB access.
      await expect(
        repo.recordDeliverySkipped({
          installationId: seed.installationId,
          rfids: ids,
          reasons: ["not_a_real_reason"],
          postedReviewPrId: seed.prId,
          runId: newUuid(),
          reviewId: newUuid(),
          writesEnabled: true,
        }),
      ).rejects.toThrow(/unknown eligibility_reason/);

      const flipped = await repo.recordDeliverySkipped({
        installationId: seed.installationId,
        rfids: ids,
        reasons: ["line_in_unchanged_gap"],
        postedReviewPrId: seed.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: true,
      });
      expect(flipped).toEqual(ids);

      const row = await pool.query<{
        delivery_eligibility: string;
        delivery_outcome: string;
        eligibility_reason: string;
      }>(
        `SELECT delivery_eligibility, delivery_outcome, eligibility_reason
           FROM core.review_findings WHERE review_finding_id = $1`,
        [ids[0]],
      );
      expect(row.rows[0]?.delivery_eligibility).toBe("skipped");
      expect(row.rows[0]?.delivery_outcome).toBe("not_applicable");
      expect(row.rows[0]?.eligibility_reason).toBe("line_in_unchanged_gap");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("recordDeliveryDegraded flips to a degraded outcome and rejects an out-of-set outcome", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        {
          schema_version: 1,
          file: "d.py",
          start_line: 1,
          end_line: 1,
          severity: "issue",
          category: "bug",
          title: "degraded",
          body: "body",
          suggestion: null,
          confidence: 0.6,
          sources: [],
          scope: "chunk_observed",
          evidence_refs: [],
        },
      ]);
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      await seedPostedReview(seed.prId);

      // Out-of-set outcome rejected BEFORE the writes_enabled short-circuit (even with writes off).
      await expect(
        repo.recordDeliveryDegraded({
          installationId: seed.installationId,
          rfids: ids,
          outcome: "inline_delivered", // owned by finalize, not degraded
          postedReviewPrId: seed.prId,
          runId: newUuid(),
          reviewId: newUuid(),
          writesEnabled: false,
        }),
      ).rejects.toThrow(/not in/);

      const flipped = await repo.recordDeliveryDegraded({
        installationId: seed.installationId,
        rfids: ids,
        outcome: "body_only_fallback",
        postedReviewPrId: seed.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: true,
      });
      expect(flipped).toEqual(ids);

      const row = await pool.query<{ delivery_eligibility: string; delivery_outcome: string }>(
        `SELECT delivery_eligibility, delivery_outcome
           FROM core.review_findings WHERE review_finding_id = $1`,
        [ids[0]],
      );
      expect(row.rows[0]?.delivery_eligibility).toBe("eligible");
      expect(row.rows[0]?.delivery_outcome).toBe("body_only_fallback");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("fetchSkippedForWalkthrough returns skipped/NONE rows in severity→file→line order", async () => {
    const seed = await seedTenant();
    try {
      // Three skipped findings across severities + a suppressed one that must be EXCLUDED.
      const aggregated = aggregatedOf([
        mkFinding("z.py", 1, "nit", "nit-z"),
        mkFinding("a.py", 5, "blocker", "blk-a"),
        mkFinding("a.py", 1, "blocker", "blk-a-early"),
        mkFinding("m.py", 1, "issue", "iss-m"),
        mkFinding("supp.py", 1, "issue", "suppressed"),
      ]);
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      await seedPostedReview(seed.prId);

      // Suppress the last finding (so the skip setter's suppression_state='NONE' guard skips it AND
      // the read query's suppression filter excludes it).
      const suppId = deriveReviewFindingId({
        prId: seed.prId,
        file: "supp.py",
        startLine: 1,
        endLine: 1,
        severity: "issue",
        title: "suppressed",
      });
      await repo.updateTier2Arbitration({
        installationId: seed.installationId,
        reviewFindingId: suppId,
        suppressionState: "SUPPRESSED_BY_LLM",
        suppressionReason: "noise",
        suppressionConfidence: 0.9,
        suppressionModel: "m",
        suppressionPromptVersion: "v1",
        suppressedAt: new Date("2099-03-04T05:06:07.000Z"),
      });

      // Skip the four NONE-state findings (the suppressed one is guarded out of the flip).
      await repo.recordDeliverySkipped({
        installationId: seed.installationId,
        rfids: ids,
        reasons: ids.map(() => "file_not_in_diff"),
        postedReviewPrId: seed.prId,
        runId: newUuid(),
        reviewId: newUuid(),
        writesEnabled: true,
      });

      const skipped = await repo.fetchSkippedForWalkthrough({
        installationId: seed.installationId,
        prId: seed.prId,
      });
      // Order: blocker(a.py,1) < blocker(a.py,5) < issue(m.py,1) < nit(z.py,1). suppressed excluded.
      expect(skipped.map((r) => `${r.severity}:${r.filePath}:${r.startLine}`)).toEqual([
        "blocker:a.py:1",
        "blocker:a.py:5",
        "issue:m.py:1",
        "nit:z.py:1",
      ]);
      expect(skipped.every((r) => r.eligibilityReason === "file_not_in_diff")).toBe(true);
    } finally {
      await cleanupTenant(seed);
    }
  });

  // ─── Phase 2.1 stale-write gate, part B — guard + FINDINGS_PERSISTED emit wired into persistAggregated ─

  it("HAPPY: persistAggregated(runId=current_run_id) persists findings + emits exactly one FINDINGS_PERSISTED, no STALE_WRITE_BLOCKED", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        mkFinding("h1.py", 1, "issue", "h-1"),
        mkFinding("h2.py", 2, "blocker", "h-2"),
      ]);
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId, // == current_run_id → guard passes
        reviewId: seed.reviewId,
      });
      expect(ids.length).toBe(2);

      // N findings persisted.
      expect(await countFindings(seed.installationId)).toBe(2);
      // Exactly one FINDINGS_PERSISTED milestone; no STALE_WRITE_BLOCKED forensic row.
      expect(await countEvents(seed.reviewId, "FINDINGS_PERSISTED")).toBe(1);
      expect(await countEvents(seed.reviewId, "STALE_WRITE_BLOCKED")).toBe(0);

      // The milestone payload carries the persisted count and the canonical provider.
      const ev = await pool.query<{ payload: { findings_persisted: number }; provider: string }>(
        `SELECT payload, provider FROM audit.workflow_events
          WHERE review_id = $1 AND event_type = 'FINDINGS_PERSISTED'`,
        [seed.reviewId],
      );
      expect(ev.rows[0]?.payload).toEqual({ findings_persisted: 2 });
      expect(ev.rows[0]?.provider).toBe("github");
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("SUPERSEDED: persistAggregated(runId != current_run_id) throws StaleWriteError and rolls back the findings", async () => {
    const seed = await seedTenant();
    // A second, NON-authoritative run on the same review (current_run_id still points at seed.currentRunId).
    const supersededRunId = newUuid();
    try {
      await seedRun(seed.reviewId, supersededRunId);

      const aggregated = aggregatedOf([
        mkFinding("s1.py", 1, "issue", "s-1"),
        mkFinding("s2.py", 2, "issue", "s-2"),
      ]);

      await expect(
        repo.persistAggregated({
          prId: seed.prId,
          installationId: seed.installationId,
          aggregated,
          runId: supersededRunId, // != current_run_id → guard blocks
          reviewId: seed.reviewId,
        }),
      ).rejects.toBeInstanceOf(StaleWriteError);

      // The N findings were NOT persisted — the outer transaction rolled back.
      expect(await countFindings(seed.installationId)).toBe(0);
      // No FINDINGS_PERSISTED milestone was emitted (it never ran — the guard threw first).
      expect(await countEvents(seed.reviewId, "FINDINGS_PERSISTED")).toBe(0);
      // EMPIRICAL PARITY (verified against the frozen Python on a real PG): the STALE_WRITE_BLOCKED
      // forensic row does NOT survive the outer rollback. The guard INSERTs it inside a SAVEPOINT and
      // the caller RELEASEs that savepoint on StaleWriteError, but RELEASE only MERGES the row into the
      // outer transaction — it does not independently commit, so the propagating exception rolls the
      // whole transaction (findings + forensic row) back together. Python's persist_aggregated behaves
      // identically (0 rows). Locking this in as a regression guard against a future "make it survive"
      // change that would silently diverge from the reference.
      expect(await countEvents(seed.reviewId, "STALE_WRITE_BLOCKED")).toBe(0);
    } finally {
      // workflow_events for BOTH runs + both runs are cleaned by run_id-independent review_id deletes,
      // but null the pointer + delete the extra superseded run explicitly first.
      await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [supersededRunId]);
      await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [supersededRunId]);
      await cleanupTenant(seed);
    }
  });

  it("EMPTY: persistAggregated with 0 findings persists nothing but STILL emits FINDINGS_PERSISTED once (BF-8)", async () => {
    const seed = await seedTenant();
    try {
      const ids = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated: aggregatedOf([]),
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      expect(ids).toEqual([]);

      // No findings rows (the bulk INSERT was skipped — empty VALUES is illegal in Postgres) …
      expect(await countFindings(seed.installationId)).toBe(0);
      // … but the milestone STILL fires for a clean PR (BF-8 chain-link (e) fix).
      expect(await countEvents(seed.reviewId, "FINDINGS_PERSISTED")).toBe(1);
      const ev = await pool.query<{ payload: { findings_persisted: number } }>(
        `SELECT payload FROM audit.workflow_events
          WHERE review_id = $1 AND event_type = 'FINDINGS_PERSISTED'`,
        [seed.reviewId],
      );
      expect(ev.rows[0]?.payload).toEqual({ findings_persisted: 0 });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("IDEMPOTENT: a Temporal-retry double-call persists once (ON CONFLICT) and emits FINDINGS_PERSISTED exactly once", async () => {
    const seed = await seedTenant();
    try {
      const aggregated = aggregatedOf([
        mkFinding("i1.py", 1, "issue", "i-1"),
        mkFinding("i2.py", 2, "issue", "i-2"),
      ]);
      const first = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      const second = await repo.persistAggregated({
        prId: seed.prId,
        installationId: seed.installationId,
        aggregated,
        runId: seed.currentRunId,
        reviewId: seed.reviewId,
      });
      // Same uuid5-derived ids both times.
      expect(second).toEqual(first);

      // ON CONFLICT (review_finding_id) DO NOTHING → still exactly N rows.
      expect(await countFindings(seed.installationId)).toBe(2);
      // The pre-emit SELECT dedupes the milestone: emitted EXACTLY ONCE across both calls.
      expect(await countEvents(seed.reviewId, "FINDINGS_PERSISTED")).toBe(1);
    } finally {
      await cleanupTenant(seed);
    }
  });
});

/** Compact ReviewFindingV1 fixture builder for the ordering test. */
function mkFinding(
  file: string,
  startLine: number,
  severity: AggregatedFindingsV1["findings"][number]["severity"],
  title: string,
): AggregatedFindingsV1["findings"][number] {
  return {
    schema_version: 1,
    file,
    start_line: startLine,
    end_line: startLine,
    severity,
    category: "bug",
    title,
    body: "body",
    suggestion: null,
    confidence: 0.5,
    sources: [],
    scope: "chunk_observed",
    evidence_refs: [],
  };
}
