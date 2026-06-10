// test/integration/runner/review_job_shell.integration.test.ts
//
// W5.2 Step 3 (HAPPY PATH): runReviewJob — the non-Temporal review-job shell composes end-to-end.
//
// Enqueue a real payload fixture → run `runOneJob` with `runReviewJob` wired and ALL orchestrate ports +
// the GitHub/LLM/workspace-touching lifecycle activities stubbed at the IN-PROCESS BUNDLE level (counting
// stubs) against :5434 → assert: outcome 'done'; the run lifecycle transitioned (real finalizeReviewRun:
// RUNNING → COMPLETED); the PR mutex acquired by the shell was RELEASED (real releasePrReviewMutexActivity);
// the orchestrate pipeline actually ran (the stub ports were called).
//
// DB-gated (describeDb) against the DISPOSABLE Postgres only — NEVER the cluster. Each test seeds its own FK
// chain (installation → repository → review chain in RUNNING) + cleans it up; the suite-wide beforeEach
// DELETE on core.review_jobs handles the cross-tenant claim() scan (vitest --no-file-parallelism).

import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { randomUUID, randomInt } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { runReviewJob, type LifecycleBundle } from "#backend/runner/review_job_shell.js";
import { releasePrReviewMutexActivity } from "#backend/activities/release_pr_review_mutex.activity.js";
import { finalizeReviewRun } from "#backend/activities/record_review_lifecycle.activity.js";
import { WallClock } from "#platform/clock.js";

import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";
import type { ReviewActivityPorts } from "#backend/review/pipeline/activity_ports.js";
import { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { ComputedPolicyRulesV1 } from "#contracts/policy_compute.v1.js";
import { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { DedupedFindingsV1 } from "#contracts/dedup_findings.v1.js";
import { EmbedQueryResultV1 } from "#contracts/embed_query.v1.js";
import { RetrieveKnowledgeResultV1 } from "#contracts/retrieve_knowledge.v1.js";
import { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { PostedReviewV1, PublicationOutcome } from "#contracts/posted_review.v1.js";
import { PostedCheckRunV1 } from "#contracts/posted_check_run.v1.js";
import { CitationValidationResultV1 } from "#contracts/citation_validation.v1.js";
import { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";

const clock = new WallClock();

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 6 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}
afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  runId: string;
  reviewId: string;
  prNumber: number;
};

/** Seed the FK chain (installation → repository → review chain in RUNNING) so the shell + the real
 *  finalizeReviewRun (RUNNING → COMPLETED) + the mutex acquire all hold. current_run_id = runId so the E4
 *  supersede check passes (the shell is the live run). */
async function seedTenant(prNumber: number): Promise<Seed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const runId = randomUUID();
  const reviewId = randomUUID();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();

  await sql`INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installationId}, ${ghInstall}, ${`acct-${ghInstall}`}, 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
    VALUES (${repositoryId}, ${installationId}, ${ghRepo}, ${`org/repo-${ghRepo}`}, 'main', true)`.execute(db);

  // pull_request_reviews is keyed by review_id (globally unique; no installation_id column). Insert the
  // review FIRST (no current_run_id — its FK targets review_runs), then the run, then point current_run_id
  // at the run so the shell's E4 supersede read (current_run_id === run_id) passes (the shell IS the live run).
  // repo_id MUST equal the seeded repository's github_repo_id so driveTransition's repositories JOIN (the real
  // finalizeReviewRun's RUNNING→COMPLETED path resolves installation_id via github_repo_id = pr.repo_id) holds.
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${ghRepo}, ${prNumber}, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, 'RUNNING', false, now(), now())`.execute(db);
  await sql`UPDATE core.pull_request_reviews SET current_run_id = ${runId} WHERE review_id = ${reviewId}`.execute(db);

  return { installationId, repositoryId, runId, reviewId, prNumber };
}

function payloadFor(seed: Seed): ReviewPullRequestPayloadV1 {
  return ReviewPullRequestPayloadV1.parse({
    schema_version: 2,
    installation_id: seed.installationId,
    repository_id: seed.repositoryId,
    pr_id: randomUUID(),
    pr_number: seed.prNumber,
    head_sha: "0".repeat(40),
    gh_owner: "acme",
    gh_repo_name: "widgets",
    pr_title: "Add widget",
    pr_description: "",
    // No github_installation_id → the enrich/linked-issues/manifest stages skip (fail-open), so the happy
    // path exercises clone→classify→…→post without a real GitHub round-trip.
    delivery_id: `dlv-${seed.reviewId}`,
    policy_revision: 0,
    run_id: seed.runId,
    review_id: seed.reviewId,
  });
}

/** Build counting-stub ReviewActivityPorts (returns minimal valid contract shapes; the happy path runs the
 *  REAL orchestrate over these). `calls` records the dispatch order so the test proves the pipeline ran. */
function makeStubPorts(calls: Array<string>): Partial<ReviewActivityPorts> {
  return {
    clone: async () => {
      calls.push("clone");
      return ClonedRepoV1.parse({ workspace_path: "/ws/abc", repo_path: "/ws/abc/repo", head_sha: "abc1234", byte_size: 10 });
    },
    loadRepoConfig: async () => {
      calls.push("loadRepoConfig");
      return CodemasterConfigV1.parse({ path_filters: [], path_instructions: [] });
    },
    computePolicyRules: async () => {
      calls.push("computePolicyRules");
      return ComputedPolicyRulesV1.parse({ bundles: {} });
    },
    classify: async () => {
      calls.push("classify");
      return FileRoutingV1.parse({ review_files: [], sandbox_files: [], skip_files: [], classifier_failures: [] });
    },
    chunkAndRedact: async () => {
      calls.push("chunkAndRedact");
      return [];
    },
    staticAnalysis: async () => {
      calls.push("staticAnalysis");
      return StaticAnalysisResultV1.parse({ tier1_findings: [], tool_statuses: [] });
    },
    selectCarryForward: async (input) => {
      calls.push("selectCarryForward");
      return CarryForwardSelectionV1.parse({ carried: [], to_review: [...input.current_chunks], parent_review_id: input.parent_review_id });
    },
    embedQuery: async () => {
      calls.push("embedQuery");
      return EmbedQueryResultV1.parse({ vector: [0.1, 0.2, 0.3] });
    },
    retrieveKnowledge: async () => {
      calls.push("retrieveKnowledge");
      return RetrieveKnowledgeResultV1.parse({ items: [], retrieval_degraded: false, degradation_reason: "" });
    },
    reviewChunk: async () => {
      calls.push("reviewChunk");
      return ReviewChunkResponseV1.parse({ findings: [], arbitration_intents: [], sanitization_event: null });
    },
    dedupFindings: async (input) => {
      calls.push("dedupFindings");
      return DedupedFindingsV1.parse({ findings: [...input.llm_findings], semantic_skipped: false });
    },
    aggregate: async (input) => {
      calls.push("aggregate");
      return AggregatedFindingsV1.parse({
        findings: [...input.findings],
        dedupe_stats: { input_count: input.findings.length, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: input.policy_revision,
      });
    },
    persistReviewFindings: async () => {
      calls.push("persistReviewFindings");
      return [];
    },
    generateWalkthrough: async () => {
      calls.push("generateWalkthrough");
      return WalkthroughV1.parse({ tldr: "all good", sanitization_event: null });
    },
    persistReviewWalkthrough: async () => {
      calls.push("persistReviewWalkthrough");
    },
    postReview: async () => {
      calls.push("postReview");
      return PostedReviewV1.parse({
        review_id: 7,
        inline_comment_count: 0,
        publication_outcome: PublicationOutcome.enum.inline_posted,
        comment_ids: [],
        kept_finding_indices: [],
      });
    },
    postCheckRun: async () => {
      calls.push("postCheckRun");
      return PostedCheckRunV1.parse({ check_run_id: 9, was_update: false });
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    // ── optional Stage-3/4/5 ports the happy path dispatches (citation Step 7.5, arbitration Step 7.7,
    //    PR-description appendage in posting) — stubbed so no real wiring (embedder/Vault) is touched ──
    citationValidate: async (input) => {
      calls.push("citationValidate");
      return CitationValidationResultV1.parse({ surviving: [...input.findings], dropped: [] });
    },
    applyArbitration: async () => {
      calls.push("applyArbitration");
      return ArbitrationResultV1.parse({ decisions: [], rejected_intents: [] });
    },
    updatePrDescriptionSummary: async () => {
      calls.push("updatePrDescriptionSummary");
    },
  };
}

/** Build a lifecycle bundle that stubs the GitHub/LLM/workspace-touching dispatches (no-op, counting) but
 *  keeps `finalizeReviewRun` + `releasePrReviewMutexActivity` REAL so the test asserts the DB transition +
 *  the mutex release. `allocateWorkspace` returns a synthetic handle the stub `releaseWorkspace` ignores. */
function makeStubLifecycle(calls: Array<string>): Partial<LifecycleBundle> {
  return {
    postReviewPlaceholder: async () => { calls.push("placeholder"); },
    deleteReviewPlaceholder: async () => { calls.push("deletePlaceholder"); },
    allocateWorkspace: async () => {
      calls.push("allocateWorkspace");
      return { schema_version: 1, workspace_id: randomUUID(), workspace_path: "/ws/abc", lease_key: "lk", pod_name: "pod" } as never;
    },
    releaseWorkspace: async () => { calls.push("releaseWorkspace"); },
    recordReviewLifecycleEvent: async () => { calls.push("recordReviewLifecycleEvent"); },
    // finalizeReviewRun: REAL → transitions the seeded RUNNING run to COMPLETED.
    finalizeReviewRun: async (input) => { calls.push("finalizeReviewRun"); await finalizeReviewRun(input as never); },
    fetchLinkedIssues: async () => { calls.push("fetchLinkedIssues"); return []; },
    fetchSuggestedReviewers: async () => { calls.push("fetchSuggestedReviewers"); return []; },
    fetchManifestSnapshots: async () => { calls.push("fetchManifestSnapshots"); return { manifests: [] }; },
    parseManifestDependencies: async () => { calls.push("parseManifestDependencies"); return { parsed_manifests: [] }; },
    loadParentReviewFindings: async () => { calls.push("loadParentReviewFindings"); return { parent_findings: [], parent_review_id: null }; },
    recordDeliveryFinalized: async () => { calls.push("recordDeliveryFinalized"); return 0; },
    recordDeliverySkipped: async () => { calls.push("recordDeliverySkipped"); return 0; },
    recordDeliveryDegraded: async () => { calls.push("recordDeliveryDegraded"); return 0; },
    // releasePrReviewMutexActivity: REAL → releases the mutex the shell acquired (assert released_at set).
    releasePrReviewMutexActivity: async (mutexId) => { calls.push("releaseMutex"); await releasePrReviewMutexActivity(mutexId); },
  };
}

async function cleanup(seed: Seed): Promise<void> {
  await sql`DELETE FROM core.review_jobs WHERE run_id = ${seed.runId}`.execute(db);
  // The real finalizeReviewRun emits a lifecycle_transition into audit.workflow_events (FK → review_runs);
  // clear it before deleting the run.
  await sql`DELETE FROM audit.workflow_events WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${seed.reviewId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${seed.installationId}`.execute(db);
}

describeDb("runReviewJob — happy path (W5.2 Step 3)", () => {
  it("composes end-to-end → outcome 'done'; run → COMPLETED; mutex released; pipeline ran", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(101);
    try {
      await repo.enqueue({
        runId: seed.runId,
        reviewId: seed.reviewId,
        installationId: seed.installationId,
        payload: payloadFor(seed),
      });

      const calls: Array<string> = [];
      const handler = runReviewJob({
        repo,
        pool,
        dsn: INTEGRATION_DSN!,
        clock,
        // a long renew interval so the loop never fires within the test (the job lease is the clock).
        mutexRenewIntervalS: 999,
        ports: makeStubPorts(calls),
        lifecycle: makeStubLifecycle(calls),
      });

      const res = await runOneJob({
        repo, clock, owner: "shell-w1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler,
      });

      // (1) the job settled DONE.
      expect(res.outcome).toBe("done");
      const job = await repo.getById(res.jobId!);
      expect(job!.state).toBe("done");

      // (2) the shell acquired + persisted the PR mutex, then RELEASED it in the finally (real release).
      expect(job!.mutex_id).toBeTruthy();
      const mutexRow = await sql<{ released_at: string | null }>`
        SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${job!.mutex_id!}`.execute(db);
      expect(mutexRow.rows[0]!.released_at).not.toBeNull();

      // (3) the run lifecycle TRANSITIONED RUNNING → COMPLETED (real finalizeReviewRun).
      const run = await sql<{ lifecycle_state: string }>`
        SELECT lifecycle_state FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(run.rows[0]!.lifecycle_state).toBe("COMPLETED");

      // (4) the orchestrate pipeline actually ran over the in-process stub ports (clone..post..cleanup) and
      // the shell dispatched the lifecycle activities (allocate → finalize → release).
      expect(calls).toContain("clone");
      expect(calls).toContain("postReview");
      expect(calls).toContain("cleanup");
      expect(calls).toContain("allocateWorkspace");
      expect(calls).toContain("finalizeReviewRun");
      expect(calls).toContain("releaseMutex");
      expect(calls).toContain("releaseWorkspace");
    } finally {
      await cleanup(seed);
    }
  });
});
