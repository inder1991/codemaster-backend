// test/integration/runner/review_job_shell_gates.integration.test.ts
//
// PHASE-2 CHAOS GATE G1 — abort-aware side-effect contract ① (plan F7).
//
// The ENFORCEABLE guarantee the runner shell makes: "no NEW paid/external call STARTS after
// signal.aborted" — NOT "zero in-flight". This file COUNTS REAL external calls (a scripted GhReviewClient
// driven by the REAL doPost via the shell's postReview port, and a REAL strict-ledger LlmClient over a
// counting SDK) and asserts the real zero-after-abort / exactly-once properties, so that if the abort
// guard (withAbortGate / doPost's throwIfAborted / the ledger replay) were removed the gate would FAIL.
//
//   G1.1 — no new external call after abort + the E6 cleanup (mutex + workspace release) still ran.
//   G1.2 — abort during post → re-run completes the post EXACTLY once (one createReview, one row).
//   G1.3 — an in-flight paid LLM call completes + ledgers; a re-run HITs the ledger (SDK charged once).
//
// DB-gated (describeDb) against the DISPOSABLE :5434 Postgres only — NEVER the cluster. --no-file-parallelism.
// test/ is OUT of the clock/random gate scope (Date.now / randomUUID are fine here).

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { runReviewJob } from "#backend/runner/review_job_shell.js";
import { reviewRunReaperActivity } from "#backend/activities/review_run_reaper.activity.js";
import { acquireOrReuseMutex } from "#backend/runner/shell_mutex.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { doPost } from "#backend/activities/post_review_results.activity.js";
import {
  FixPromptActivities,
  fixPromptMarkerFor,
  type FixPromptIssueCommentClient,
} from "#backend/activities/generate_fix_prompt.activity.js";
import { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { allocateRun } from "#backend/ingest/_review_run_allocator.js";
import { REVIEW_TOOL_SCHEMA_VERSION } from "#backend/review/review_activity.js";
import { WALKTHROUGH_TOOL_SCHEMA_VERSION } from "#backend/review/walkthrough_activity.js";
import { purposeChunkId } from "#backend/integrations/llm/invocation_ledger.js";
import { disposeAllPools, getPool, tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { type PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { type PrMetaV1, type WalkthroughV1, WalkthroughV1 as WalkthroughV1Schema } from "#contracts/walkthrough.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";
import { type ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { type CreatedReviewV1 } from "#backend/integrations/github/review_client.js";
import { type DiffChunkV1, computeChunkId } from "#contracts/diff_chunking.v1.js";
import { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import { type ReviewContextV1 } from "#contracts/review_context.v1.js";
import { type LlmMessage } from "#contracts/llm_message.v1.js";
import { type LlmSdk } from "#backend/integrations/llm/client.js";

import {
  seedTenant,
  payloadFor,
  cleanup,
  makeStubPorts,
  makeStubLifecycle,
  makeScriptedGhClient,
  makeCountingSdk,
  makeCountingLedgerClient,
  purgeLedgerScenarioRows,
  seedHeldMutex,
  seedStuckJob,
  type CountingSdk,
  type CountingSdkCall,
  type Seed,
} from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

// G4's reapStuckRuns emits a `review_run.reaped` audit event whose before/after are encrypted via the
// local AES-256-GCM codec, which throws if no KeyRegistry is installed. Install a deterministic dev key
// (no Vault) for the whole file — 1:1 with the sibling reap_stuck_runs / review_run_reaper integration
// suites; harmless for G1-G3 (none assert on encrypted audit rows).
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  await db?.destroy();
  // G1.3's strict-ledger client opens the ADR-0062 shared pool for INTEGRATION_DSN; end it so no socket leaks.
  await disposeAllPools();
});

beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

/** Read the human-readable cancel cause the runner persisted onto core.review_jobs.cancel_reason. */
async function readJobCancelReason(jobId: string): Promise<string | null> {
  const r = await sql<{ cancel_reason: string | null }>`
    SELECT cancel_reason FROM core.review_jobs WHERE job_id = ${jobId}`.execute(db);
  return r.rows[0]?.cancel_reason ?? null;
}

/** Build a valid PostReviewInputV1 for a seed, with ONE finding inside the diff window (so a real post
 *  would carry an inline comment). github_installation_id is the seed-derived numeric id. */
function postInputFor(seed: Seed, prId: string): PostReviewInputV1 {
  const fileInDiff = "src/app.ts";
  const finding: ReviewFindingV1 = {
    schema_version: 1,
    file: fileInDiff,
    start_line: 10,
    end_line: 10,
    severity: "issue",
    category: "bug",
    title: "Null deref",
    body: "Possible null dereference here.",
    suggestion: null,
    confidence: 0.9,
    sources: [],
    scope: "chunk_observed",
    evidence_refs: [],
  };
  const prMeta: PrMetaV1 = {
    pr_id: prId,
    installation_id: seed.installationId,
    repo: "acme/widgets",
    pr_title: "Add widget",
    pr_description: "desc",
    author_login: null,
    draft: false,
    base_ref: null,
    head_ref: null,
    opened_at: null,
  };
  const walkthrough: WalkthroughV1 = {
    schema_version: 1,
    tldr: "Adds a widget.",
    file_rows: [],
    configuration_section_md: "",
    degradation_note: null,
    truncated: false,
    suggested_reviewers: [],
    linked_issues: [],
    sanitization_event: null,
  };
  const aggregated: AggregatedFindingsV1 = {
    schema_version: 1,
    findings: [finding],
    dedupe_stats: { input_count: 1, exact_dropped: 0, semantic_merged: 0, capped: 0, semantic_skipped: false },
    policy_revision: 0,
  };
  return {
    schema_version: 1,
    walkthrough,
    aggregated,
    pr_meta: prMeta,
    github_installation_id: 4815162342,
    head_sha: "abc123",
    walkthrough_md: "## Walkthrough\n\nAdds a widget.",
    owner: "acme",
    repo_name: "widgets",
    pr_number: seed.prNumber,
    run_id: seed.runId,
    review_id: seed.reviewId,
    changed_line_ranges: { [fileInDiff]: [[1, 100]] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1.1 — no NEW external call after abort + the E6 cleanup ran.
//
// Drive the FULL shell (runReviewJob + runOneJob). The REAL postReview port talks to a scripted
// GhReviewClient (programmed to create a review, so IF the abort gate were removed the create WOULD
// record a write AFTER the abort). A counting-stub `aggregate` port fires controller.abort() at the
// pre-aggregate boundary and stamps the abort timestamp; orchestrate then reaches the gated postReview,
// whose withAbortGate throws TerminalCancelError("aborted") BEFORE doPost — so ZERO createReview starts
// and the handler settles `cancelled`. The shell's finally (E6) still releases the mutex + workspace.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G1.1 — no new external call after abort; E6 cleanup ran (F7)", () => {
  it("settles cancelled; ZERO GH write + ZERO SDK call started after abort; mutex + workspace released", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 201);
    const payload = payloadFor(seed);
    // The scripted GH client WOULD create a review if reached — so the zero-after-abort assertion is a real
    // control (it is only true because the gate fired, not because the client was inert).
    const gh = makeScriptedGhClient({ createReview: [{ reviewId: 999, commentIds: [1001] }] });
    const sdk = makeCountingSdk();

    let abortTs = 0;
    const controller = new AbortController();
    const calls: Array<string> = [];

    try {
      await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId, payload,
      });

      // aggregate is ALWAYS dispatched; fire the abort there (pre-post) + stamp the abort instant.
      const ports = makeStubPorts(calls, {
        aggregate: async (input) => {
          calls.push("aggregate");
          controller.abort();
          abortTs = Date.now();
          return AggregatedFindingsV1.parse({
            findings: [...input.findings],
            dedupe_stats: { input_count: input.findings.length, exact_dropped: 0, semantic_merged: 0, capped: 0 },
            policy_revision: input.policy_revision,
          });
        },
      });

      // Track that the E6 cleanup releaseWorkspace ran (the lifecycle's release is abort-EXEMPT).
      let releaseWorkspaceCalls = 0;
      const lifecycle = makeStubLifecycle(calls, {
        releaseWorkspace: async () => { calls.push("releaseWorkspace"); releaseWorkspaceCalls += 1; },
      });

      const handler = runReviewJob({
        repo, pool, dsn: INTEGRATION_DSN!, clock, mutexRenewIntervalS: 999,
        ports,
        lifecycle,
        // REAL postReview port → real doPost → the scripted GH client (no Vault / GitHub round-trip).
        postReviewGhClient: gh.client,
      });
      // The external runner signal IS our controller's signal → aborting it aborts the shell's composed signal.
      const handlerWithSignal = (job: Parameters<typeof handler>[0]): Promise<void> =>
        handler(job, controller.signal);

      const res = await runOneJob({
        repo, clock, owner: "g1-1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler: handlerWithSignal,
      });

      // (1) settled cancelled (run → CANCELLED, job → cancelled) via terminalSettle on TerminalCancelError.
      expect(res.outcome).toBe("cancelled");
      const job = await repo.getById(res.jobId!);
      expect(job!.state).toBe("cancelled");
      const run = await sql<{ lifecycle_state: string }>`
        SELECT lifecycle_state FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(run.rows[0]!.lifecycle_state).toBe("CANCELLED");
      // The cancel cause is the ABORT gate (proves the composed signal reached the post boundary's gate).
      expect(await readJobCancelReason(res.jobId!)).toBe("aborted");

      // (2) MEANINGFUL ASSERTION — ZERO GH write STARTED at/after the abort timestamp, AND zero total
      // createReview/updateReview/createIssueComment. The post port was GATED before doPost.
      expect(abortTs).toBeGreaterThan(0);
      expect(gh.writesStartedAtOrAfter(abortTs)).toBe(0);
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);
      expect(gh.calls.filter((c) => c.method === "updateReview")).toHaveLength(0);
      // postReview never reached doPost (the orchestrate stub log records postReview ONLY if the fn body ran;
      // here the gate threw before any postReview body).
      expect(calls).not.toContain("postReview");

      // (3) the counting SDK STARTED zero new calls after the abort (no paid LLM call in this scenario).
      expect(sdk.calls).toHaveLength(0);

      // (4) E6 cleanup STILL ran (abort-EXEMPT finally): the mutex was released + releaseWorkspace called.
      expect(job!.mutex_id).toBeTruthy();
      const mutexRow = await sql<{ released_at: string | null }>`
        SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${job!.mutex_id!}`.execute(db);
      expect(mutexRow.rows[0]!.released_at).not.toBeNull();
      expect(releaseWorkspaceCalls).toBe(1);
      expect(calls).toContain("releaseMutex");
      expect(calls).toContain("releaseWorkspace");
    } finally {
      await cleanup(db, seed, { prId: payload.pr_id });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1.2 — abort during post → re-run completes the post EXACTLY once.
//
// Drive the REAL `doPost` with the EXACT options the shell's postReview port passes
// (`{ ghClient, dsn, sameRunTakeover:true, signal }` — see in_process_ports.ts::postReviewWithTakeover),
// twice against ONE scripted GhReviewClient + ONE :5434 atomic-claim row. The abort here is doPost's OWN
// pre-write gate (the BETWEEN-the-claim-and-createReview boundary the shell's coarse withAbortGate cannot
// model — that gate fires before doPost runs at all, so the Phase-1 claim would never land):
//   run #1: aborted signal → Phase-1 claim INSERTs the row, THEN doPost's throwIfAborted(signal) throws
//           TerminalCancelError BEFORE createReview → the claim row stays NULL → ZERO createReview.
//   run #2: fresh (un-aborted) signal, SAME input → lost-claim NULL-row + same-run takeover (marker finds
//           nothing) re-creates → completes the post. Across both runs: EXACTLY ONE createReview, ONE row.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G1.2 — abort during post → re-run completes exactly once", () => {
  it("run#1 aborts after claim before createReview (row NULL); run#2 re-creates → exactly ONE createReview + ONE row", async () => {
    const seed = await seedTenant(db, 202);
    const prId = payloadFor(seed).pr_id;
    // The scripted client would create review 4242 on the FIRST createReview it actually receives.
    const gh = makeScriptedGhClient({
      createReview: [{ reviewId: 4242, commentIds: [7001] } satisfies CreatedReviewV1],
      existingReviewByMarker: null, // no orphaned remote review → the takeover re-creates
    });
    const input = postInputFor(seed, prId);
    const postDeps = { ghClient: gh.client, dsn: INTEGRATION_DSN!, sameRunTakeover: true } as const;

    try {
      // ── run #1: aborted signal → claim lands, doPost's pre-write gate throws BEFORE createReview. ──
      const aborted = AbortSignal.abort();
      await expect(doPost(input, { ...postDeps, signal: aborted })).rejects.toMatchObject({
        name: "TerminalCancelError",
      });

      // The Phase-1 claim row EXISTS but github_review_id is NULL (createReview never started) — the exact
      // crash-equivalent state the next run's same-run takeover recovers.
      const after1 = await sql<{ github_review_id: string | null }>`
        SELECT github_review_id FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(after1.rows[0]).toBeDefined();
      expect(after1.rows[0]!.github_review_id).toBeNull();
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);

      // ── run #2 (the follow-up re-run): fresh un-aborted signal, SAME input, same-run takeover recovers. ──
      const live = new AbortController();
      const result = await doPost(input, { ...postDeps, signal: live.signal });
      expect(result.review_id).toBe(4242);

      // MEANINGFUL ASSERTION — EXACTLY ONE createReview total across the abort + the re-run, and EXACTLY
      // ONE posted_reviews row carrying the created review. (Remove the run#1 abort gate → run#1 would have
      // created the review too → TWO createReview total; remove the run#2 same-run takeover → run#2 would
      // re-create blindly or strand the review → not exactly-once.)
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(1);
      const rows = await sql<{ pr_id: string; github_review_id: string | null }>`
        SELECT pr_id, github_review_id FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(rows.rows).toHaveLength(1);
      expect(Number(rows.rows[0]!.github_review_id)).toBe(4242);
    } finally {
      await cleanup(db, seed, { prId });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G1.3 — an in-flight paid LLM call completes but is ledger-safe (charged EXACTLY once).
//
// Build the REAL strict-ledger LlmClient (real Postgres cost-cap / blob / telemetry + the REAL ADR-0068
// ledger, strictLedger:true) over a COUNTING SDK — exactly the wiring the shell's reviewChunk port uses.
// Invoke it twice with the SAME idempotency context the shell's per-chunk call produces (reviewId=pr_id,
// chunkId=chunk_id, toolSchemaVersion=REVIEW_TOOL_SCHEMA_VERSION, ledgerPurpose="bedrock_review_chunk"):
//   call #1 models the paid call already on the wire when abort fires — it COMPLETES, storing its ledger row.
//   call #2 models the re-run — it HITs the stored row and replays it, so the SDK is NOT re-invoked.
// Both share the SAME :5434 core.llm_invocation_ledger table (content-addressed key), so the SDK is charged
// EXACTLY ONCE for that key across abort + rerun.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G1.3 — in-flight paid LLM call completes but ledger-safe (charged exactly once)", () => {
  it("re-run HITs the ledger → SDK call count == 1 for the key across abort + rerun", async () => {
    const seed = await seedTenant(db, 203);
    const sdk = makeCountingSdk();
    const client = makeCountingLedgerClient(INTEGRATION_DSN!, sdk);

    // The deterministic per-chunk idempotency context the shell's reviewChunk path passes to invokeModel.
    const chunkId = "11111111-2222-4333-8444-555555555555"; // a stable per-chunk UUID
    const reviewId = seed.reviewId; // ReviewContextV1.pr_id is the review identity at the call site
    const idempotency = {
      reviewId,
      chunkId,
      toolSchemaVersion: REVIEW_TOOL_SCHEMA_VERSION,
      ledgerPurpose: "bedrock_review_chunk",
    };
    const invokeArgs = {
      role: "primary" as const,
      model: "claude-sonnet-4-6" as const,
      messages: [{ role: "user" as const, content: "review this chunk" }],
      maxTokens: 2048,
      purpose: "review_finding",
      installationId: seed.installationId,
      idempotency,
    };

    try {
      // call #1 (the in-flight paid call that completes after the abort): MISS → SDK invoked → ledger stored.
      const first = await client.invokeModel(invokeArgs);
      expect(first.provider).toBe("bedrock");
      expect(sdk.calls).toHaveLength(1);

      const ledgerAfter1 = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.llm_invocation_ledger
         WHERE installation_id = ${seed.installationId}::uuid AND review_id = ${reviewId}::uuid`.execute(db);
      expect(Number(ledgerAfter1.rows[0]!.n)).toBe(1);

      // call #2 (the re-run): SAME context → ledger HIT → the stored response replays, SDK NOT re-invoked.
      const second = await client.invokeModel(invokeArgs);
      expect(second.content).toBe(first.content);

      // MEANINGFUL ASSERTION — SDK call count is EXACTLY 1 across abort + rerun (no double-charge). Remove
      // the ledger replay (the strict-ledger client's lookup/store) and call #2 would re-invoke the SDK →
      // count == 2 → the gate fails. The single content-addressed ledger row is the exactly-once witness.
      expect(sdk.calls).toHaveLength(1);
      const ledgerAfter2 = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.llm_invocation_ledger
         WHERE installation_id = ${seed.installationId}::uuid AND review_id = ${reviewId}::uuid`.execute(db);
      expect(Number(ledgerAfter2.rows[0]!.n)).toBe(1);
    } finally {
      await purgeLedgerScenarioRows(db, seed.installationId);
      await cleanup(db, seed);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G2 — LLM ledger protocol ② (D2): crash AFTER the paid chunk-fanout + walkthrough, re-run replays them all.
//
// Where G1.3 drove ONE invokeModel call twice in isolation, G2 drives the FULL shell (runReviewJob +
// runOneJob) through its REAL chunk-fanout + walkthrough stages, with the reviewChunk + generateWalkthrough
// ports each calling a REAL strict-ledger LlmClient (makeCountingLedgerClient — real Postgres cost-cap /
// blob / telemetry + the REAL ADR-0068 ledger) over a COUNTING SDK, using the EXACT stable per-purpose
// idempotency context the production review_activity / walkthrough_activity pass (reviewId=pr_id, a stable
// chunkId, toolSchemaVersion, ledgerPurpose). chunkAndRedact is stubbed to a FIXED chunk set so the chunk
// ids are STABLE across runs; buildRetrievedEvidence (the per-chunk crypto-minting evidence producer) is
// stubbed to an EMPTY manifest so the fan-out reaches reviewChunk without makeInProcessPorts eagerly
// constructing the platform-Qwen embedder (which throws "CODEMASTER_QWEN_DSN is required"); generateWalkthrough
// returns a fully-defaulted WalkthroughV1 so the REAL post stage's walkthrough renderer composes.
//
//   run #1 — runs through the fanout (one paid call per chunk) + the walkthrough (one paid call), storing a
//            ledger row per content-addressed key, THEN the LATE finalizeReviewRun lifecycle stub throws a
//            NON-terminal Error (the crash-before-finalization). runOneJob's settleFailure re-enqueues the
//            job (run stays RUNNING, attempts remain) — the same run_id stays claimable.
//   run #2 — a SECOND runOneJob re-claims the SAME run_id + SAME payload + SAME fixed chunks. The fanout +
//            walkthrough re-run, but EVERY invokeModel is now a ledger HIT → the stored provider response
//            replays → the SDK is NOT re-invoked. finalizeReviewRun succeeds (it throws only on run #1).
//
// ASSERT across BOTH runs: the counting SDK started EXACTLY one paid call per chunk + one per purpose (the
// re-run added ZERO new SDK calls); every second-run lookup was a HIT (the ledger row count stayed constant
// on the re-run); the per-chunk + walkthrough replayed content is BYTE-IDENTICAL across runs (the
// per-call-distinct SDK stamps a monotonic call index into the response text, so a re-invoke — replay
// broken — would return a DIFFERENT body; a HIT replays the run-#1 body verbatim). The single ledger row per
// key is the cost-charged-once witness (no cost-cap spy is wired; the strict-ledger client's check-first
// skips checkOrRaise + recordCallCost entirely on a HIT, so the one row IS the once-charged proof).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Two FIXED review chunks with deterministic, replay-stable chunk_ids (computeChunkId over fixed path /
 *  line-range / body). The chunkAndRedact stub returns this same set on every run, so the per-chunk ledger
 *  key (which folds in chunk_id) is identical across the crash + the re-run. */
function fixedChunks(): ReadonlyArray<DiffChunkV1> {
  const make = (path: string, body: string): DiffChunkV1 => ({
    schema_version: 1,
    chunk_id: computeChunkId({ path, start_line: 1, end_line: 5, body }),
    path,
    language: "typescript",
    start_line: 1,
    end_line: 5,
    body,
    chunk_kind: "hunk",
    token_estimate: 12,
  });
  return [
    make("src/alpha.ts", "export const a = 1;\n"),
    make("src/beta.ts", "export const b = 2;\n"),
  ];
}

/**
 * A {@link CountingSdk}-shaped collaborator whose createMessage returns a response whose first content
 * block's `.text` is STAMPED with a strictly-monotonic call index. The client maps that first-block text to
 * `LlmInvokeResultV1.content`, so the stamp lets the gate distinguish a REPLAY (the run-#1 body re-surfaces
 * byte-for-byte) from a RE-INVOKE (a fresh, higher-indexed body would surface). Every entry is also recorded
 * in `calls` (the SDK call-count oracle). Distinct from the harness `makeCountingSdk` only in the per-call
 * stamp + the extra `tool_use` block so the parser yields one finding per chunk.
 */
function makeStampingCountingSdk(): CountingSdk {
  const calls: Array<CountingSdkCall> = [];
  let callIndex = 0;
  const sdk: LlmSdk = {
    async createMessage(args): Promise<Record<string, unknown>> {
      callIndex += 1;
      calls.push({
        at: Date.now(),
        model: args.model,
        role: args.role,
        signalAborted: args.signal?.aborted === true,
      });
      // The first block is a `text` block carrying the monotonic stamp (→ LlmInvokeResultV1.content); the
      // second is a tool_use block with one real finding (→ raw_content_blocks → parser → one finding).
      return {
        id: "msg_g2",
        content: [
          { type: "text", text: `paid-completion#${callIndex}` },
          {
            type: "tool_use",
            name: "emit_review",
            input: {
              findings: [
                {
                  file: "src/alpha.ts",
                  start_line: 1,
                  end_line: 1,
                  severity: "issue",
                  category: "bug",
                  title: "stamped finding",
                  body: "a finding from the stored provider response",
                  confidence: 0.9,
                },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
  return { sdk, calls };
}

describeDb("G2 — crash after chunk-fanout + walkthrough; re-run replays every paid call (D2)", () => {
  it("re-run is ALL ledger HITs → ZERO new SDK calls; per-chunk + walkthrough content byte-identical; one row per key", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 204);
    const payload = payloadFor(seed);
    const chunks = fixedChunks();

    // The REAL strict-ledger client over a stamping counting SDK — the exact wiring the shell's reviewChunk /
    // generateWalkthrough ports use in production, sharing the SAME :5434 core.llm_invocation_ledger table.
    const sdk = makeStampingCountingSdk();
    const client = makeCountingLedgerClient(INTEGRATION_DSN!, sdk);

    // Per-run capture of the REPLAYED content, keyed by ledger-purpose surrogate. run#1 fills it on the paid
    // MISS; run#2 fills it on the HIT — the gate asserts run#2[key] === run#1[key] (byte-identical replay).
    const contentByKey: { run1: Record<string, string>; run2: Record<string, string> } = { run1: {}, run2: {} };
    let runPhase: "run1" | "run2" = "run1";

    // A deterministic per-purpose user message; identical across runs for the SAME chunk/purpose so the
    // prompt-hash component of the idempotency key is stable (a drifting message would re-key → a false MISS).
    const chunkMessages = (ctx: ReviewContextV1): Array<LlmMessage> => [
      { role: "system", content: "review-system" },
      { role: "user", content: `review chunk ${ctx.chunk.chunk_id} at ${ctx.chunk.path}` },
    ];
    const walkthroughMessages: Array<LlmMessage> = [
      { role: "system", content: "walkthrough-system" },
      { role: "user", content: `walkthrough for ${payload.pr_id}` },
    ];

    let finalizeCalls = 0;

    try {
      await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId, payload,
      });

      const drive = async (): Promise<ReturnType<typeof runOneJob>> => {
        const calls: Array<string> = [];
        const ports = makeStubPorts(calls, {
          // FIXED chunk set → stable chunk_ids across the crash + the re-run.
          chunkAndRedact: async () => {
            calls.push("chunkAndRedact");
            return [...chunks];
          },
          // Stub the per-chunk evidence-manifest producer to an EMPTY manifest. The orchestrator's
          // buildChunkContext dispatches this port (mints ev_ ids via node:crypto) per chunk; left
          // un-stubbed, makeInProcessPorts builds the REAL one via buildActivities(), which eagerly
          // constructs the platform-Qwen embedder and throws "CODEMASTER_QWEN_DSN is required" before the
          // fan-out ever reaches reviewChunk. An empty manifest is consistent here: the reviewChunk override
          // emits zero findings with zero evidence_refs, so the parser's evidence-refs subset check is a
          // no-op (mirrors the workflow composition tests, which stub this port for the same reason).
          buildRetrievedEvidence: async () => {
            calls.push("buildRetrievedEvidence");
            return [];
          },
          // reviewChunk → the REAL strict-ledger invokeModel with the EXACT idempotency context
          // review_activity.ts passes (reviewId=pr_id, chunkId=chunk.chunk_id, REVIEW_TOOL_SCHEMA_VERSION,
          // ledgerPurpose="bedrock_review_chunk"). The MISS (run#1) pays + stores; the HIT (run#2) replays.
          reviewChunk: async (ctx: ReviewContextV1) => {
            calls.push("reviewChunk");
            const result = await client.invokeModel({
              role: "primary",
              model: "claude-sonnet-4-6",
              messages: chunkMessages(ctx),
              maxTokens: 2048,
              purpose: "review_finding",
              installationId: ctx.installation_id,
              idempotency: {
                reviewId: ctx.pr_id,
                chunkId: ctx.chunk.chunk_id,
                toolSchemaVersion: REVIEW_TOOL_SCHEMA_VERSION,
                ledgerPurpose: "bedrock_review_chunk",
              },
            });
            contentByKey[runPhase][`chunk:${ctx.chunk.chunk_id}`] = result.content;
            return ReviewChunkResponseV1.parse({ findings: [], arbitration_intents: [], sanitization_event: null });
          },
          // generateWalkthrough → the REAL strict-ledger invokeModel with the EXACT idempotency context
          // walkthrough_activity.ts passes (reviewId=pr_id, chunkId=purposeChunkId("walkthrough"),
          // WALKTHROUGH_TOOL_SCHEMA_VERSION, ledgerPurpose="walkthrough").
          generateWalkthrough: async () => {
            calls.push("generateWalkthrough");
            const result = await client.invokeModel({
              role: "primary",
              model: "claude-opus-4-7",
              messages: walkthroughMessages,
              maxTokens: 2048,
              purpose: "walkthrough",
              installationId: payload.installation_id,
              idempotency: {
                reviewId: payload.pr_id,
                chunkId: purposeChunkId("walkthrough"),
                toolSchemaVersion: WALKTHROUGH_TOOL_SCHEMA_VERSION,
                ledgerPurpose: "walkthrough",
              },
            });
            contentByKey[runPhase]["walkthrough"] = result.content;
            // Parse through WalkthroughV1 so EVERY field carries its schema default (file_rows: [],
            // suggested_reviewers: [], etc.). A bare object would leave file_rows undefined and the REAL
            // walkthrough renderer (the post stage runs the real renderWalkthroughForPost) trips on
            // `walkthrough.file_rows.length`. Mirrors makeStubPorts' default generateWalkthrough shape.
            return WalkthroughV1Schema.parse({ tldr: "all good", sanitization_event: null });
          },
        });
        const lifecycle = makeStubLifecycle(calls, {
          // CRASH on run #1 ONLY — a NON-terminal Error thrown from the LATE finalizeReviewRun (after fanout +
          // walkthrough already paid + ledgered) → settleFailure re-enqueues the run (still RUNNING) so run #2
          // re-claims the SAME run_id. On run #2 the real finalize runs (RUNNING → COMPLETED).
          finalizeReviewRun: async (input) => {
            calls.push("finalizeReviewRun");
            finalizeCalls += 1;
            if (finalizeCalls === 1) {
              throw new Error("g2-injected crash before finalization (run #1)");
            }
            const { finalizeReviewRun } = await import("#backend/activities/record_review_lifecycle.activity.js");
            await finalizeReviewRun(input as never);
          },
        });
        const handler = runReviewJob({
          repo, pool, dsn: INTEGRATION_DSN!, clock, mutexRenewIntervalS: 999, ports, lifecycle,
        });
        return runOneJob({
          repo, clock, owner: "g2", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler,
        });
      };

      // ── run #1: pays one SDK call per chunk + one for the walkthrough, ledgers each, then crashes. ──
      runPhase = "run1";
      const res1 = await drive();
      expect(res1.outcome).toBe("failed"); // settleFailure re-enqueued (attempts remain; run stays RUNNING)

      const sdkCallsAfter1 = sdk.calls.length;
      // EXACTLY one paid SDK call per chunk + one for the walkthrough (the run-#1 MISS edge for each key).
      expect(sdkCallsAfter1).toBe(chunks.length + 1);

      // One content-addressed ledger row per key (reviewId=pr_id for ALL of them → query by review_id).
      const ledgerAfter1 = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.llm_invocation_ledger
         WHERE installation_id = ${seed.installationId}::uuid AND review_id = ${payload.pr_id}::uuid`.execute(db);
      expect(Number(ledgerAfter1.rows[0]!.n)).toBe(chunks.length + 1);

      // The job re-enqueued (run still RUNNING, claimable) — nudge run_after to now() so the re-claim is
      // immediate (markFailed pushed it ~1s out under exponential backoff; a test-only timing nudge, NOT the
      // property under test).
      await sql`UPDATE core.review_jobs SET run_after = now() WHERE run_id = ${seed.runId}`.execute(db);
      const runState1 = await sql<{ lifecycle_state: string }>`
        SELECT lifecycle_state FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(runState1.rows[0]!.lifecycle_state).toBe("RUNNING");

      // ── run #2 (the re-run): re-claims the SAME run_id + SAME payload + SAME fixed chunks. Every paid call
      //    is now a ledger HIT → the stored provider response replays → the SDK is NOT re-invoked. ──
      runPhase = "run2";
      const res2 = await drive();
      expect(res2.outcome).toBe("done"); // finalize succeeded on run #2 → markDone

      // (1) MEANINGFUL ASSERTION — the re-run added ZERO new SDK calls. Every run-#2 lookup was a HIT, so the
      // counting SDK call count is UNCHANGED from after run #1. Remove the ledger replay (force replayed=null)
      // and run #2 would re-invoke the SDK for every key → the count would DOUBLE → the gate fails.
      expect(sdk.calls.length).toBe(sdkCallsAfter1);
      expect(sdk.calls.length).toBe(chunks.length + 1);

      // (2) MEANINGFUL ASSERTION — the ledger row count stayed CONSTANT on the re-run (no new row written:
      // every key was a HIT, not a MISS-then-store). One content-addressed row per key is the once-charged
      // witness (the strict-ledger check-first skips checkOrRaise + recordCallCost entirely on a HIT).
      const ledgerAfter2 = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.llm_invocation_ledger
         WHERE installation_id = ${seed.installationId}::uuid AND review_id = ${payload.pr_id}::uuid`.execute(db);
      expect(Number(ledgerAfter2.rows[0]!.n)).toBe(chunks.length + 1);

      // (3) MEANINGFUL ASSERTION — the per-chunk + walkthrough replayed content is BYTE-IDENTICAL across runs.
      // The stamping SDK encodes a monotonic call index into each response body, so a re-invoke (replay
      // broken) would surface a DIFFERENT, higher-indexed body on run #2; a HIT replays the run-#1 body
      // verbatim. Assert both that every key was captured on both runs AND that run#2 === run#1 per key.
      const keys = [...chunks.map((c) => `chunk:${c.chunk_id}`), "walkthrough"];
      for (const key of keys) {
        const run1Content = contentByKey.run1[key];
        const run2Content = contentByKey.run2[key];
        expect(run1Content).toBeDefined();
        expect(run2Content).toBeDefined();
        expect(run2Content).toBe(run1Content);
      }
      // And the run-#1 bodies carry DISTINCT stamps (call#1..call#N+1) — proves the stamp actually varies, so
      // the byte-identity above is a real replay, not a constant-body tautology.
      const run1Bodies = new Set(keys.map((k) => contentByKey.run1[k as keyof (typeof contentByKey)["run1"]]));
      expect(run1Bodies.size).toBe(chunks.length + 1);
    } finally {
      await purgeLedgerScenarioRows(db, seed.installationId);
      await cleanup(db, seed, { prId: payload.pr_id });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G3 — post-review idempotency ③ (D4 + supersede + v3 post-success-before-record recovery).
//
// The LARGEST gate — four sub-scenarios proving the spine NEVER double-posts (a review or a fix-prompt
// comment) and NEVER splits its terminal state across a supersede, driven against the REAL durable seams:
//
//   (a)  lost-claim returns the STORED comment_ids (D4) + the fix-prompt crash-BEFORE-post recovery (F3).
//   (a2) v3-F1: createReview succeeded remotely but the posted_reviews row stayed NULL → the re-run's
//        sameRunTakeover RECOVERS the orphan by marker (findExistingReviewByMarker) — ZERO 2nd createReview.
//   (a3) v3-F2: the fix-prompt createIssueComment succeeded (555) but recordCommentPosted crashed → the
//        re-run's listIssueComments operational-marker scan recovers 555 — ZERO 2nd comment.
//   (b)  supersede (no split-brain): a checkpoint port flips current_run_id to a freshly-allocated R2 while
//        R1 runs; R1's E4 readCurrentRunId != run_id fail-closes → settles cancelled (job+run ATOMICALLY)
//        + releases its mutex + posts NOTHING.
//
// Every assertion counts a REAL external call (the scripted GhReviewClient driven by the REAL doPost /
// the REAL FixPromptActivities.generateFixPrompt) or a REAL durable row (core.posted_reviews /
// core.fix_prompts / core.review_runs / core.review_jobs / core.pr_review_mutex), so deleting the guard
// under test turns the gate red. DB-gated (:5434 only). --no-file-parallelism.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

// A FixPromptRepo over the SAME ADR-0062 shared pool the rest of the gate uses (tenantKysely memoizes the
// engine per DSN, so this shares G1.3/G2's pool — disposeAllPools in afterAll ends it once).
const fixPromptRepo: FixPromptRepo | undefined = INTEGRATION_DSN
  ? new FixPromptRepo({ db: tenantKysely(INTEGRATION_DSN) })
  : undefined;

/** A cache whose forRole REJECTS so buildFixPrompt degrades to the (always-correct) deterministic base —
 *  no real LLM call. G3(a)/(a3) exercise the post-claim/marker recovery, NOT theme synthesis. */
const NO_LLM_CACHE = {
  forRole: async (): Promise<never> => {
    throw new Error("no LLM in G3 (deterministic fix-prompt only)");
  },
};

/** A recording fix-prompt issue-comment client (the slice generateFixPrompt uses: createIssueComment +
 *  listIssueComments, each with a per-call installationId). `seed` is the shared "remote" comment list — a
 *  created comment is pushed onto it so a later listIssueComments scan can recover it (mirrors the GitHub
 *  round-trip). The crash hooks model the two F2/F3 windows. EXTRACTED idiom from
 *  generate_fix_prompt.activity.integration.test.ts::makeGh. */
type RecordingFixPromptGh = FixPromptIssueCommentClient & {
  createCalls: Array<{ body: string }>;
  listCalls: number;
};
function makeFixPromptGh(opts: {
  nextCreateId?: number;
  onBeforeCreate?: () => void;
  onAfterCreate?: () => void;
  seed?: Array<{ id: number; body: string }>;
}): RecordingFixPromptGh {
  const seed = opts.seed ?? [];
  const gh: RecordingFixPromptGh = {
    createCalls: [],
    listCalls: 0,
    createIssueComment: async ({ body }) => {
      gh.createCalls.push({ body });
      opts.onBeforeCreate?.();
      const id = opts.nextCreateId ?? 4242;
      // The created (marked) comment becomes visible to a subsequent listIssueComments scan — the recovery
      // oracle for the "post landed, record crashed" window.
      seed.push({ id, body });
      opts.onAfterCreate?.();
      return id;
    },
    listIssueComments: async () => {
      gh.listCalls += 1;
      return seed.map((c) => ({ id: c.id, body: c.body }) as Record<string, unknown>);
    },
  };
  return gh;
}

/** A valid GenerateFixPromptInputV1 tied to a seed (ONE finding → the activity does NOT short-circuit). The
 *  numeric github_installation_id is the per-PR routing id the advisory comment posts under. */
function fixPromptInputFor(seed: Seed): GenerateFixPromptInputV1 {
  return GenerateFixPromptInputV1.parse({
    review_id: seed.reviewId,
    installation_id: seed.installationId,
    github_installation_id: 12345,
    pr_number: seed.prNumber,
    owner: "acme",
    repo: "widgets",
    aggregated: {
      schema_version: 1,
      findings: [
        {
          file: "src/app.ts",
          start_line: 10,
          end_line: 10,
          severity: "issue",
          category: "bug",
          title: "Null deref",
          body: "Possible null dereference here.",
          confidence: 0.9,
        },
      ],
      dedupe_stats: { input_count: 1, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: 0,
    },
  });
}

/** Purge the fix_prompts row a G3 fix-prompt sub-scenario wrote (keyed by review_id). */
async function purgeFixPrompt(reviewId: string): Promise<void> {
  await sql`DELETE FROM core.fix_prompts WHERE review_id = ${reviewId}`.execute(db);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G3 (a) — lost-claim returns the STORED comment_ids (D4) + fix-prompt crash-BEFORE-post recovery (F3).
//
// review post: run #1 drives the REAL doPost to completion (scripted createReview → reviewId 999 + ONE
// comment id) → the Phase-2 UPDATE stores github_review_id=999 + comment_ids=[7001]. Run #2 (the re-run
// after a crash before finalization) drives the SAME doPost: it LOSES the claim, reads the STORED comment
// ids back from the column, dispatches exactly ONE updateReview (idempotent body refresh), and RETURNS the
// stored ids. EXACTLY ONE createReview total, ONE updateReview (re-run only), ONE posted_reviews row.
//
// fix-prompt (F3 crash BEFORE post): run #1 of the REAL generateFixPrompt persists the record + claims the
// post lease, then createIssueComment THROWS (crash between claim and post) → comment_posted_at stays NULL
// (never lost). Run #2 (TTL=0 → the lease is reclaimable) re-claims, the marker scan finds nothing (the
// post never landed), and posts → the fix-prompt comment is posted EXACTLY ONCE across both runs.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G3 (a) — lost-claim returns stored comment_ids (D4) + fix-prompt crash-before-post recovery (F3)", () => {
  it("review: ONE createReview + ONE updateReview (re-run) + ONE row carrying stored comment_ids; fix-prompt posted exactly once", async () => {
    const seed = await seedTenant(db, 301);
    const prId = payloadFor(seed).pr_id;
    // createReview returns 999 + ONE comment id on the FIRST run; an empty createSeq on the re-run means any
    // 2nd createReview would THROW ("called more times than programmed") — so "exactly one createReview" is
    // a hard control, not a soft count.
    const gh = makeScriptedGhClient({
      createReview: [{ reviewId: 999, commentIds: [7001] } satisfies CreatedReviewV1],
      existingReviewByMarker: null,
    });
    const input = postInputFor(seed, prId);
    const postDeps = { ghClient: gh.client, dsn: INTEGRATION_DSN!, sameRunTakeover: true } as const;

    const fpGh = makeFixPromptGh({ nextCreateId: 4321 });
    const fpInput = fixPromptInputFor(seed);

    try {
      // ── review run #1: wins the claim, posts (999 + [7001]), Phase-2 UPDATE stores the row. ──
      const r1 = await doPost(input, { ...postDeps, signal: new AbortController().signal });
      expect(r1.review_id).toBe(999);
      expect(r1.comment_ids).toEqual([7001]);
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(1);
      const row1 = await sql<{ github_review_id: string | null; comment_ids: string }>`
        SELECT github_review_id, comment_ids::text AS comment_ids FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(Number(row1.rows[0]!.github_review_id)).toBe(999);
      expect(JSON.parse(row1.rows[0]!.comment_ids)).toEqual([7001]);

      // ── review run #2 (the re-run after a crash before finalization): SAME input → LOSES the claim → reads
      //    the STORED comment_ids → dispatches ONE updateReview → returns the stored ids. ──
      const r2 = await doPost(input, { ...postDeps, signal: new AbortController().signal });

      // (a) MEANINGFUL — the lost-claim path returned the STORED comment_ids (NOT [] and NOT a re-fetch). Remove
      // the `comment_ids: storedCommentIds` read (parseStoredCommentIds) and r2.comment_ids would be empty.
      expect(r2.review_id).toBe(999);
      expect(r2.was_update).toBe(true);
      expect(r2.comment_ids).toEqual([7001]);

      // (a) MEANINGFUL — EXACTLY one createReview total (the re-run did NOT re-create), exactly one updateReview
      // (only on the re-run's lost-claim path), exactly one posted_reviews row. Remove the abort/lost-claim
      // arbitration (or the ON CONFLICT DO NOTHING claim) and the re-run would createReview again → TWO creates.
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === "updateReview")).toHaveLength(1);
      const rows = await sql<{ n: string }>`
        SELECT count(*) AS n FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(Number(rows.rows[0]!.n)).toBe(1);

      // ── fix-prompt F3: run #1 crashes BETWEEN claim and createIssueComment (post NEVER made). ──
      const fpAct1 = new FixPromptActivities({
        cache: NO_LLM_CACHE,
        repo: fixPromptRepo!,
        gh: makeFixPromptGh({
          nextCreateId: 4321,
          onBeforeCreate: () => {
            throw new Error("G3a CRASH between claim and fix-prompt post");
          },
        }),
        clock,
      });
      await expect(fpAct1.generateFixPrompt(fpInput, undefined, { claimTtlSeconds: 0 })).rejects.toThrow(
        /CRASH between claim and fix-prompt post/,
      );
      // The crash happened AFTER claim, BEFORE a successful post → comment_posted_at stays NULL (never lost).
      const fpMid = await sql<{ posted: string | null }>`
        SELECT comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = ${seed.reviewId}`.execute(db);
      expect(fpMid.rows[0]!.posted).toBeNull();

      // ── fix-prompt run #2 (TTL=0 → the lease is reclaimable): re-claims, marker scan finds nothing, posts. ──
      const fpAct2 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo: fixPromptRepo!, gh: fpGh, clock });
      const fpR2 = await fpAct2.generateFixPrompt(fpInput, undefined, { claimTtlSeconds: 0 });

      // (a) MEANINGFUL — the fix-prompt comment posted EXACTLY ONCE across the crash + the re-run. Remove the
      // F3 RECOVERABLE-lease design (set comment_posted_at on claim instead of on confirmed post) and the
      // re-run would short-circuit on isCommentPosted → the comment is PERMANENTLY LOST (zero posts).
      expect(fpR2.comment_posted).toBe(true);
      expect(fpGh.createCalls.length).toBe(1);
      const fpRow = await sql<{ id: string | null; posted: string | null }>`
        SELECT github_comment_id::text AS id, comment_posted_at::text AS posted
          FROM core.fix_prompts WHERE review_id = ${seed.reviewId}`.execute(db);
      expect(fpRow.rows[0]!.id).toBe("4321");
      expect(fpRow.rows[0]!.posted).not.toBeNull();
    } finally {
      await purgeFixPrompt(seed.reviewId);
      await cleanup(db, seed, { prId });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G3 (a2) — v3-F1: review post-succeeded-DB-crashed → marker recovery (ZERO 2nd createReview).
//
// The exact crash state F1 recovers: createReview SUCCEEDED remotely (review 999 exists on GitHub) but the
// Phase-2 UPDATE crashed before storing the id, so the posted_reviews row is still github_review_id IS NULL.
// run #1 lands the claim row NULL via an already-aborted signal (doPost's pre-write gate throws AFTER the
// claim INSERT, BEFORE createReview — the crash-equivalent NULL row); the "createReview succeeded remotely"
// half is modeled by programming the orphaned remote review (existingReviewByMarker=999 + its comment ids)
// for the re-run to discover. run #2 (sameRunTakeover) LOSES the claim, the NULL-row takeover scans by
// marker, finds 999, re-fetches its comment ids, and CAS-stores them — NEVER re-creating. createReview is
// programmed EMPTY so ANY create call would throw: ZERO createReview total, ONE row carrying 999 + the ids.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G3 (a2) — v3-F1 review post-succeeded-DB-crashed; marker recovery, ZERO 2nd createReview", () => {
  it("re-run recovers review 999 by marker (findExistingReviewByMarker) + re-fetches comment_ids; ZERO createReview, ONE row carrying 999 + the ids", async () => {
    const seed = await seedTenant(db, 302);
    const prId = payloadFor(seed).pr_id;
    // The orphaned remote review the crashed self created: review 999 with comment ids [8001, 8002]. The
    // EMPTY createReview sequence makes ANY createReview throw — so "ZERO createReview" is a hard control.
    const gh = makeScriptedGhClient({
      createReview: [],
      existingReviewByMarker: 999,
      existingReviewComments: [8001, 8002],
    });
    const input = postInputFor(seed, prId);
    const postDeps = { ghClient: gh.client, dsn: INTEGRATION_DSN!, sameRunTakeover: true } as const;

    try {
      // ── run #1: aborted signal → the Phase-1 claim INSERTs the row, doPost's pre-write gate throws BEFORE
      //    createReview → the row stays NULL (the createReview-succeeded-remotely-but-UPDATE-crashed shape). ──
      await expect(doPost(input, { ...postDeps, signal: AbortSignal.abort() })).rejects.toMatchObject({
        name: "TerminalCancelError",
      });
      const after1 = await sql<{ github_review_id: string | null }>`
        SELECT github_review_id FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(after1.rows[0]).toBeDefined();
      expect(after1.rows[0]!.github_review_id).toBeNull();
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);

      // ── run #2 (the re-run): fresh signal, SAME input → LOSES the claim → NULL-row sameRunTakeover scans by
      //    marker, FINDS 999, re-fetches [8001,8002] via listReviewComments, CAS-stores — NO 2nd createReview. ──
      const result = await doPost(input, { ...postDeps, signal: new AbortController().signal });

      // (a2) MEANINGFUL — the takeover RECOVERED 999 by marker (NOT a blind re-create). Remove the
      // findExistingReviewByMarker recovery and run #2 would re-attempt createReview (double-post) — but the
      // EMPTY createSeq would make that throw, so the recovery branch is load-bearing for this to succeed AT ALL.
      expect(result.review_id).toBe(999);
      expect(result.was_update).toBe(true);
      expect(result.comment_ids).toEqual([8001, 8002]);

      // ZERO createReview total (the recovery scan is a READ — findExistingReviewByMarker — and listReviewComments
      // is a READ; the only WRITE is the CAS UPDATE), exactly ONE posted_reviews row now carrying 999 + the ids.
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);
      expect(gh.calls.filter((c) => c.method === "findExistingReviewByMarker")).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === "listReviewComments")).toHaveLength(1);
      const rows = await sql<{ github_review_id: string | null; comment_ids: string }>`
        SELECT github_review_id, comment_ids::text AS comment_ids FROM core.posted_reviews WHERE pr_id = ${prId}`.execute(db);
      expect(rows.rows).toHaveLength(1);
      expect(Number(rows.rows[0]!.github_review_id)).toBe(999);
      expect(JSON.parse(rows.rows[0]!.comment_ids)).toEqual([8001, 8002]);
    } finally {
      await cleanup(db, seed, { prId });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G3 (a3) — v3-F2: fix-prompt comment-succeeded-record-crashed → marker scan recovery (ZERO 2nd comment).
//
// run #1 of the REAL generateFixPrompt: persist + claim + createIssueComment SUCCEEDS (id 555, the marked
// comment lands remotely), then recordCommentPosted CRASHES (onAfterCreate hook) → comment_posted_at stays
// NULL but the remote comment exists. run #2 (TTL=0 → reclaimable) re-claims; the listIssueComments
// operational-marker scan finds the marked 555 → recordCommentPosted(555) → NO 2nd createIssueComment.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G3 (a3) — v3-F2 fix-prompt comment-succeeded-record-crashed; marker scan recovery, ZERO 2nd comment", () => {
  it("re-run's listIssueComments marker scan recovers 555; ZERO 2nd createIssueComment; comment_posted_at + github_comment_id=555 set", async () => {
    const seed = await seedTenant(db, 303);
    const fpInput = fixPromptInputFor(seed);
    // The shared "remote" comment list — the created comment 555 lands here on run #1 and is visible to run #2.
    const remote: Array<{ id: number; body: string }> = [];

    try {
      // ── run #1: createIssueComment SUCCEEDS (555, marker embedded), then recordCommentPosted crashes. ──
      const ghCrash = makeFixPromptGh({
        nextCreateId: 555,
        seed: remote,
        onAfterCreate: () => {
          throw new Error("G3a3 CRASH after fix-prompt post before record");
        },
      });
      const act1 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo: fixPromptRepo!, gh: ghCrash, clock });
      await expect(act1.generateFixPrompt(fpInput, undefined, { claimTtlSeconds: 0 })).rejects.toThrow(
        /CRASH after fix-prompt post before record/,
      );
      // The marked comment landed remotely (the recovery oracle); the DB record never committed.
      expect(remote.length).toBe(1);
      expect(remote[0]!.body).toContain(fixPromptMarkerFor(seed.reviewId));
      const mid = await sql<{ posted: string | null }>`
        SELECT comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = ${seed.reviewId}`.execute(db);
      expect(mid.rows[0]!.posted).toBeNull();

      // ── run #2 (the re-run): SHARES the remote seed (555 is visible). The expired lease is reclaimed; the
      //    marker scan finds 555 → recordCommentPosted(555) → NO new createIssueComment. ──
      const ghRecover = makeFixPromptGh({ nextCreateId: 999, seed: remote });
      const act2 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo: fixPromptRepo!, gh: ghRecover, clock });
      const r2 = await act2.generateFixPrompt(fpInput, undefined, { claimTtlSeconds: 0 });

      // (a3) MEANINGFUL — ZERO 2nd createIssueComment (the marker scan recovered 555). Remove the
      // listIssueComments operational-marker scan (findPostedCommentByMarker) and run #2 would createIssueComment
      // again → a DUPLICATE advisory comment (createCalls.length === 1) + the wrong recorded id (999).
      expect(r2.comment_posted).toBe(true);
      expect(ghRecover.createCalls.length).toBe(0);
      expect(ghRecover.listCalls).toBeGreaterThanOrEqual(1);
      const fpRow = await sql<{ id: string | null; posted: string | null }>`
        SELECT github_comment_id::text AS id, comment_posted_at::text AS posted
          FROM core.fix_prompts WHERE review_id = ${seed.reviewId}`.execute(db);
      expect(fpRow.rows[0]!.id).toBe("555"); // the RECOVERED remote id, not the would-be-new 999
      expect(fpRow.rows[0]!.posted).not.toBeNull();
    } finally {
      await purgeFixPrompt(seed.reviewId);
      await cleanup(db, seed);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G3 (b) — supersede (no split-brain): R1 fail-closes at E4, settles cancelled (job+run atomically),
// posts NOTHING, releases its mutex.
//
// Drive the FULL shell (runReviewJob + runOneJob). A checkpoint port (`dedupFindings`, dispatched right
// before the orchestrator's before-aggregate claim-check) performs a REAL allocateRun → it SUPERSEDES R1's
// run + INSERTs a fresh PENDING R2 + flips core.pull_request_reviews.current_run_id to R2. When R1 resumes,
// the next claim-check's readCurrentRunId reads current_run_id=R2 != R1.run_id → the shell throws
// TerminalCancelError("superseded"). runOneJob settles via terminalSettle: job→cancelled + run→CANCELLED in
// ONE transaction (no split-brain). The REAL postReview (doPost over the scripted GH client) is reachable —
// but the supersede fires BEFORE the post stage, so ZERO createReview.
//
// max_attempts=1 so runOneJob's isLastAttempt path is NOT what settles this — a TerminalCancelError ALWAYS
// routes through the cancelled terminalSettle regardless; the seed's single attempt keeps the run from being
// re-claimed after settlement.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G3 (b) — supersede: E4 fail-close → cancelled (job+run atomic), zero post, mutex released", () => {
  it("R1's current_run_id != run_id → settles cancelled (no split-brain); zero createReview; mutex released_at set", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 304);
    const payload = payloadFor(seed);
    // The scripted GH client WOULD create review 999 if doPost were ever reached — so "zero createReview" is a
    // real control: it is zero only because the E4 fail-close fired before the post stage.
    const gh = makeScriptedGhClient({ createReview: [{ reviewId: 999, commentIds: [1] }] });
    const calls: Array<string> = [];
    let r2RunId: string | null = null;
    let superseded = false;

    try {
      await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId, payload, maxAttempts: 1,
      });

      // The checkpoint: dedupFindings (dispatched right before the before-aggregate claim-check) performs the
      // REAL supersede — allocateRun in ONE transaction supersedes R1, inserts R2 PENDING, flips current_run_id
      // → R2. Fire ONCE (a re-entrant dispatch would re-supersede; the flag guards it).
      const ports = makeStubPorts(calls, {
        dedupFindings: async (input) => {
          calls.push("dedupFindings");
          if (!superseded) {
            superseded = true;
            const outcome = await db.transaction().execute(async (tx) =>
              allocateRun(tx as unknown as Parameters<typeof allocateRun>[0], {
                reviewId: seed.reviewId,
                installationId: seed.installationId,
                triggerType: "pr_synchronize",
                triggeredBy: null,
                provider: "github",
                deliveryId: null,
                clock,
              }),
            );
            r2RunId = outcome.newRunId;
          }
          // Return a valid DedupedFindingsV1 so, IF the E4 guard were removed, the pipeline would proceed to
          // the post stage (and createReview would fire — the mutation control for this gate).
          return { schema_version: 1, findings: [...input.llm_findings], semantic_skipped: false };
        },
      });
      const lifecycle = makeStubLifecycle(calls);

      const handler = runReviewJob({
        repo, pool, dsn: INTEGRATION_DSN!, clock, mutexRenewIntervalS: 999,
        ports, lifecycle,
        // REAL postReview port → real doPost → the scripted GH client. Reachable only if the supersede DOESN'T
        // fail-close — so a createReview here would PROVE the E4 guard is gone.
        postReviewGhClient: gh.client,
      });

      const res = await runOneJob({
        repo, clock, owner: "g3-b", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler,
      });

      // The shell reached the checkpoint (the supersede fired) before fail-closing.
      expect(superseded).toBe(true);
      expect(r2RunId).not.toBeNull();
      expect(r2RunId).not.toBe(seed.runId);

      // (b) MEANINGFUL — R1 settled CANCELLED via terminalSettle: BOTH terminal states flipped ATOMICALLY (no
      // split-brain). Remove the E4 fail-close and R1 would NOT throw superseded → it would post + finalize →
      // outcome "done", job "done", run "COMPLETED" (and createReview > 0 below).
      expect(res.outcome).toBe("cancelled");
      const job = await repo.getById(res.jobId!);
      expect(job!.state).toBe("cancelled");
      const run = await sql<{ lifecycle_state: string; cancelled_at: string | null }>`
        SELECT lifecycle_state, cancelled_at::text AS cancelled_at FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(run.rows[0]!.lifecycle_state).toBe("CANCELLED");
      expect(run.rows[0]!.cancelled_at).not.toBeNull(); // AD-7 biconditional: CANCELLED ⇔ cancelled_at present
      // The free-text cause on the JOB is the E4 supersede reason (proves the supersede branch, not a timeout).
      expect(await readJobCancelReason(res.jobId!)).toBe("superseded");

      // (b) MEANINGFUL — R1 posted NOTHING: ZERO createReview (the post stage was never reached). Remove the E4
      // fail-close and the un-superseded R1 would reach doPost → createReview === 1.
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);
      expect(calls).not.toContain("postReview");

      // (b) MEANINGFUL — R1 released its PR mutex on the E6 abort-EXEMPT finally (released_at NOT NULL). A
      // superseded loser that leaked its mutex would block the next push on the PR forever.
      expect(job!.mutex_id).toBeTruthy();
      const mutexRow = await sql<{ released_at: string | null }>`
        SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${job!.mutex_id!}`.execute(db);
      expect(mutexRow.rows[0]!.released_at).not.toBeNull();
    } finally {
      // R2 (the superseding run allocateRun created) + its WEBHOOK_RECEIVED workflow_event must be torn down
      // before the seed's review/installation delete (FK order). R1↔R2 form a CIRCULAR FK pair
      // (R1.superseded_by_run_id → R2, R2.supersedes_run_id → R1, both RESTRICT), so NULL R1's
      // superseded_by_run_id FIRST, then delete R2, then cleanup() deletes R1's row. current_run_id (→ R2) is
      // ON DELETE SET NULL but we null it explicitly to keep the delete order obvious.
      if (r2RunId !== null) {
        await sql`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = ${seed.reviewId}`.execute(db);
        await sql`UPDATE core.review_runs SET superseded_by_run_id = NULL WHERE run_id = ${seed.runId}`.execute(db);
        await sql`DELETE FROM audit.workflow_events WHERE run_id = ${r2RunId}`.execute(db);
        await sql`DELETE FROM core.review_runs WHERE run_id = ${r2RunId}`.execute(db);
      }
      await cleanup(db, seed, { prId: payload.pr_id });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G3 (c) — supersede claim-check fail-CLOSES on a NULL / missing current_run_id (review F3).
//
// The E4 supersede check must require EXACT identity: a review whose `current_run_id` no longer points at
// THIS run — whether flipped to another run (G3(b)), CLEARED to NULL, or whose pull_request_reviews row is
// MISSING entirely — is a genuine anomaly the Temporal-replacement shell MUST fail-CLOSE on (default-deny).
// By enqueue time allocateRun has set current_run_id = run_id (seedTenant seeds it), so a NULL here is NEVER
// the steady state — it means the review row was deleted or current_run_id was cleared out from under the
// live run, and a stale job must NOT proceed to post.
//
// Driving the FULL shell (runReviewJob + runOneJob) with a checkpoint port (`dedupFindings`, right before
// the before-aggregate claim-check) that CLEARS current_run_id to NULL — modelling both "current_run_id was
// cleared out from under the live run" AND, since `readCurrentRunId` collapses a MISSING review row to the
// SAME NULL (`r.rows[0]?.current_run_id ?? null`), the "review row no longer exists" anomaly. (The
// row-deleted variant cannot be staged in-test: `fk_review_runs_review` is ON DELETE RESTRICT, so the
// pull_request_reviews row cannot be deleted while the live review_runs row references it — the cleared-NULL
// case exercises the identical readCurrentRunId-returns-NULL code path.) The next claim-check's
// readCurrentRunId returns NULL → the shell throws TerminalCancelError("superseded"). runOneJob settles
// cancelled (job+run atomic) + releases the mutex + the REAL postReview (doPost over the scripted GH client)
// is never reached → ZERO createReview.
//
// BEFORE the F3 fix the guard was `if (current !== null && current !== job.run_id)`, so a NULL `current`
// SKIPPED the throw and the shell PROCEEDED to outcome 'done' — this gate fails red on that code and green
// once the guard requires exact identity (`if (current !== job.run_id)`).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G3 (c) — supersede fail-closes on null/missing current_run_id (F3)", () => {
  it("current_run_id CLEARED to NULL mid-run → settles cancelled (superseded); zero createReview; mutex released", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 305);
    const payload = payloadFor(seed);
    // The scripted GH client WOULD create review 999 if doPost were ever reached — "zero createReview" is a
    // real control: it is zero ONLY because the F3 fail-close fired before the post stage.
    const gh = makeScriptedGhClient({ createReview: [{ reviewId: 999, commentIds: [1] }] });
    const calls: Array<string> = [];
    let cleared = false;

    try {
      await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId, payload, maxAttempts: 1,
      });

      // Checkpoint: dedupFindings (dispatched right before the before-aggregate claim-check) CLEARS
      // current_run_id to NULL (the "review row no longer points at this run" anomaly). Fire ONCE.
      const ports = makeStubPorts(calls, {
        dedupFindings: async (input) => {
          calls.push("dedupFindings");
          if (!cleared) {
            cleared = true;
            await sql`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = ${seed.reviewId}`.execute(db);
          }
          // A valid DedupedFindingsV1 so, IF the F3 guard were too permissive on NULL, the pipeline would
          // proceed to the post stage (and createReview would fire — the mutation control for this gate).
          return { schema_version: 1, findings: [...input.llm_findings], semantic_skipped: false };
        },
      });
      const lifecycle = makeStubLifecycle(calls);

      const handler = runReviewJob({
        repo, pool, dsn: INTEGRATION_DSN!, clock, mutexRenewIntervalS: 999,
        ports, lifecycle,
        // REAL postReview port → real doPost → the scripted GH client. Reachable only if the F3 fail-close
        // does NOT fire — so a createReview here would PROVE the guard is too permissive on NULL.
        postReviewGhClient: gh.client,
      });

      const res = await runOneJob({
        repo, clock, owner: "g3-c1", leaseS: 5, heartbeatS: 1, maxRuntimeS: 60, handler,
      });

      // The shell reached the checkpoint (cleared current_run_id) before fail-closing.
      expect(cleared).toBe(true);

      // (c) MEANINGFUL — a NULL current_run_id fail-CLOSES: R1 settled CANCELLED via terminalSettle (job+run
      // atomic). Before the F3 fix the NULL SKIPPED the throw → outcome 'done', run 'COMPLETED', createReview 1.
      expect(res.outcome).toBe("cancelled");
      const job = await repo.getById(res.jobId!);
      expect(job!.state).toBe("cancelled");
      const run = await sql<{ lifecycle_state: string; cancelled_at: string | null }>`
        SELECT lifecycle_state, cancelled_at::text AS cancelled_at FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
      expect(run.rows[0]!.lifecycle_state).toBe("CANCELLED");
      expect(run.rows[0]!.cancelled_at).not.toBeNull(); // AD-7 biconditional: CANCELLED ⇔ cancelled_at present
      // The free-text cause on the JOB is the supersede reason (the F3 fail-close branch).
      expect(await readJobCancelReason(res.jobId!)).toBe("superseded");

      // (c) MEANINGFUL — R1 posted NOTHING: ZERO createReview (the post stage was never reached).
      expect(gh.calls.filter((c) => c.method === "createReview")).toHaveLength(0);
      expect(calls).not.toContain("postReview");

      // (c) MEANINGFUL — R1 released its PR mutex on the E6 abort-EXEMPT finally (released_at NOT NULL).
      expect(job!.mutex_id).toBeTruthy();
      const mutexRow = await sql<{ released_at: string | null }>`
        SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${job!.mutex_id!}`.execute(db);
      expect(mutexRow.rows[0]!.released_at).not.toBeNull();
    } finally {
      await cleanup(db, seed, { prId: payload.pr_id });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G4 — reaper unification ④ (D3). REPO-LEVEL (does NOT drive the full shell) — exercises the three
// liveness primitives DIRECTLY: the Temporal age-sweep `reviewRunReaperActivity` (W6.2, with the
// NOT EXISTS live-job shield), the runner's unified `reapStuckRuns` (W6.1 — one txn: stuck job→dead,
// run→CANCELLED/timeout/cancelled_at, mutex via job.mutex_id→released, ONE audit event), and
// `acquireOrReuseMutex` (W5.1) — proving the two reapers do NOT fight a live job, the crash path reaps
// in ONE txn with NO residual blocking window, and an attempts-remaining job is left for claim() to re-run.
//
//   (a)  live-lease shield: a RUNNING run aged 2× the stale threshold + a LIVE leased job (future lease) →
//        the age-sweep reaper leaves the run RUNNING (the NOT EXISTS shield). Remove the predicate → the
//        live run gets CANCELLED → the gate fails.
//   (b)  crash → unified reap + NO blocking window: expired lease + attempts exhausted + a held mutex → ONE
//        reapStuckRuns() → job→dead, run→CANCELLED(timeout, cancelled_at set), mutex released_at set, ONE
//        audit row; THEN an immediate fresh acquireOrReuseMutex for the SAME PR returns `acquired` (NOT
//        `busy`) — proving no 30/60-min blocking window remains.
//   (c)  re-run path (not reaped): expired lease but attempts REMAINING → reapStuckRuns leaves it untouched,
//        claim() reclaims (new attempt_token, SAME run_id), and acquireOrReuseMutex REUSES the job's mutex
//        (returns `reused` with the SAME live mutex id, not a fresh acquire).
//
// The reaper resolves the SHARED ADR-0062 pool from CODEMASTER_PG_CORE_DSN via getPool; acquireOrReuseMutex
// runs its mutex txn on that same shared pool, so all three primitives + the gate's Kysely see one DB.
// DB-gated (:5434 only). --no-file-parallelism.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** Count the `review_run.reaped` audit rows for a reaped run (the unified-reap audit witness). */
async function reapedAuditCount(installationId: string, runId: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit.audit_events
      WHERE installation_id = ${installationId} AND action = 'review_run.reaped' AND target_id = ${runId}`
    .execute(db);
  return r.rows[0]!.n;
}

/** Read a run's lifecycle + cancel columns for the reaper assertions. */
async function readRunReapState(
  runId: string,
): Promise<{ lifecycle_state: string; cancel_reason: string | null; cancelled_at: string | null }> {
  const r = await sql<{ lifecycle_state: string; cancel_reason: string | null; cancelled_at: string | null }>`
    SELECT lifecycle_state, cancel_reason, cancelled_at::text AS cancelled_at
      FROM core.review_runs WHERE run_id = ${runId}`.execute(db);
  return r.rows[0]!;
}

/** Read a mutex row's released_at (NULL ⇒ still live). */
async function readMutexReleasedAt(mutexId: string): Promise<string | null> {
  const r = await sql<{ released_at: string | null }>`
    SELECT released_at::text AS released_at FROM core.pr_review_mutex WHERE mutex_id = ${mutexId}`.execute(db);
  return r.rows[0]!.released_at;
}

/** Read a job's state + mutex_id for the reaper / reclaim assertions. */
async function readJobState(jobId: string): Promise<{ state: string; mutex_id: string | null }> {
  // tenant:exempt reason=test-read-job-by-pk follow_up=FOLLOW-UP-gf3-error-mode
  const r = await sql<{ state: string; mutex_id: string | null }>`
    SELECT state, mutex_id FROM core.review_jobs WHERE job_id = ${jobId}`.execute(db);
  return r.rows[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G4 (a) — live-lease shield: the age-sweep reaper must NOT cancel a run a live runner job is driving.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G4 (a) — live-lease shield: age-sweep reaper does NOT cancel a run with a LIVE leased job", () => {
  it("RUNNING run aged 2× the stale threshold + a future-leased job → run stays RUNNING (NOT EXISTS shield)", async () => {
    const STALE_S = 300; // the operator-safe floor (MIN_STALE_AFTER_SECONDS); the run is aged WELL past it.
    const seed = await seedTenant(db, 401);
    try {
      // Age the seeded RUNNING run to 2× the stale threshold so age ALONE would reap it.
      await sql`UPDATE core.review_runs SET started_at = now() - make_interval(secs => ${2 * STALE_S})
                 WHERE run_id = ${seed.runId}`.execute(db);
      // A LIVE leased job for that run (future lease) — the shield: state='leased' is in the NOT EXISTS set.
      const jobId = await seedStuckJob(db, seed, {
        state: "leased",
        attempts: 1,
        maxAttempts: 3,
        leasedUntilSql: sql`now() + interval '1 hour'`,
      });

      // Run the REAL Temporal age-sweep reaper directly (shared pool via the DSN).
      const result = await reviewRunReaperActivity({ dsn: INTEGRATION_DSN!, staleAfterSeconds: STALE_S });

      // (a) MEANINGFUL — the run is SHIELDED: still RUNNING, no cancel columns, no audit. The age-sweep
      // matched the run on age but the NOT EXISTS (live job) predicate excluded it. Delete the
      // `AND NOT EXISTS (... j.state IN ('ready','leased'))` predicate from the CTE and this aged run gets
      // CANCELLED here → the three assertions below go red.
      const run = await readRunReapState(seed.runId);
      expect(run.lifecycle_state).toBe("RUNNING");
      expect(run.cancel_reason).toBeNull();
      expect(run.cancelled_at).toBeNull();
      expect(await reapedAuditCount(seed.installationId, seed.runId)).toBe(0);
      // The job that shielded it is untouched (the age-sweep never reads jobs except via the shield).
      expect((await readJobState(jobId)).state).toBe("leased");
      // The reaper's own counters: scanned===reaped (whatever cross-tenant rows it swept, ours wasn't one).
      expect(result.scanned).toBe(result.reaped);
    } finally {
      await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
      await cleanup(db, seed);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G4 (b) — crash → unified reap + NO residual blocking window.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G4 (b) — crash → unified reapStuckRuns (job+run+mutex+audit) + immediate re-acquire (no blocking window)", () => {
  it("ONE reapStuckRuns txn: job→dead, run→CANCELLED/timeout, mutex released, ONE audit; then re-acquire for the SAME PR succeeds", async () => {
    // reaperDeps.dsn so reapStuckRuns resolves the SHARED ADR-0062 pool (NOT a fresh one) for the same DSN.
    const repo = new ReviewJobsRepo(db, { dsn: INTEGRATION_DSN! });
    const seed = await seedTenant(db, 402);
    const payload = payloadFor(seed);
    try {
      // The crash signature: a LIVE held mutex + a STUCK job (expired lease, attempts EXHAUSTED) holding it.
      const mutexId = await seedHeldMutex(db, seed);
      const jobId = await seedStuckJob(db, seed, {
        state: "leased",
        attempts: 1,
        maxAttempts: 1, // attempts >= max_attempts → the reaper's exhaustion gate selects it
        leasedUntilSql: sql`now() - interval '1 minute'`,
        mutexId,
      });

      // ── ONE reapStuckRuns() transaction does the whole unified sweep. ──
      const reaped = await repo.reapStuckRuns();
      expect(reaped).toBeGreaterThanOrEqual(1);

      // (b) MEANINGFUL — BOTH the job and the run flipped together. Remove the run-flip half of reapStuckRuns
      // (the per-row UPDATE core.review_runs … CANCELLED) and the lifecycle/cancel_reason/cancelled_at trio
      // goes red; remove the job-flip half and the state assertion goes red.
      expect((await readJobState(jobId)).state).toBe("dead");
      const run = await readRunReapState(seed.runId);
      expect(run.lifecycle_state).toBe("CANCELLED");
      expect(run.cancel_reason).toBe("timeout");
      expect(run.cancelled_at).not.toBeNull();

      // (b) MEANINGFUL — the held mutex was RELEASED in the same txn (released_at set). Remove the
      // step-(3) mutex release and released_at stays NULL → this assertion goes red AND the re-acquire below
      // would return `busy` (the second proof).
      expect(await readMutexReleasedAt(mutexId)).not.toBeNull();

      // (b) MEANINGFUL — EXACTLY ONE audit row for the reaped run (step (4), single emit per reaped run).
      expect(await reapedAuditCount(seed.installationId, seed.runId)).toBe(1);

      // (b) MEANINGFUL — NO blocking window: an IMMEDIATE fresh acquireOrReuseMutex for the SAME PR succeeds
      // (`acquired`, a brand-new live mutex), NOT `busy`. A fresh job row (no persisted mutex_id) forces the
      // acquire branch; it succeeds ONLY because the crashed holder's mutex was released by the reap above —
      // had reapStuckRuns NOT released it, the partial-unique live row would make this acquire return `busy`.
      const freshJobId = await seedStuckJob(db, seed, {
        state: "leased",
        attempts: 1,
        maxAttempts: 3,
        leasedUntilSql: sql`now() + interval '1 hour'`,
        mutexId: null,
      });
      const freshJob = (await repo.getById(freshJobId))!;
      const acq = await acquireOrReuseMutex({
        payload, job: freshJob, repo, pool: getPool(INTEGRATION_DSN!), clock,
      });
      expect(acq.status).toBe("acquired");
      expect(acq.status === "acquired" ? acq.mutexId : null).not.toBeNull();
      // It is a DIFFERENT (fresh) mutex than the released one — proving a new live claim, not a reuse.
      expect(acq.status === "acquired" ? acq.mutexId : null).not.toBe(mutexId);

      // Release the freshly-acquired mutex so the finally's installation cascade leaves no live row lingering.
      if (acq.status === "acquired") {
        await sql`UPDATE core.pr_review_mutex SET released_at = now() WHERE mutex_id = ${acq.mutexId}`.execute(db);
      }
    } finally {
      await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
      await cleanup(db, seed);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G4 (c) — re-run path (NOT reaped): attempts-remaining job is reclaimed + the mutex is REUSED.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describeDb("G4 (c) — attempts-remaining job is NOT reaped; claim() reclaims (same run_id) + mutex REUSED", () => {
  it("reapStuckRuns leaves it untouched; claim() re-leases (new token, SAME run_id); acquireOrReuseMutex returns `reused` with the SAME mutex", async () => {
    const repo = new ReviewJobsRepo(db, { dsn: INTEGRATION_DSN! });
    const seed = await seedTenant(db, 403);
    const payload = payloadFor(seed);
    try {
      // A held mutex + a job with an EXPIRED lease but attempts REMAINING (attempts < max_attempts).
      const mutexId = await seedHeldMutex(db, seed);
      const jobId = await seedStuckJob(db, seed, {
        state: "leased",
        attempts: 1,
        maxAttempts: 3, // attempts < max_attempts → NOT exhausted → the reaper must LEAVE it; claim() reclaims it
        leasedUntilSql: sql`now() - interval '1 minute'`,
        mutexId,
      });
      const beforeToken = (await repo.getById(jobId))!.attempt_token;

      // (c) MEANINGFUL — reapStuckRuns leaves the attempts-remaining job UNTOUCHED (the exhaustion gate
      // `attempts >= max_attempts` excludes it). Drop that predicate from the reaper and this job would be
      // dead + the run CANCELLED here → the assertions below go red and claim() would find nothing.
      await repo.reapStuckRuns();
      expect((await readJobState(jobId)).state).toBe("leased");
      const stillRunning = await readRunReapState(seed.runId);
      expect(stillRunning.lifecycle_state).toBe("RUNNING");
      expect(stillRunning.cancelled_at).toBeNull();
      expect(await readMutexReleasedAt(mutexId)).toBeNull(); // mutex untouched (still live)

      // (c) claim() re-leases the SAME run_id (expired lease + attempts remaining → reclaimable). The new
      // attempt_token proves a fresh attempt; the run_id is unchanged (re-run, not a new run).
      const reclaimed = await repo.claim({ owner: "g4c-worker", leaseMs: 60_000, maxRuntimeMs: 600_000 });
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.job_id).toBe(jobId);
      expect(reclaimed!.run_id).toBe(seed.runId); // SAME run_id (the re-run reuses the durable run identity)
      expect(reclaimed!.attempt_token).not.toBe(beforeToken); // a fresh attempt token (real re-claim)
      expect(reclaimed!.mutex_id).toBe(mutexId); // the reclaimed job still carries the persisted mutex_id

      // (c) MEANINGFUL — acquireOrReuseMutex REUSES the job's mutex (ownership matches + still live + renewable)
      // → returns `reused` with the SAME mutex id, NOT a fresh acquire (which would mint a new row). Remove the
      // reuse branch / its ownership-validate-then-renew and it would fall through to a fresh acquire — but a
      // live row for the SAME PR would make that acquire `busy` (self-deadlock against its own corpse), so
      // `reused` here is the load-bearing proof the re-run does NOT self-skip.
      const acq = await acquireOrReuseMutex({
        payload, job: reclaimed!, repo, pool: getPool(INTEGRATION_DSN!), clock,
      });
      expect(acq.status).toBe("reused");
      expect(acq.status === "reused" ? acq.mutexId : null).toBe(mutexId);
      // No NEW live mutex row was minted for this PR — exactly one live row (the reused one) exists.
      const liveCount = await sql<{ n: number }>`SELECT count(*)::int AS n FROM core.pr_review_mutex
          WHERE installation_id = ${seed.installationId} AND repository_id = ${seed.repositoryId}
            AND pr_number = ${seed.prNumber} AND released_at IS NULL`.execute(db);
      expect(liveCount.rows[0]!.n).toBe(1);
    } finally {
      await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
      await cleanup(db, seed);
    }
  });
});
