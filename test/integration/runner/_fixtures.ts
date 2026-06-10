// test/integration/runner/_fixtures.ts
//
// Shared gate harness for the runner integration suite. The first half (seedRun / seedRunWithState /
// readRun / minimalReviewPayload) is the legacy seam used by review_job_runner / review_jobs_repo /
// runner_loop / reap_stuck_runs. The second half (the `// ── Phase-2 gate harness ──` block) is the
// EXTRACTED reusable pieces of the happy-path shell test (W5.2 Step 3) + the Phase-2 chaos-gate
// collaborators (scripted GH client, counting SDK, counting strict-ledger client). Both the happy-path
// test and the G1 gate file import from here.
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { type Kysely, sql } from "kysely";
import { type Pool } from "pg";
import {
  ReviewPullRequestPayloadV1,
  type ReviewPullRequestPayloadV1 as ReviewPullRequestPayloadV1Type,
} from "#contracts/review_pull_request.v1.js";

/**
 * Seed a real review chain (pull_request_reviews → review_runs) so review_jobs.run_id FK holds.
 * Column sets + UNIQUE indexes verified against :5434/codemaster:
 *  - core.pull_request_reviews NOT NULL: review_id, provider, repo_id(bigint), pr_number, provider_pr_id,
 *    status(CHECK ∈ open|closed|merged), created_at. (repo_id is a GitHub bigint, NOT a hard FK — orphans allowed.)
 *    UNIQUE (provider, provider_pr_id) AND UNIQUE (provider, repo_id, pr_number) — the fixture ties BOTH to the
 *    globally-unique reviewId so parallel/repeated seeds cannot collide (v4 #5).
 *  - core.review_runs NOT NULL: run_id, review_id(FK→pull_request_reviews.review_id), trigger_type
 *    (CHECK ∈ pr_opened|pr_synchronize|manual_rerun|comment_trigger|retry|scheduled), attempt_number(≥1),
 *    lifecycle_state(CHECK ∈ PENDING|RUNNING|WAITING_RETRY|COMPLETED|FAILED|CANCELLED|PARTIAL), is_ephemeral,
 *    started_at, created_at.
 */
export async function seedRun(db: Kysely<unknown>): Promise<{ runId: string; reviewId: string; installationId: string }> {
  return seedRunWithState(db, "PENDING");
}

/**
 * Like {@link seedRun} but seeds the run in an explicit `lifecycle_state` (W5.1b: terminalSettle tests need a
 * run in `RUNNING` so the atomic job+run terminal transition can be asserted from `RUNNING → CANCELLED/FAILED`).
 * The same uniqueness derivation as {@link seedRun} keeps both UNIQUE indexes collision-proof across seeds.
 */
export async function seedRunWithState(
  db: Kysely<unknown>,
  lifecycleState: string,
): Promise<{ runId: string; reviewId: string; installationId: string }> {
  const runId = randomUUID(), reviewId = randomUUID(), installationId = randomUUID();
  // Derive uniqueness from the globally-unique reviewId so NEITHER unique index can flake:
  //   provider_pr_id carries the full reviewId  → UNIQUE (provider, provider_pr_id) holds.
  //   repo_id = 48 bits of the reviewId         → UNIQUE (provider, repo_id, pr_number) holds (collision-proof for tests;
  //   48-bit birthday bound ≈ 16M rows, exact as a JS integer < 2^53, fits the bigint column). pr_number is fixed at 1.
  const repoId = parseInt(reviewId.replace(/-/g, "").slice(0, 12), 16);
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${repoId}, 1, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, ${lifecycleState}, false, now(), now())`.execute(db);
  return { runId, reviewId, installationId };
}

/** Read a run row's lifecycle_state + terminal-timestamp columns for terminalSettle assertions. */
export async function readRun(
  db: Kysely<unknown>,
  runId: string,
): Promise<{ lifecycle_state: string; cancelled_at: string | null; failed_at: string | null; cancel_reason: string | null }> {
  const r = await sql<{
    lifecycle_state: string; cancelled_at: string | null; failed_at: string | null; cancel_reason: string | null;
  }>`SELECT lifecycle_state, cancelled_at, failed_at, cancel_reason FROM core.review_runs WHERE run_id = ${runId}`
    .execute(db);
  return r.rows[0]!;
}

/**
 * A minimal VALID ReviewPullRequestPayloadV1 (inner `schema_version` = 2) tied to a seeded run's ids, so
 * `enqueue` (Task W0.2) accepts it and the durable-argument store round-trips. Phase-1 enqueue tests call
 * `enqueue` with no payload; after W0.2 `enqueue` REQUIRES one — every existing call site threads this.
 *
 * The `s` overload (minimalReviewPayloadForSeed) reuses the run/review/installation ids from `seedRun` so the
 * payload is self-consistent with the FK chain; `repository_id`/`pr_id` are fresh UUIDs (the payload carries
 * GitHub-side identity that need not exist as DB FKs for the enqueue path). The result is parsed through the
 * contract so the fixture itself can never drift from the schema.
 */
export function minimalReviewPayload(
  ids: { runId: string; reviewId: string; installationId: string },
): ReviewPullRequestPayloadV1Type {
  return ReviewPullRequestPayloadV1.parse({
    schema_version: 2,
    installation_id: ids.installationId,
    repository_id: randomUUID(),
    pr_id: randomUUID(),
    pr_number: 1,
    head_sha: "0".repeat(40),
    gh_owner: "acme",
    gh_repo_name: "widgets",
    pr_title: "Add widget",
    pr_description: "",
    delivery_id: `dlv-${ids.reviewId}`,
    policy_revision: 0,
    run_id: ids.runId,
    review_id: ids.reviewId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ── Phase-2 gate harness ──────────────────────────────────────────────────────────────────────────
//
// EXTRACTED from the happy-path shell test (review_job_shell.integration.test.ts, W5.2 Step 3) so BOTH
// the happy path and the G1 abort gates share ONE definition of the seed/payload/stub-port surface.
// Plus the Phase-2 chaos-gate collaborators (scripted GH client, counting SDK, counting strict-ledger
// client) the G1 abort-aware side-effect gates count REAL external calls against.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { randomInt } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import type { LifecycleBundle } from "#backend/runner/review_job_shell.js";
import { releasePrReviewMutexActivity } from "#backend/activities/release_pr_review_mutex.activity.js";
import { finalizeReviewRun } from "#backend/activities/record_review_lifecycle.activity.js";

import type { ReviewActivityPorts } from "#backend/review/pipeline/activity_ports.js";
import {
  type CreatedReviewV1,
  type GhReviewClient,
  type ReviewComment,
} from "#backend/integrations/github/review_client.js";
import { type LlmSdk, LlmClient } from "#backend/integrations/llm/client.js";
import { LlmInvocationLedger } from "#backend/integrations/llm/invocation_ledger.js";
import { sharedClientCollaborators } from "#backend/integrations/llm/client_cache.js";

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

/** A unique 32-bit-ish bigint for github_installation_id / github_repo_id fixtures (no overflow). */
export function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

export type Seed = {
  installationId: string;
  repositoryId: string;
  runId: string;
  reviewId: string;
  prNumber: number;
};

/**
 * Seed the FK chain (installation → repository → review chain in RUNNING) so the shell + the real
 * finalizeReviewRun (RUNNING → COMPLETED) + the mutex acquire all hold. `current_run_id = runId` so the
 * E4 supersede check passes (the shell is the live run); `repo_id = github_repo_id` so driveTransition's
 * repositories JOIN resolves installation_id. EXTRACTED VERBATIM from review_job_shell.integration.test.ts.
 */
export async function seedTenant(db: Kysely<unknown>, prNumber: number): Promise<Seed> {
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

  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${ghRepo}, ${prNumber}, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, 'RUNNING', false, now(), now())`.execute(db);
  await sql`UPDATE core.pull_request_reviews SET current_run_id = ${runId} WHERE review_id = ${reviewId}`.execute(db);

  return { installationId, repositoryId, runId, reviewId, prNumber };
}

/** A minimal VALID ReviewPullRequestPayloadV1 tied to a {@link seedTenant} Seed. No github_installation_id
 *  → the enrich/linked-issues/manifest stages skip (fail-open). EXTRACTED VERBATIM. */
export function payloadFor(seed: Seed): ReviewPullRequestPayloadV1Type {
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
    delivery_id: `dlv-${seed.reviewId}`,
    policy_revision: 0,
    run_id: seed.runId,
    review_id: seed.reviewId,
  });
}

/** Tear down a {@link seedTenant} Seed (jobs → workflow_events → run → review → installation). The repository
 *  row cascades from the installation delete. EXTRACTED VERBATIM (+ explicit posted_reviews / repositories
 *  cleanup so the gate file's doPost-driving scenarios leave no orphan rows). */
export async function cleanup(db: Kysely<unknown>, seed: Seed, opts?: { prId?: string }): Promise<void> {
  await sql`DELETE FROM core.review_jobs WHERE run_id = ${seed.runId}`.execute(db);
  if (opts?.prId !== undefined) {
    await sql`DELETE FROM core.posted_reviews WHERE pr_id = ${opts.prId}`.execute(db);
  }
  // The real finalizeReviewRun emits a lifecycle_transition into audit.workflow_events (FK → review_runs).
  await sql`DELETE FROM audit.workflow_events WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${seed.reviewId}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${seed.repositoryId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${seed.installationId}`.execute(db);
}

/**
 * Counting-stub {@link ReviewActivityPorts} (returns minimal valid contract shapes; the shell runs the REAL
 * orchestrate over these). `calls` records the dispatch order so a test proves the pipeline ran; `overrides`
 * REPLACES specific ports with counting/crashing/abort-firing stubs (the override wins; the rest stay the
 * default counting shape). EXTRACTED from the happy-path test + the `overrides?` merge added for the gates.
 */
export function makeStubPorts(
  calls: Array<string>,
  overrides?: Partial<ReviewActivityPorts>,
): Partial<ReviewActivityPorts> {
  const base: Partial<ReviewActivityPorts> = {
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
  return { ...base, ...(overrides ?? {}) };
}

/**
 * A {@link LifecycleBundle} that stubs the GitHub/LLM/workspace-touching dispatches (no-op, counting) but
 * keeps `finalizeReviewRun` + `releasePrReviewMutexActivity` REAL so a test asserts the DB transition + the
 * mutex release. `overrides` replaces specific entries (the gates swap in a counting releaseWorkspace, etc.).
 * EXTRACTED from the happy-path test + the `overrides?` merge.
 */
export function makeStubLifecycle(
  calls: Array<string>,
  overrides?: Partial<LifecycleBundle>,
): Partial<LifecycleBundle> {
  const base: Partial<LifecycleBundle> = {
    postReviewPlaceholder: async () => { calls.push("placeholder"); },
    deleteReviewPlaceholder: async () => { calls.push("deletePlaceholder"); },
    allocateWorkspace: async () => {
      calls.push("allocateWorkspace");
      return { schema_version: 1, workspace_id: randomUUID(), workspace_path: "/ws/abc", lease_key: "lk", pod_name: "pod" } as never;
    },
    releaseWorkspace: async () => { calls.push("releaseWorkspace"); },
    recordReviewLifecycleEvent: async () => { calls.push("recordReviewLifecycleEvent"); },
    finalizeReviewRun: async (input) => { calls.push("finalizeReviewRun"); await finalizeReviewRun(input as never); },
    fetchLinkedIssues: async () => { calls.push("fetchLinkedIssues"); return []; },
    fetchSuggestedReviewers: async () => { calls.push("fetchSuggestedReviewers"); return []; },
    fetchManifestSnapshots: async () => { calls.push("fetchManifestSnapshots"); return { manifests: [] }; },
    parseManifestDependencies: async () => { calls.push("parseManifestDependencies"); return { parsed_manifests: [] }; },
    loadParentReviewFindings: async () => { calls.push("loadParentReviewFindings"); return { parent_findings: [], parent_review_id: null }; },
    recordDeliveryFinalized: async () => { calls.push("recordDeliveryFinalized"); return 0; },
    recordDeliverySkipped: async () => { calls.push("recordDeliverySkipped"); return 0; },
    recordDeliveryDegraded: async () => { calls.push("recordDeliveryDegraded"); return 0; },
    releasePrReviewMutexActivity: async (mutexId) => { calls.push("releaseMutex"); await releasePrReviewMutexActivity(mutexId); },
  };
  return { ...base, ...(overrides ?? {}) };
}

// ─── makeScriptedGhClient — a recording, programmable GhReviewClient ───────────────────────────────
//
// Structurally satisfies the 6-method GhReviewClient surface doPost consumes. Every createReview /
// updateReview / createIssueComment is RECORDED with a wall-clock `at` timestamp so a gate can assert
// "ZERO writes STARTED after the abort timestamp" (the F7 enforceable guarantee, NOT "zero in-flight").
// `.program(...)` scripts the recovery oracles (findExistingReviewByMarker / listReviewComments) + the
// createReview return sequence so the W3.2 same-run-takeover paths can be driven deterministically.

export type ScriptedGhCall =
  | { method: "createReview"; at: number; comments: ReadonlyArray<ReviewComment> }
  | { method: "updateReview"; at: number; reviewId: number; body: string }
  | { method: "createIssueComment"; at: number; body: string }
  | { method: "findExistingReviewByMarker"; at: number; marker: string }
  | { method: "listReviewComments"; at: number; reviewId: number };

export type ScriptedGhProgram = {
  /** Scripted return sequence for createReview (consumed in order; a value or a thunk). */
  createReview?: Array<CreatedReviewV1 | (() => CreatedReviewV1)>;
  /** Scripted findExistingReviewByMarker result (W3.2 recovery). Default null (no remote review). */
  existingReviewByMarker?: number | null;
  /** Scripted comment ids for listReviewComments (W3.2 recovery). Default []. */
  existingReviewComments?: Array<number>;
  /** Scripted createIssueComment id. Default 1. */
  issueCommentId?: number;
  /** Scripted listIssueComments rows. Default []. */
  existingComments?: Array<{ id: number; body: string }>;
};

export type ScriptedGhClient = {
  client: GhReviewClient;
  /** The append-only recorded call log (with timestamps) — assert call counts / start-after-abort here. */
  calls: Array<ScriptedGhCall>;
  /** (Re)program the recovery oracles + create sequence. Merges over the prior program. */
  program(p: ScriptedGhProgram): void;
  /** Count of the three WRITE methods STARTED at or after `ts` (the abort timestamp). */
  writesStartedAtOrAfter(ts: number): number;
};

export function makeScriptedGhClient(initial?: ScriptedGhProgram): ScriptedGhClient {
  let program: ScriptedGhProgram = { ...(initial ?? {}) };
  let createSeq: Array<CreatedReviewV1 | (() => CreatedReviewV1)> = [...(program.createReview ?? [])];
  const calls: Array<ScriptedGhCall> = [];
  const now = (): number => Date.now(); // test/ is OUT of the clock gate scope; a wall read is fine here.

  const client: GhReviewClient = {
    async findExistingReviewByMarker({ marker }) {
      calls.push({ method: "findExistingReviewByMarker", at: now(), marker });
      return program.existingReviewByMarker ?? null;
    },
    async listReviewComments({ reviewId }) {
      calls.push({ method: "listReviewComments", at: now(), reviewId });
      return [...(program.existingReviewComments ?? [])];
    },
    async createReview({ comments }) {
      calls.push({ method: "createReview", at: now(), comments });
      const next = createSeq.shift();
      if (next === undefined) {
        throw new Error("scripted createReview called more times than programmed");
      }
      return typeof next === "function" ? next() : next;
    },
    async updateReview({ reviewId, body }) {
      calls.push({ method: "updateReview", at: now(), reviewId, body });
    },
    async createIssueComment({ body }) {
      calls.push({ method: "createIssueComment", at: now(), body });
      return program.issueCommentId ?? 1;
    },
    async listIssueComments() {
      return [...(program.existingComments ?? [])];
    },
    async deleteIssueComment() {
      // no-op
    },
  };

  return {
    client,
    calls,
    program(p: ScriptedGhProgram): void {
      program = { ...program, ...p };
      if (p.createReview !== undefined) {
        createSeq = [...p.createReview];
      }
    },
    writesStartedAtOrAfter(ts: number): number {
      return calls.filter(
        (c) =>
          (c.method === "createReview" || c.method === "updateReview" || c.method === "createIssueComment") &&
          c.at >= ts,
      ).length;
    },
  };
}

// ─── makeCountingSdk — a structural LlmSdk that COUNTS createMessage calls ─────────────────────────
//
// Returns a canned VALID tool-use response (empty findings → parses cleanly via parseWithSkipMalformed)
// and records per-call params + the abort-state of the forwarded signal at call time. The count is the
// "no NEW paid call after abort" + "exactly-once across abort+rerun (ledger HIT)" oracle.

export type CountingSdkCall = {
  at: number;
  model: string;
  role: "primary" | "secondary";
  /** Whether the forwarded signal was already aborted when createMessage was entered (always false on a
   *  real paid call — the client gates BEFORE forwarding; a true here would mean the gate leaked). */
  signalAborted: boolean;
};

export type CountingSdk = {
  sdk: LlmSdk;
  /** Append-only log of every createMessage entry. `calls.length` is the SDK call count. */
  calls: Array<CountingSdkCall>;
};

/** A canned Anthropic Messages-API tool-use response with EMPTY findings (parses to zero findings). */
function cannedToolUseResponse(): Record<string, unknown> {
  return {
    id: "msg_canned",
    content: [
      {
        type: "tool_use",
        name: "emit_review",
        input: { findings: [] },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

export function makeCountingSdk(): CountingSdk {
  const calls: Array<CountingSdkCall> = [];
  const sdk: LlmSdk = {
    async createMessage(args): Promise<Record<string, unknown>> {
      calls.push({
        at: Date.now(),
        model: args.model,
        role: args.role,
        signalAborted: args.signal?.aborted === true,
      });
      return cannedToolUseResponse();
    },
  };
  return { sdk, calls };
}

/**
 * The REAL strict-ledger {@link LlmClient} (same wiring as in_process_ports.ts::buildStrictLedgerCache's
 * factory: REAL Postgres-backed cost-cap / blob / telemetry via sharedClientCollaborators(dsn) + the REAL
 * Postgres ADR-0068 ledger + strictLedger:true) constructed OVER the counting SDK. Two separate calls
 * (the abort+rerun model) share the SAME :5434 `core.llm_invocation_ledger` table, so the second call with
 * the SAME idempotency context is a ledger HIT (the SDK is NOT re-invoked). `dsn` is CODEMASTER_PG_CORE_DSN.
 */
export function makeCountingLedgerClient(dsn: string, counting: CountingSdk): LlmClient {
  const { costCap, blobStore, telemetry, langfuse, clock } = sharedClientCollaborators(dsn);
  return new LlmClient({
    sdk: counting.sdk,
    costCap,
    blobStore,
    telemetry,
    langfuse,
    clock,
    ledger: LlmInvocationLedger.fromDsn(dsn),
    strictLedger: true,
  });
}

// ─── seedLedgerRows — purge the ledger / cost / telemetry rows a counting-ledger scenario leaves ───
//
// G1.3 charges one REAL paid completion through the strict-ledger client, which writes one
// core.llm_invocation_ledger row, two telemetry.llm_payloads blobs, telemetry.llm_calls rows, and a
// telemetry.cost_daily reservation for the installation. Purge them by installation_id so the gate leaves
// :5434 pristine. (seedStuckJob / seedHeldMutex are the G4/G2 seams — those gates build their own; this
// file ships the G1.3 cleanup helper now and leaves the others to their owning gate per Step 1.5.)
export async function purgeLedgerScenarioRows(db: Kysely<unknown>, installationId: string): Promise<void> {
  await sql`DELETE FROM core.llm_invocation_ledger WHERE installation_id = ${installationId}::uuid`.execute(db);
  await sql`DELETE FROM telemetry.llm_calls WHERE installation_id = ${installationId}::uuid`.execute(db);
  await sql`DELETE FROM telemetry.llm_payloads WHERE installation_id = ${installationId}::uuid`.execute(db);
  await sql`DELETE FROM telemetry.cost_daily WHERE scope = 'per_org' AND scope_id = ${installationId}::uuid`.execute(db);
}

// ─── seedHeldMutex / seedStuckJob — the G4 reaper-unification seeds ────────────────────────────────
//
// G4 is REPO-LEVEL: it exercises reapStuckRuns + the Temporal age-sweep + acquireOrReuseMutex directly,
// so it needs to author the precise on-disk shapes those three primitives read — a LIVE held mutex row
// (keyed to a {@link seedTenant} Seed's PR identity, so acquireOrReuseMutex's ownership check matches it)
// and a STUCK / RECLAIMABLE core.review_jobs row (leased, with a controllable lease-expiry + attempts vs
// max_attempts so the reaper's exhaustion gate or claim()'s reclaim predicate selects it). Both mirror the
// sibling W6.1 / W6.2 integration-test seeds (reap_stuck_runs / review_run_reaper.activity) so the columns
// stay 1:1 with what the production SQL reads.

/**
 * Insert a LIVE held PR-mutex row for a {@link seedTenant} Seed (released_at NULL, lease 1h in the FUTURE),
 * keyed on the SEED's (installation_id, repository_id, pr_number) so it satisfies
 * `acquireOrReuseMutex`'s ownership check (installation/repository/pr_number MATCH + released_at IS NULL)
 * AND is the row `reapStuckRuns` releases via the job's `mutex_id`. Returns the minted mutex_id. Column set
 * (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id, acquired_at, lease_expires_at)
 * is verbatim from reap_stuck_runs.integration.test.ts::seedHeldMutex.
 */
export async function seedHeldMutex(db: Kysely<unknown>, seed: Seed): Promise<string> {
  const mutexId = randomUUID();
  await sql`INSERT INTO core.pr_review_mutex
      (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id, acquired_at, lease_expires_at)
    VALUES (${mutexId}, ${seed.installationId}, ${seed.repositoryId}, ${seed.prNumber}, 'wf-holder',
            now(), now() + interval '1 hour')`.execute(db);
  return mutexId;
}

/**
 * Insert ONE core.review_jobs row for a {@link seedTenant} Seed's run, in an explicit lease/attempts shape
 * so the G4 reaper / claim predicates select it deterministically. Inserts the row DIRECTLY (not via
 * enqueue→claim) so the test owns every load-bearing column without the real claim's attempt-token churn:
 *
 *   - `state` (default 'leased'), `attempts` / `maxAttempts` — the reaper's exhaustion gate is
 *     `state='leased' AND leased_until < now() AND attempts >= max_attempts`; G4(b) seeds attempts ==
 *     max_attempts (exhausted → reaped), G4(c) seeds attempts < max_attempts (remaining → claim() reclaims).
 *   - `leasedUntilSql` (default `now() - interval '1 minute'`) — an EXPIRED lease (the crash signature).
 *   - `mutexId` — stamped onto `review_jobs.mutex_id` so reapStuckRuns releases it (b) / acquireOrReuseMutex
 *     reuses it (c). The FK `review_jobs.mutex_id → pr_review_mutex(mutex_id)` requires the row to EXIST, so
 *     seed the mutex (via {@link seedHeldMutex}) FIRST.
 *
 * NOT NULL columns payload / payload_sha256 (migration 0037, no DB default) carry inert placeholders — the
 * reaper + claim predicates read neither; only run_id / review_id / installation_id / state / leased_until /
 * attempts / max_attempts / mutex_id are load-bearing here (1:1 with review_run_reaper.activity's seedReviewJob,
 * extended with the attempts/mutex columns reapStuckRuns + acquireOrReuseMutex read). Returns the job_id.
 */
export async function seedStuckJob(
  db: Kysely<unknown>,
  seed: Seed,
  opts?: {
    state?: string;
    attempts?: number;
    maxAttempts?: number;
    leasedUntilSql?: ReturnType<typeof sql>;
    mutexId?: string | null;
    leaseOwner?: string;
  },
): Promise<string> {
  const jobId = randomUUID();
  const state = opts?.state ?? "leased";
  const attempts = opts?.attempts ?? 1;
  const maxAttempts = opts?.maxAttempts ?? 1;
  const leasedUntil = opts?.leasedUntilSql ?? sql`now() - interval '1 minute'`;
  const mutexId = opts?.mutexId ?? null;
  const leaseOwner = opts?.leaseOwner ?? "g4-worker";
  // payload_sha256 must satisfy ck_review_jobs_payload_sha256_hex (64 lowercase hex chars, migration 0038).
  // This stuck-job fixture never reads the sha, so any CHECK-valid placeholder works — encode the SHA-256 of
  // the '{}' payload (md5 doubled is a deterministic 64-hex stand-in; the reaper does not verifyPayload).
  await sql`INSERT INTO core.review_jobs
      (job_id, run_id, review_id, installation_id, state, lease_owner, attempt_token,
       attempts, max_attempts, leased_until, mutex_id, payload, payload_sha256)
    VALUES (${jobId}, ${seed.runId}, ${seed.reviewId}, ${seed.installationId}, ${state}, ${leaseOwner},
            gen_random_uuid(), ${attempts}, ${maxAttempts}, ${leasedUntil}, ${mutexId},
            '{}'::jsonb, ${"0".repeat(64)})`.execute(db);
  return jobId;
}

// The Pool import is re-exported here so the later gates can thread the shared ADR-0062 pool through the
// harness without re-deriving it.
export type { Pool };
