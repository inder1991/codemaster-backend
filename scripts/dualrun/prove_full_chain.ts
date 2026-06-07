// "Prove the FULL chain" — the operator-gated live dual-run of the REAL review pipeline.
//
// Unlike scripts/dualrun/prove_pipe.ts (which dispatches the thin `reviewSkeleton` spine and proves only
// worker→activity→DataConverter→Postgres→stale-write-guard), this dispatches the REAL `reviewPullRequest`
// workflow — driving the entire chain: gate → placeholder → enrich → allocate → clone → classify →
// [chunk‖static-analysis] → carry-forward → retrieve → fan-out(review via the LLM) → dedup → aggregate →
// post-filter → citation → persist → arbitration → walkthrough → [post‖check] → fix-prompt → lifecycle →
// finalize → cleanup → release-mutex. See docs/runbooks/2026-06-06-orchestrator-live-dual-run.md.
//
// Because the chain CLONES a real repo and REVIEWS via the LLM, the operator MUST point it at a real PR:
// a GitHub App installation that can read the repo + a head_sha that exists. Those come from env (below).
// The worker must already be polling the dualrun task queue (start apps/.../worker/main.ts first) with the
// same DSN + a seeded core.llm_provider_settings (preflight #4 in the runbook).
//
// node:crypto is fine here — scripts/ is outside the clock/random gate's scope.
import { randomInt, randomUUID } from "node:crypto";

import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";

import {
  ReviewPullRequestPayloadV1,
  ReviewPullRequestResultV1,
} from "#contracts/review_pull_request.v1.js";

// ── Config ───────────────────────────────────────────────────────────────────────────────────────────
const DSN = process.env.CODEMASTER_PG_CORE_DSN ?? "";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "dualrun";
// Default MUST match the worker's default task queue (apps/backend/src/worker/temporal_config.ts), so the
// worker actually polls what we dispatch when neither side sets TEMPORAL_TASK_QUEUE.
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "review-pull-request-dualrun";

// The REAL PR to review — the GitHub App installation must be able to clone the repo at head_sha.
const GH_OWNER = process.env.DUALRUN_GH_OWNER ?? "";
const GH_REPO = process.env.DUALRUN_GH_REPO ?? "";
const GH_INSTALLATION_ID = process.env.DUALRUN_GH_INSTALLATION_ID ?? "";
const HEAD_SHA = process.env.DUALRUN_HEAD_SHA ?? "";
const PR_NUMBER = process.env.DUALRUN_PR_NUMBER ?? "";
const BASE_SHA = process.env.DUALRUN_BASE_SHA ?? "0".repeat(40);
const PR_TITLE = process.env.DUALRUN_PR_TITLE ?? "Dual-run full-chain review";

function requireEnv(name: string, value: string): void {
  if (value === "") {
    throw new Error(
      `${name} is required for the full-chain dual-run (it clones + reviews a REAL PR). ` +
        "Set DUALRUN_GH_OWNER, DUALRUN_GH_REPO, DUALRUN_GH_INSTALLATION_ID, DUALRUN_HEAD_SHA, DUALRUN_PR_NUMBER.",
    );
  }
}

function validateConfig(): void {
  if (!DSN.includes("localhost") && !DSN.includes("127.0.0.1")) {
    throw new Error(`refusing a non-localhost DSN (cluster-DB guard): ${DSN}`);
  }
  requireEnv("DUALRUN_GH_OWNER", GH_OWNER);
  requireEnv("DUALRUN_GH_REPO", GH_REPO);
  requireEnv("DUALRUN_GH_INSTALLATION_ID", GH_INSTALLATION_ID);
  requireEnv("DUALRUN_HEAD_SHA", HEAD_SHA);
  requireEnv("DUALRUN_PR_NUMBER", PR_NUMBER);
  if (HEAD_SHA.length !== 40) {
    throw new Error(`DUALRUN_HEAD_SHA must be a 40-char commit sha; got ${HEAD_SHA.length} chars`);
  }
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  prId: string;
  reviewId: string;
  runId: string;
};

/**
 * Seed the FK chain on the disposable PG with the REAL GitHub identifiers so the clone + post activities
 * resolve. Mirrors prove_pipe.ts::seedTenant (installation → repo → gh_user → PR → pull_request_reviews →
 * review_runs, with current_run_id pointed at the run we dispatch so the stale-write guard passes), but
 * uses the operator's real github_installation_id / owner/repo / head_sha. ON CONFLICT-free: every id is
 * freshly minted, so re-running creates a fresh logical review (no cross-run interference).
 */
async function seedTenant(pool: Pool): Promise<Seed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const ghUserId = randomUUID();
  const prId = randomUUID();
  const reviewId = randomUUID();
  const runId = randomUUID();
  const ghRepo = uniqueBigint();
  const ghUser = uniqueBigint();
  const ghPr = uniqueBigint();
  const prNumber = Number(PR_NUMBER);

  await pool.query(
    `INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, Number(GH_INSTALLATION_ID), GH_OWNER],
  );
  await pool.query(
    `INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, ghRepo, `${GH_OWNER}/${GH_REPO}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type) VALUES ($1, $2, $3, 'User')`,
    [ghUserId, ghUser, `user-${ghUser}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
        author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 'main', $8, 'feature', $9, now())`,
    [prId, installationId, repositoryId, ghPr, prNumber, ghUserId, PR_TITLE, BASE_SHA, HEAD_SHA],
  );
  await pool.query(
    `INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, NULL)`,
    [reviewId, ghRepo, prNumber, `pr-${ghRepo}-${ghPr}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type) VALUES ($1, $2, 'pr_opened')`,
    [runId, reviewId],
  );
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    runId,
    reviewId,
  ]);
  return { installationId, repositoryId, prId, reviewId, runId };
}

function buildPayload(seed: Seed): ReviewPullRequestPayloadV1 {
  return ReviewPullRequestPayloadV1.parse({
    schema_version: 2,
    installation_id: seed.installationId,
    repository_id: seed.repositoryId,
    pr_id: seed.prId,
    pr_number: Number(PR_NUMBER),
    head_sha: HEAD_SHA,
    gh_owner: GH_OWNER,
    gh_repo_name: GH_REPO,
    pr_title: PR_TITLE,
    pr_description: "Full-chain dual-run dispatch (scripts/dualrun/prove_full_chain.ts).",
    delivery_id: `dualrun-${randomUUID()}`,
    policy_revision: 0,
    run_id: seed.runId,
    review_id: seed.reviewId,
    github_installation_id: Number(GH_INSTALLATION_ID),
  });
}

async function main(): Promise<void> {
  validateConfig();
  const pool = new Pool({ connectionString: DSN, max: 4 });
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: NAMESPACE });
  try {
    const seed = await seedTenant(pool);
    const payload = buildPayload(seed);

    const workflowId = `review-pr-dualrun-${seed.prId}`;
    process.stdout.write(
      `dispatching reviewPullRequest (workflowId=${workflowId}, ns=${NAMESPACE}, tq=${TASK_QUEUE})\n` +
        `  repo=${GH_OWNER}/${GH_REPO} pr#=${PR_NUMBER} head=${HEAD_SHA.slice(0, 12)} install=${GH_INSTALLATION_ID}\n`,
    );
    const handle = await client.workflow.start("reviewPullRequest", {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [payload],
    });
    process.stdout.write(`workflow started (runId=${handle.firstExecutionRunId}); awaiting result…\n`);
    const result = ReviewPullRequestResultV1.parse(await handle.result());
    process.stdout.write(
      `\nworkflow result: status=${result.status} findings_count=${result.findings_count} ` +
        `publication_outcome=${result.publication_outcome ?? "none"}\n`,
    );

    // ── Verify the side effects landed ───────────────────────────────────────────────────────────────
    const findings = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.review_findings WHERE pr_id = $1 AND installation_id = $2`,
      [seed.prId, seed.installationId],
    );
    const walkthrough = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.review_walkthroughs WHERE review_id = $1`,
      [seed.reviewId],
    );
    const run = await pool.query<{ status: string }>(
      `SELECT status FROM core.review_runs WHERE run_id = $1`,
      [seed.runId],
    );
    const milestones = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.workflow_events WHERE review_id = $1 ORDER BY created_at`,
      [seed.reviewId],
    );

    const findingsCount = Number(findings.rows[0]?.n ?? 0);
    const walkthroughCount = Number(walkthrough.rows[0]?.n ?? 0);
    const runStatus = run.rows[0]?.status ?? "<missing>";
    const milestoneTypes = milestones.rows.map((r) => r.event_type);

    process.stdout.write(`core.review_findings rows:    ${findingsCount}\n`);
    process.stdout.write(`core.review_walkthroughs rows: ${walkthroughCount}\n`);
    process.stdout.write(`core.review_runs.status:       ${runStatus}\n`);
    process.stdout.write(`audit.workflow_events:         ${milestoneTypes.join(" → ")}\n`);

    // Acceptance: the workflow accepted the review, the run finished cleanly (no zombie RUNNING), and the
    // persisted-finding count matches the result's findings_count. findings_count may legitimately be 0
    // for a clean PR — the chain still PASSED (it composed end-to-end); we only FAIL on a non-accepted
    // status, a non-COMPLETED run, or a persisted/result count mismatch.
    const accepted = result.status === "accepted";
    const runDone = runStatus === "COMPLETED";
    const countsMatch = findingsCount === result.findings_count;
    const ok = accepted && runDone && countsMatch;
    if (ok) {
      process.stdout.write(
        `\nFULL-CHAIN DUAL-RUN PASS — the real reviewPullRequest workflow composed end-to-end against ` +
          `live PG + Temporal + the LLM (${findingsCount} finding(s) persisted, run COMPLETED).\n`,
      );
    } else {
      process.stderr.write(
        `\nFULL-CHAIN DUAL-RUN FAIL — accepted=${accepted} runDone=${runDone} ` +
          `countsMatch=${countsMatch} (persisted=${findingsCount} result=${result.findings_count})\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await connection.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `prove_full_chain FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
