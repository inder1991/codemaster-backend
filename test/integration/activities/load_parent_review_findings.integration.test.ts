import { createHash, randomInt } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { loadParentReviewFindingsActivity } from "#backend/activities/load_parent_review_findings.activity.js";

import { disposeAllPools } from "#platform/db/database.js";

import { LoadParentReviewFindingsInputV1 } from "#contracts/load_parent_review_findings.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the #6 carry-forward parent loader against a DISPOSABLE Postgres
// (localhost:5434/codemaster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb); SKIPS otherwise.
// Seeds the full FK chain (installations → repositories → gh_users → pull_requests) then review_findings
// rows in every lifecycle state, and asserts ONLY the delivered + non-suppressed ones for the PR/tenant
// load + reconstruct correctly.

let pool: Pool;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 6 });
});

afterAll(async () => {
  await pool?.end();
  await disposeAllPools();
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

const ghId = (): number => randomInt(1, 2_000_000_000);

type Seed = {
  installationId: string;
  otherIid: string;
  repositoryId: string;
  ghUserId: string;
  prId: string;
  otherPrId: string;
  reviewId: string;
};
let seed: Seed;
const insertedFindingIds: Array<string> = [];

async function seedChain(): Promise<void> {
  for (const iid of [seed.installationId, seed.otherIid]) {
    await pool.query(
      `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
       VALUES ($1, $2, $3, 'Organization')`,
      [iid, ghId(), `acct-${iid.slice(0, 8)}`],
    );
  }
  await pool.query(
    `INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [seed.repositoryId, seed.installationId, ghId(), `org/repo-${seed.repositoryId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type) VALUES ($1, $2, $3, 'User')`,
    [seed.ghUserId, ghId(), `user-${seed.ghUserId.slice(0, 8)}`],
  );
  let prNum = 1;
  for (const prId of [seed.prId, seed.otherPrId]) {
    await pool.query(
      `INSERT INTO core.pull_requests
         (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
          author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', 'Test PR', 'main', $7, 'feature', $8, now())`,
      [prId, seed.installationId, seed.repositoryId, ghId(), prNum++, seed.ghUserId, "a".repeat(40), "b".repeat(40)],
    );
  }
}

/** Insert one core.review_findings row, satisfying the lifecycle CHECK constraints for its state. */
async function insertFinding(args: {
  installationId: string;
  prId: string;
  file: string;
  title: string;
  deliveryOutcome: "inline_delivered" | "body_only_fallback" | "not_applicable";
  suppressionState?: string;
  citations?: unknown;
  scope?: string;
}): Promise<void> {
  const rfid = newUuid();
  insertedFindingIds.push(rfid);
  const isSkipped = args.deliveryOutcome === "not_applicable";
  const eligibility = isSkipped ? "skipped" : "eligible";
  const eligibilityReason = isSkipped ? "file_not_in_diff" : null;
  const commentId = args.deliveryOutcome === "inline_delivered" ? ghId() : null;
  const suppression = args.suppressionState ?? "NONE";
  const isSuppressed = suppression !== "NONE";
  // ck_review_findings_suppression_metadata: suppressed ⇒ reason + confidence + suppressed_at NOT NULL.
  const suppressionReason = isSuppressed ? "false positive" : null;
  const suppressionConfidence = isSuppressed ? 0.95 : null;
  await pool.query(
    `INSERT INTO core.review_findings (
       review_finding_id, installation_id, pr_id, file_path, start_line, end_line,
       severity, category, title, body, suggestion, confidence, citations, scope, evidence_refs,
       suppression_state, suppression_reason, suppression_confidence, suppressed_at,
       github_comment_id, delivery_eligibility, eligibility_reason, delivery_outcome
     ) VALUES (
       $1,$2,$3,$4,10,12,
       'issue','bug',$5,'Finding body text.',NULL,0.875, CAST($6 AS JSONB), $7, CAST('[]' AS JSONB),
       CAST($8 AS core.suppression_state), $9, $10, ${isSuppressed ? "now()" : "NULL"},
       $11,
       CAST($12 AS core.delivery_eligibility), CAST($13 AS core.finding_eligibility_reason),
       CAST($14 AS core.delivery_outcome)
     )`,
    [
      rfid,
      args.installationId,
      args.prId,
      args.file,
      args.title,
      JSON.stringify(args.citations ?? []),
      args.scope ?? "chunk_observed",
      suppression,
      suppressionReason,
      suppressionConfidence,
      commentId,
      eligibility,
      eligibilityReason,
      args.deliveryOutcome,
    ],
  );
}

describeDb("loadParentReviewFindingsActivity (#6 carry-forward loader, disposable PG)", () => {
  beforeEach(async () => {
    seed = {
      installationId: newUuid(),
      otherIid: newUuid(),
      repositoryId: newUuid(),
      ghUserId: newUuid(),
      prId: newUuid(),
      otherPrId: newUuid(),
      reviewId: newUuid(),
    };
    insertedFindingIds.length = 0;
    await seedChain();
  });

  afterEach(async () => {
    if (insertedFindingIds.length > 0) {
      await pool.query(`DELETE FROM core.review_findings WHERE review_finding_id = ANY($1::uuid[])`, [
        insertedFindingIds,
      ]);
    }
    await pool.query(`DELETE FROM core.pull_requests WHERE pr_id = ANY($1::uuid[])`, [
      [seed.prId, seed.otherPrId],
    ]);
    await pool.query(`DELETE FROM core.repositories WHERE repository_id = $1`, [seed.repositoryId]);
    await pool.query(`DELETE FROM core.gh_users WHERE gh_user_id = $1`, [seed.ghUserId]);
    await pool.query(`DELETE FROM core.installations WHERE installation_id = ANY($1::uuid[])`, [
      [seed.installationId, seed.otherIid],
    ]);
  });

  function input(): LoadParentReviewFindingsInputV1 {
    return LoadParentReviewFindingsInputV1.parse({
      installation_id: seed.installationId,
      pr_id: seed.prId,
      review_id: seed.reviewId,
    });
  }

  it("loads ONLY delivered + non-suppressed findings for the PR/tenant; reconstructs the fields", async () => {
    await insertFinding({
      installationId: seed.installationId,
      prId: seed.prId,
      file: "src/a.ts",
      title: "Null deref",
      deliveryOutcome: "inline_delivered",
      citations: [{ kind: "repo_path", locator: "src/a.ts", excerpt: null }],
    });
    await insertFinding({
      installationId: seed.installationId,
      prId: seed.prId,
      file: "src/b.ts",
      title: "Body-only finding",
      deliveryOutcome: "body_only_fallback",
    });
    await insertFinding({
      installationId: seed.installationId,
      prId: seed.prId,
      file: "src/c.ts",
      title: "Skipped",
      deliveryOutcome: "not_applicable",
    }); // EXCLUDED (skipped)
    await insertFinding({
      installationId: seed.installationId,
      prId: seed.prId,
      file: "src/d.ts",
      title: "Suppressed",
      // body_only (NOT inline — ck_lifecycle_suppressed_no_inline forbids suppressed+inline) + suppressed.
      deliveryOutcome: "body_only_fallback",
      suppressionState: "SUPPRESSED_BY_LLM",
    }); // EXCLUDED (suppressed)
    await insertFinding({
      installationId: seed.installationId,
      prId: seed.otherPrId,
      file: "src/e.ts",
      title: "Other PR",
      deliveryOutcome: "inline_delivered",
    }); // EXCLUDED (different PR)
    await insertFinding({
      installationId: seed.otherIid,
      prId: seed.prId,
      file: "src/f.ts",
      title: "Other tenant",
      deliveryOutcome: "inline_delivered",
    }); // EXCLUDED (different tenant)

    const result = await loadParentReviewFindingsActivity(input());

    expect(result.parent_findings.map((f) => f.title)).toEqual(["Null deref", "Body-only finding"]);
    expect(result.parent_review_id).toBe(seed.reviewId);
    const a = result.parent_findings[0]!;
    expect(a.file).toBe("src/a.ts");
    expect(a.start_line).toBe(10);
    expect(a.end_line).toBe(12);
    expect(a.severity).toBe("issue");
    expect(a.confidence).toBeCloseTo(0.875, 3);
    expect(a.sources).toEqual([{ kind: "repo_path", locator: "src/a.ts", excerpt: null }]);
    expect(a.scope).toBe("chunk_observed");
  });

  it("returns parent_review_id=null + [] when the PR has no live findings", async () => {
    await insertFinding({
      installationId: seed.installationId,
      prId: seed.prId,
      file: "src/x.ts",
      title: "Skipped only",
      deliveryOutcome: "not_applicable",
    });
    const result = await loadParentReviewFindingsActivity(input());
    expect(result.parent_findings).toEqual([]);
    expect(result.parent_review_id).toBeNull();
  });
});
