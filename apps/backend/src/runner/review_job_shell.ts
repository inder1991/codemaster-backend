/**
 * `runReviewJob` — the non-Temporal review-job shell (Task W5.2, Step 2). The structural HEART of Phase 2:
 * it runs the EXISTING `orchestrate()` in-process (no Temporal worker/sandbox), safely re-runnable from
 * scratch on crash, with the job row (D1) as the durable workflow-argument store.
 *
 * It is a {@link JobHandler} — `runReviewJob(deps)` returns `async (job, signal) => {…}` that {@link runOneJob}
 * drives. The body REPLICATES `review_pull_request.workflow.ts::reviewPullRequest` with DIRECT calls (the
 * gate is REPLACED by the runner claim + {@link acquireOrReuseMutex}; the Temporal proxies are REPLACED by
 * {@link makeInProcessPorts} + direct lifecycle dispatches). The seven load-bearing differences from the
 * Temporal body:
 *
 *   1. PAYLOAD (D1): {@link ReviewJobsRepo.verifyPayload} re-parses + re-hashes the stored argument — a
 *      hash mismatch is a `TerminalCancelError("payload-integrity")` (never a silent drifted review).
 *   2. MUTEX (D3): {@link acquireOrReuseMutex} (acquire on first run, REUSE on re-run after ownership
 *      validation); a FOREIGN live lease → `TerminalCancelError("mutex-busy")` (never spin).
 *   3. CLAIM-CHECK (E4, fail-closed on supersede): the orchestrator's three boundaries call a hybrid check —
 *      composed-abort → throw; renew false → `mutex-lost`; `current_run_id != run_id` → `superseded`.
 *   4. COMPOSED ABORT (v3-F3): a shell-local `AbortController` is composed with the runner signal; a light
 *      mutex-renew loop aborts it on lost renewal, so EVERY port + doPost.signal stops emitting side effects
 *      after mutex loss (the claim-check boundaries are necessary but not sufficient).
 *   5. RUN-ID (#5): the ReviewPipelineContext's `pr.runId` is `job.run_id` — NEVER a freshly-minted id.
 *   6. ARBITRATION-NOW (E2): `arbitrationNow = job.started_at` ISO (stable per attempt-chain; re-runs write
 *      identical `suppressed_at`).
 *   7. TERMINAL SETTLEMENT (F4) + finally (E6): the shell does NOT transition the run — it rethrows the
 *      `TerminalCancelError` and `runOneJob`'s `terminalSettle` flips job+run in ONE transaction. The
 *      `finally` does ONLY the idempotent cleanup releases (mutex + workspace), abort-EXEMPT.
 *
 * SANDBOX-FREE: this runs in a plain Node process (the W1.1 proof pins orchestrate/degradation/posting
 * import + behave outside a workflow). Clock/Random Protocol: timing via the injected {@link Clock} +
 * {@link cancellableSleep}; NO raw timers.
 */

import { type Pool } from "pg";

import { orchestrate, type ReviewPipelineContext } from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { CHUNK_CONCURRENCY_DEFAULT } from "#backend/review/pipeline/parallelism.js";
import { stageOutcome, type StageLogger } from "#backend/review/pipeline/degradation.js";
import { buildAnalyzedPayload, resolveDegradedPayload } from "#backend/review/pipeline/helpers.js";
import {
  recordLifecycleSetterSucceeded,
  recordLifecycleSetterFailed,
} from "#backend/observability/finding_lifecycle_metrics.js";

import { buildActivities } from "#backend/worker/build_activities.js";
import { renewPrReviewMutexLease, withMutexTransaction } from "#backend/concurrency/pr_mutex.js";
import { StaleWriteError } from "#backend/domain/stale_write_guard.js";
import { StateDrift } from "#backend/domain/transition_run.js";
import { CurrentRunMismatch } from "#backend/ingest/_reviews_repository.js";

import { type Clock } from "#platform/clock.js";

import type { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import type { PrMetaV1, LinkedIssueV1 } from "#contracts/walkthrough.v1.js";
import type { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";
import type { ManifestSnapshot } from "#contracts/pr_context.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import type { ReviewPipelineResult } from "#backend/review/pipeline/pipeline_result.js";
import type { ChangedLineRanges } from "#backend/review/pipeline/activity_ports.js";

import type { ReviewJobsRepo } from "./review_jobs_repo.js";
import { TerminalCancelError } from "./review_job_runner.js";
import type { JobHandler } from "./review_job_runner.js";
import { acquireOrReuseMutex } from "./shell_mutex.js";
import { cancellableSleep } from "./clock_async.js";
import { makeInProcessPorts, type InProcessPortDeps } from "./in_process_ports.js";

import type { ReviewActivityPorts } from "#backend/review/pipeline/activity_ports.js";

/**
 * The direct-dispatch lifecycle/enrichment activities the shell body dispatches OUTSIDE the orchestrate port
 * surface (the Temporal body dispatched these directly too — they are NOT part of `ReviewActivityPorts`).
 * Each defaults to its real wired function from {@link buildActivities}; the integration test overrides them
 * with counting stubs. The shape mirrors the camelCase keys the composition root registers.
 */
export type LifecycleBundle = {
  postReviewPlaceholder(input: unknown): Promise<void>;
  deleteReviewPlaceholder(input: unknown): Promise<void>;
  enrichPrFilesV2(input: unknown): Promise<PrFilesEnrichmentResultV1>;
  allocateWorkspace(input: unknown): Promise<WorkspaceHandle>;
  releaseWorkspace(input: unknown): Promise<void>;
  releasePrReviewMutexActivity(mutexId: string): Promise<void>;
  recordReviewLifecycleEvent(input: unknown): Promise<void>;
  finalizeReviewRun(input: unknown): Promise<void>;
  fetchLinkedIssues(input: unknown): Promise<ReadonlyArray<LinkedIssueV1>>;
  fetchSuggestedReviewers(input: unknown): Promise<ReadonlyArray<string>>;
  fetchManifestSnapshots(input: unknown): Promise<{ manifests: ReadonlyArray<ManifestSnapshot> }>;
  parseManifestDependencies(input: unknown): Promise<{ parsed_manifests: ReadonlyArray<ManifestSnapshot> }>;
  loadParentReviewFindings(
    input: unknown,
  ): Promise<{ parent_findings: ReadonlyArray<ReviewFindingV1>; parent_review_id: string | null }>;
  recordDeliveryFinalized(input: unknown): Promise<number>;
  recordDeliverySkipped(input: unknown): Promise<number>;
  recordDeliveryDegraded(input: unknown): Promise<number>;
};

/**
 * Build a {@link LifecycleBundle} whose entries DEFER to {@link buildActivities} (the SOURCE OF TRUTH
 * wiring), constructing the real worker surface on FIRST USE and memoizing it. A per-key `override` wins
 * WITHOUT forcing the real construction — so when the integration test overrides every key, `buildActivities`
 * (and its embedder / Vault / DSN env reads) is NEVER touched. Production (no overrides) builds it ONCE on
 * the first lifecycle dispatch.
 */
function buildLifecycleBundle(override: Partial<LifecycleBundle> | undefined): LifecycleBundle {
  let memo: Record<string, (input: never) => Promise<unknown>> | undefined;
  const real = (): Record<string, (input: never) => Promise<unknown>> => {
    memo ??= buildActivities();
    return memo;
  };
  // A deferred real fn keyed by the camelCase composition-root name (a hardcoded literal below — NOT an
  // attacker-controlled object-key sink); only built if actually called. The camelCase key === the
  // LifecycleBundle key for every entry, so one literal drives both lookups.
  const realFn = <K extends keyof LifecycleBundle>(name: K): LifecycleBundle[K] =>
    (async (input: never): Promise<unknown> => {
      const fn = real()[name as string] as (input: never) => Promise<unknown>;
      return fn(input);
    }) as unknown as LifecycleBundle[K];
  const pick = <K extends keyof LifecycleBundle>(name: K): LifecycleBundle[K] =>
    // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded LifecycleBundle key (bounded set), not external input
    (override?.[name] ?? realFn(name)) as LifecycleBundle[K];
  return {
    postReviewPlaceholder: pick("postReviewPlaceholder"),
    deleteReviewPlaceholder: pick("deleteReviewPlaceholder"),
    enrichPrFilesV2: pick("enrichPrFilesV2"),
    allocateWorkspace: pick("allocateWorkspace"),
    releaseWorkspace: pick("releaseWorkspace"),
    releasePrReviewMutexActivity: pick("releasePrReviewMutexActivity"),
    recordReviewLifecycleEvent: pick("recordReviewLifecycleEvent"),
    finalizeReviewRun: pick("finalizeReviewRun"),
    fetchLinkedIssues: pick("fetchLinkedIssues"),
    fetchSuggestedReviewers: pick("fetchSuggestedReviewers"),
    fetchManifestSnapshots: pick("fetchManifestSnapshots"),
    parseManifestDependencies: pick("parseManifestDependencies"),
    loadParentReviewFindings: pick("loadParentReviewFindings"),
    recordDeliveryFinalized: pick("recordDeliveryFinalized"),
    recordDeliverySkipped: pick("recordDeliverySkipped"),
    recordDeliveryDegraded: pick("recordDeliveryDegraded"),
  };
}

/** The mutex-renew loop interval (seconds). The job heartbeat is the primary clock (D3); this keeps the
 *  subordinated PR-mutex lease alive in lockstep. Default a third of the typical lease so two consecutive
 *  misses still renew within the lease window. */
const MUTEX_RENEW_INTERVAL_S = 20;

export type RunReviewJobDeps = {
  /** The runner repo (verifyPayload + the mutex/run reads). */
  readonly repo: ReviewJobsRepo;
  /** The shared ADR-0062 pool (the mutex acquire/renew txns + the supersede read run against it). */
  readonly pool: Pool;
  /** The ADR-0062 core DSN (the in-process ports + the supersede read need it). */
  readonly dsn: string;
  /** The timing seam (Clock-and-Random Protocol) — drives the mutex-renew loop's cancellableSleep. */
  readonly clock: Clock;
  /** Override the mutex-renew interval (seconds). Default {@link MUTEX_RENEW_INTERVAL_S}. */
  readonly mutexRenewIntervalS?: number;
  /** Per-port override map (test seam) threaded into {@link makeInProcessPorts}. */
  readonly ports?: Partial<ReviewActivityPorts>;
  /** Direct-dispatch lifecycle/enrichment override (test seam). Default {@link realLifecycleBundle}. */
  readonly lifecycle?: Partial<LifecycleBundle>;
};

/**
 * Read the review's authoritative `current_run_id` for the E4 supersede check. A `current_run_id` that no
 * longer equals OUR run_id means a newer review superseded us (`flipCurrentRun`) — the shell fail-CLOSES.
 */
async function readCurrentRunId(pool: Pool, reviewId: string): Promise<string | null> {
  // `core.pull_request_reviews` is keyed by `review_id` (globally unique; no installation_id column) — the
  // same PK the AD-4 flipCurrentRun fence reads. tenant:exempt reason=supersede-fence-read-by-review_id
  // follow_up=FOLLOW-UP-gf3-error-mode
  const r = await pool.query<{ current_run_id: string | null }>(
    "SELECT current_run_id FROM core.pull_request_reviews WHERE review_id = $1",
    [reviewId],
  );
  return r.rows[0]?.current_run_id ?? null;
}

/** Build the per-PR `PrMetaV1` (1:1 with the workflow body's `buildPrMeta`). */
function buildPrMeta(payload: ReviewPullRequestPayloadV1): PrMetaV1 {
  return {
    pr_id: payload.pr_id,
    installation_id: payload.installation_id,
    repo: `${payload.gh_owner}/${payload.gh_repo_name}`,
    pr_title: payload.pr_title,
    pr_description: payload.pr_description,
    author_login: payload.author_login,
    draft: payload.draft,
    base_ref: payload.base_ref,
    head_ref: payload.head_ref,
    opened_at: payload.opened_at,
  };
}

/**
 * Build the {@link JobHandler} the runner drives. The returned handler runs the full pipeline in-process for
 * ONE job; a `TerminalCancelError` it throws is settled `cancelled` (atomic job+run) by {@link runOneJob}.
 */
export function runReviewJob(deps: RunReviewJobDeps): JobHandler {
  // The direct-dispatch bundle: each entry DEFERS to buildActivities (built once on first real use); a
  // per-key override wins WITHOUT forcing the real construction (the test stubs everything → no real wiring).
  const lifecycle: LifecycleBundle = buildLifecycleBundle(deps.lifecycle);
  const renewIntervalS = deps.mutexRenewIntervalS ?? MUTEX_RENEW_INTERVAL_S;

  return async (job: ReviewJobV1, signal: AbortSignal): Promise<void> => {
    // (1) PAYLOAD (D1) — re-parse + re-hash the durable workflow argument; a mismatch is terminal.
    const payload = deps.repo.verifyPayload(job);

    // (2) MUTEX (D3) — acquire (first run) or REUSE (re-run after ownership validation). A FOREIGN live
    // lease owns the PR → terminal-cancel (never spin against another execution's review).
    const mutexRes = await acquireOrReuseMutex({ payload, job, repo: deps.repo, pool: deps.pool, clock: deps.clock });
    if (mutexRes.status === "busy") {
      throw new TerminalCancelError("mutex-busy", new Error("a FOREIGN review owns the PR mutex"));
    }
    const mutexId = mutexRes.mutexId;

    // (4) COMPOSED ABORT (v3-F3) — a shell-local controller composed with the runner signal. The mutex-renew
    // loop aborts it on a definitively-lost renewal, so EVERY port + doPost.signal stops after mutex loss.
    const shellAbort = new AbortController();
    const composed = AbortSignal.any([signal, shellAbort.signal]);

    // (3) CLAIM-CHECK (E4, fail-closed on supersede) — the orchestrator's three boundaries fire this.
    const claimCheck = async (): Promise<void> => {
      if (composed.aborted) {
        throw new TerminalCancelError("aborted", new Error("composed signal aborted at claim-check"));
      }
      const renewed = await withMutexTransaction(deps.pool, (client) =>
        renewPrReviewMutexLease({ client, installationId: payload.installation_id, mutexId }),
      ).catch(() => true); // transient renew ERROR stays fail-open (current semantics); false = definitive loss
      if (!renewed) {
        throw new TerminalCancelError("mutex-lost", new Error("pr_review_mutex lease definitively lost"));
      }
      const current = await readCurrentRunId(deps.pool, payload.review_id);
      if (current !== null && current !== job.run_id) {
        throw new TerminalCancelError("superseded", new Error(`current_run_id=${current} != run_id=${job.run_id}`));
      }
    };

    // (4 cont.) the light mutex-renew loop — renews the subordinated lease in lockstep with the job lease;
    // a definitively-lost renewal aborts the composed signal (so downstream side effects stop) AND is the
    // F3 belt to the claim-check's suspenders.
    const renewStop = new AbortController();
    const renewLoop = (async (): Promise<void> => {
      try {
        while (!renewStop.signal.aborted) {
          await cancellableSleep(deps.clock, renewIntervalS, renewStop.signal);
          if (renewStop.signal.aborted) {
            break;
          }
          const renewed = await withMutexTransaction(deps.pool, (client) =>
            renewPrReviewMutexLease({ client, installationId: payload.installation_id, mutexId }),
          ).catch(() => true); // transient error fail-open; only a definitive false aborts
          if (!renewed) {
            shellAbort.abort(new TerminalCancelError("mutex-lost", new Error("renew loop: lease lost")));
            break;
          }
        }
      } catch {
        // The loop must never throw out — a renew-loop fault aborts the review defensively.
        shellAbort.abort(new TerminalCancelError("mutex-lost", new Error("renew loop fault")));
      }
    })();

    const logger: StageLogger = { warning: (msg: string): void => { /* plain-Node sink (no workflow log) */ void msg; } };
    const headSha = payload.head_sha;
    const runId = job.run_id;

    // ── outer scope (mirrors the workflow body's FIX #1) — the finally releases mutex + workspace on EVERY
    //    exit path (E6, abort-EXEMPT). `workspaceHandle` is hoisted so the finally reads it after any failure.
    let workspaceHandle: WorkspaceHandle | null = null;
    const state = new ReviewWorkflowState();
    let result: ReviewPipelineResult;
    try {
      // (5) REPLICATE THE BODY — placeholder (best-effort) → enrich → allocate → ANALYSIS_STARTED →
      //     linked-issues/reviewers/manifests/parent-findings (fail-open) → ctx build → orchestrate →
      //     bookkeeping → ANALYZED → finalize. DIRECT calls (no Temporal proxy).

      // placeholder (best-effort, stageOutcome-wrapped)
      await stageOutcome("post_review_placeholder", { logger, headSha, runId }, async (handle): Promise<void> => {
        handle.skipOutcome();
        await lifecycle.postReviewPlaceholder({
          schema_version: 1, pr_id: payload.pr_id, run_id: runId, review_id: payload.review_id,
          installation_id: payload.installation_id, github_installation_id: payload.github_installation_id,
          owner: payload.gh_owner, repo_name: payload.gh_repo_name, pr_number: payload.pr_number,
        });
      });

      // enrich PR files → REAL changed_paths / changed_line_ranges (fail-open / DEGRADED on error, FIX #3)
      let enrichment: PrFilesEnrichmentResultV1 | undefined;
      let enrichErrored = false;
      if (payload.github_installation_id !== null) {
        const githubInstallationId = payload.github_installation_id;
        enrichment = await stageOutcome("enrich_pr_files", { logger, headSha, runId }, async (handle): Promise<PrFilesEnrichmentResultV1> => {
          handle.skipOutcome();
          return lifecycle.enrichPrFilesV2({
            schema_version: 1, installation_id: payload.installation_id, github_installation_id: githubInstallationId,
            repository_id: payload.repository_id, pr_id: payload.pr_id, gh_owner: payload.gh_owner,
            gh_repo_name: payload.gh_repo_name, pr_number: payload.pr_number,
          });
        });
        enrichErrored = enrichment === undefined;
      }
      let changedPathsForOrchestrator: ReadonlyArray<string> = [];
      let changedLineRangesForOrchestrator: ChangedLineRanges = {};
      if (enrichment !== undefined) {
        changedPathsForOrchestrator = enrichment.files.map((pf) => pf.file_path);
        changedLineRangesForOrchestrator = enrichment.changed_line_ranges;
      }

      // allocate the REAL workspace
      const handle: WorkspaceHandle = await lifecycle.allocateWorkspace({
        schema_version: 1, run_id: runId, review_id: payload.review_id, installation_id: payload.installation_id,
        repo_id: null, workflow_id: runId,
      });
      workspaceHandle = handle;

      // ANALYSIS_STARTED
      await lifecycle.recordReviewLifecycleEvent({
        schema_version: 2, installation_id: payload.installation_id, run_id: runId, review_id: payload.review_id,
        provider: "github", event_type: "ANALYSIS_STARTED",
        payload: { pr_id: payload.pr_id, head_sha: headSha, policy_revision: payload.policy_revision },
      });

      // linked issues + suggested reviewers (fail-open)
      let linkedIssues: ReadonlyArray<LinkedIssueV1> = [];
      let suggestedReviewers: ReadonlyArray<string> = [];
      if (payload.github_installation_id !== null) {
        const githubInstallationId = payload.github_installation_id;
        const resolvedLinked = await stageOutcome("fetch_linked_issues", { logger, headSha, runId }, async (h): Promise<ReadonlyArray<LinkedIssueV1>> => {
          h.skipOutcome();
          return lifecycle.fetchLinkedIssues({
            schema_version: 1, installation_id_uuid: payload.installation_id, installation_id_int: githubInstallationId,
            repository_id: payload.repository_id, pr_id: payload.pr_id, owner: payload.gh_owner, repo: payload.gh_repo_name,
          });
        });
        if (resolvedLinked !== undefined) {
          linkedIssues = resolvedLinked;
        }
        const resolvedSuggested = await stageOutcome("fetch_suggested_reviewers", { logger, headSha, runId }, async (h): Promise<ReadonlyArray<string>> => {
          h.skipOutcome();
          return lifecycle.fetchSuggestedReviewers({
            schema_version: 1, installation_id: payload.installation_id, repository_id: payload.repository_id, pr_id: payload.pr_id,
          });
        });
        if (resolvedSuggested !== undefined) {
          suggestedReviewers = resolvedSuggested;
        }
      }

      // FIX #3 — mark DEGRADED on enrich-ERROR (before orchestrate so the note folds into the result).
      if (enrichErrored) {
        state.degradation.add("pr_file_enrichment_failed");
      }

      // manifest fetch → parse (fail-open)
      let manifestSnapshots: ReadonlyArray<ManifestSnapshot> = [];
      if (enrichment !== undefined && changedPathsForOrchestrator.length > 0 && payload.github_installation_id !== null) {
        const githubInstallationId = payload.github_installation_id;
        const fetchResult = await stageOutcome("fetch_manifest_snapshots", { logger, headSha, runId }, async () =>
          lifecycle.fetchManifestSnapshots({
            schema_version: 1, installation_id: payload.installation_id, github_installation_id: githubInstallationId,
            repository_id: payload.repository_id, gh_owner: payload.gh_owner, gh_repo_name: payload.gh_repo_name,
            head_sha: headSha, candidate_paths: [...changedPathsForOrchestrator],
          }),
        );
        if (fetchResult !== undefined) {
          manifestSnapshots = fetchResult.manifests;
          if (manifestSnapshots.length > 0) {
            const snapshotsToParse = manifestSnapshots;
            const parseResult = await stageOutcome("parse_manifest_dependencies", { logger, headSha, runId }, async () =>
              lifecycle.parseManifestDependencies({ schema_version: 1, manifests: [...snapshotsToParse] }),
            );
            if (parseResult !== undefined) {
              manifestSnapshots = parseResult.parsed_manifests;
            }
          }
        }
      }

      // carry-forward loader (fail-open; flag-gated INSIDE the activity → [] / null when off)
      let parentFindings: ReadonlyArray<ReviewFindingV1> = [];
      let parentReviewId: string | null = null;
      const loaded = await stageOutcome("load_parent_review_findings", { logger, headSha, runId }, async () =>
        lifecycle.loadParentReviewFindings({
          schema_version: 1, installation_id: payload.installation_id, pr_id: payload.pr_id, review_id: payload.review_id,
        }),
      );
      if (loaded !== undefined) {
        parentFindings = loaded.parent_findings;
        parentReviewId = loaded.parent_review_id;
      }

      // build the ReviewPipelineContext — pr.runId = job.run_id (#5), arbitrationNow = job.started_at (E2),
      // claimCheck = the hybrid (3), activities = makeInProcessPorts(deps, COMPOSED).
      const inProcessPortDeps: InProcessPortDeps = {
        dsn: deps.dsn,
        pool: deps.pool,
        ...(deps.ports !== undefined ? { overrides: deps.ports } : {}),
      };
      const ctx: ReviewPipelineContext = {
        repo: {
          repoUrl: `https://github.com/${payload.gh_owner}/${payload.gh_repo_name}.git`,
          changedPaths: [...changedPathsForOrchestrator],
          workspaceHandle: handle,
        },
        pr: {
          prMeta: buildPrMeta(payload),
          githubInstallationId: payload.github_installation_id,
          headSha,
          runId, // #5 — NEVER mint a new run_id
          reviewId: payload.review_id,
          repositoryId: payload.repository_id,
          policyRevision: payload.policy_revision,
          prNumber: payload.pr_number,
          changedLineRanges: changedLineRangesForOrchestrator,
          parentFindings: [...parentFindings],
          parentReviewId,
        },
        activities: makeInProcessPorts(inProcessPortDeps, composed),
        limits: { chunkConcurrency: CHUNK_CONCURRENCY_DEFAULT },
        state,
        logger,
        linkedIssues,
        suggestedReviewers,
        enrichment: enrichment ?? null,
        manifestSnapshots: [...manifestSnapshots],
        // E2 — stable per attempt-chain (replaces workflowInfo().startTime); re-runs write identical suppressed_at.
        arbitrationNow: toIso(job),
        claimCheck,
        onPlaceholderTeardown: async (): Promise<void> => {
          await stageOutcome("delete_review_placeholder", { logger, headSha, runId }, async (h): Promise<void> => {
            h.skipOutcome();
            await lifecycle.deleteReviewPlaceholder({
              schema_version: 1, pr_id: payload.pr_id, run_id: runId, review_id: payload.review_id,
              installation_id: payload.installation_id, github_installation_id: payload.github_installation_id,
              owner: payload.gh_owner, repo_name: payload.gh_repo_name, pr_number: payload.pr_number,
            });
          });
        },
      };

      result = await orchestrate(ctx);

      // lifecycle bookkeeping (the workflow body's runLifecycleBookkeeping, fail-open per setter)
      await runLifecycleBookkeeping(payload, state, result, lifecycle, logger);

      // ANALYZED + finalize COMPLETED
      await lifecycle.recordReviewLifecycleEvent({
        schema_version: 2, installation_id: payload.installation_id, run_id: runId, review_id: payload.review_id,
        provider: "github", event_type: "ANALYZED",
        payload: buildAnalyzedPayload({
          findingsCount: result.findingsCount, headSha,
          postedReviewCapture: state.postedReview, pipelineResult: result,
        }),
      });
      await lifecycle.finalizeReviewRun({
        run_id: runId, review_id: payload.review_id, attempt: 1, duration_ms: null, worker_id: null,
      });
    } catch (exc) {
      // (6) — TerminalCancelError rethrows (runOneJob settles cancelled via terminalSettle). The
      // supersede/lost-claim family is WRAPPED in TerminalCancelError (E3). Everything else rethrows
      // (settles failed/retry).
      if (exc instanceof TerminalCancelError) {
        throw exc;
      }
      // StaleWriteError / StateDrift / CurrentRunMismatch are the in-process analogues of the Temporal body's
      // non-retryable ApplicationFailure family — a superseding review owns the result, so the loser exits
      // clean (E3). (PrMutexLostClaim was a Temporal ApplicationFailure `type` string, not a class; the
      // in-process claim-check + renew loop raise TerminalCancelError("mutex-lost") directly instead.)
      if (
        exc instanceof StaleWriteError ||
        exc instanceof StateDrift ||
        exc instanceof CurrentRunMismatch
      ) {
        throw new TerminalCancelError(exc.constructor.name, exc);
      }
      throw exc;
    } finally {
      // stop the renew loop FIRST so it can't fire after settlement.
      renewStop.abort();
      await renewLoop;
      // (7) finally (E6, abort-EXEMPT) — ONLY the idempotent cleanup releases (mutex + workspace), NEVER the
      // run transition (that is atomic in terminalSettle), NEVER a signal check. A release failure is logged
      // (stageOutcome swallows) and never masks the exit path.
      await stageOutcome("cleanup", { logger, headSha, runId }, async (h): Promise<void> => {
        h.skipOutcome();
        await lifecycle.releasePrReviewMutexActivity(mutexId);
      });
      if (workspaceHandle !== null) {
        const allocated = workspaceHandle;
        await stageOutcome("cleanup", { logger, headSha, runId }, async (h): Promise<void> => {
          h.skipOutcome();
          await lifecycle.releaseWorkspace({ schema_version: 1, workspace_id: allocated.workspace_id });
        });
      }
    }
  };
}

/** `job.started_at` as an RFC3339 ISO string (E2). The driver hands timestamptz back as a string or Date. */
function toIso(job: ReviewJobV1): string {
  const raw = (job as Record<string, unknown>)["started_at"];
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === "string" && raw !== "") {
    return new Date(raw).toISOString();
  }
  // Defensive: a claimed job ALWAYS has started_at (claim sets COALESCE(started_at, now())); fall back to
  // the epoch so arbitration still writes a deterministic instant rather than throwing.
  return new Date(0).toISOString();
}

/**
 * Finding-delivery lifecycle bookkeeping (1:1 with the workflow body's runLifecycleBookkeeping). After
 * orchestrate returns, flip the persisted findings to their delivery outcome from the post-review capture +
 * the pipeline result. BOOKKEEPING-ONLY: every dispatch is individually try/caught so a setter failure NEVER
 * fails the job (the review is already posted).
 */
async function runLifecycleBookkeeping(
  payload: ReviewPullRequestPayloadV1,
  state: ReviewWorkflowState,
  pipelineResult: ReviewPipelineResult,
  lifecycle: LifecycleBundle,
  logger: StageLogger,
): Promise<void> {
  const capture = state.postedReview;
  const postedReviewPrId = capture.postedReviewPrId;
  const reviewFindingIds = pipelineResult.reviewFindingIds;
  const rfidsCount = reviewFindingIds.length;

  let keptRfids: ReadonlyArray<string> = [];
  if (
    rfidsCount > 0 &&
    capture.keptFindingIndices.length > 0 &&
    Math.max(...capture.keptFindingIndices) < rfidsCount
  ) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is bounds-checked (max < rfidsCount) against a workflow-local string array
    keptRfids = capture.keptFindingIndices.map((i) => reviewFindingIds[i]!);
  }

  let skippedRfids: ReadonlyArray<string> = [];
  let skippedReasons: ReadonlyArray<string> = [];
  if (
    rfidsCount > 0 &&
    capture.droppedClassifications.length > 0 &&
    Math.max(...capture.droppedClassifications.map((dc) => dc.index)) < rfidsCount
  ) {
    skippedRfids = capture.droppedClassifications.map((dc) => reviewFindingIds[dc.index]!);
    skippedReasons = capture.droppedClassifications.map((dc) => dc.eligibility_reason);
  }

  if (keptRfids.length > 0 && postedReviewPrId !== null && capture.publicationOutcome === "inline_posted") {
    if (keptRfids.length !== capture.commentIds.length) {
      logger.warning(
        `lifecycle finalize skipped (rfid/comment_id length mismatch): kept=${keptRfids.length} ` +
          `comments=${capture.commentIds.length} pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
      recordLifecycleSetterFailed({ setter: "finalized_len_mismatch", retryable: false });
    } else {
      try {
        await lifecycle.recordDeliveryFinalized({
          schema_version: 1, installation_id: payload.installation_id, run_id: payload.run_id,
          review_id: payload.review_id, rfids: [...keptRfids], comment_ids: [...capture.commentIds],
          posted_review_pr_id: postedReviewPrId,
        });
        recordLifecycleSetterSucceeded({ setter: "finalized" });
      } catch (e) {
        logger.warning(`lifecycle setter failed: record_delivery_finalized error=${String(e)}`);
        recordLifecycleSetterFailed({ setter: "finalized" });
      }
    }
  }

  if (skippedRfids.length > 0 && postedReviewPrId !== null) {
    try {
      await lifecycle.recordDeliverySkipped({
        schema_version: 1, installation_id: payload.installation_id, run_id: payload.run_id,
        review_id: payload.review_id, rfids: [...skippedRfids], reasons: [...skippedReasons],
        posted_review_pr_id: postedReviewPrId,
      });
      recordLifecycleSetterSucceeded({ setter: "skipped" });
    } catch (e) {
      logger.warning(`lifecycle setter failed: record_delivery_skipped error=${String(e)}`);
      recordLifecycleSetterFailed({ setter: "skipped" });
    }
  }

  const degraded = resolveDegradedPayload(capture.publicationOutcome, keptRfids);
  if (degraded.rfidsToFlip.length > 0 && degraded.outcomeValue !== null && postedReviewPrId !== null) {
    try {
      await lifecycle.recordDeliveryDegraded({
        schema_version: 1, installation_id: payload.installation_id, run_id: payload.run_id,
        review_id: payload.review_id, rfids: [...degraded.rfidsToFlip], outcome: degraded.outcomeValue,
        posted_review_pr_id: postedReviewPrId,
      });
      recordLifecycleSetterSucceeded({ setter: "degraded" });
    } catch (e) {
      logger.warning(`lifecycle setter failed: record_delivery_degraded error=${String(e)}`);
      recordLifecycleSetterFailed({ setter: "degraded" });
    }
  }
}
