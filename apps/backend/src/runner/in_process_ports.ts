/**
 * In-process port bundle for the non-Temporal review-job shell (Task W5.2, Step 1 / E1).
 *
 * ## Why a SEPARATE port bundle (E1)
 *
 * The shared {@link ReviewActivityPorts} type (orchestrator.ts) is the Temporal proxy surface — 28 methods,
 * each a single typed argument. The Temporal proxy path CANNOT carry a JS `AbortSignal` across the activity
 * boundary (an AbortSignal is not serializable), so we do NOT add `signal` to that shared type. Instead the
 * runner shell builds its OWN bundle that calls the REAL activity functions DIRECTLY (in-process, no
 * Temporal worker), each wrapped in {@link withAbortGate} so a port dispatched AFTER the composed abort
 * fired throws {@link TerminalCancelError}("aborted") BEFORE reaching a side effect (E1 / gate ①).
 *
 * ## Wiring is 1:1 with the Temporal composition root
 *
 * The non-strict, non-signal-bearing orchestrate ports + the direct-dispatch lifecycle/enrichment activities
 * are taken VERBATIM from {@link buildActivities} (worker/build_activities.ts — the SOURCE OF TRUTH for the
 * real DSN/client factories). The SEVEN signal-/strict-ledger-bearing ports are OVERRIDDEN here so they:
 *   - thread the COMPOSED abort signal into the surfaces that accept it (`clone` via the cloner, `postReview`
 *     via doPost, `generateFixPrompt` via its 2nd arg);
 *   - run every paid Bedrock call through a STRICT-LEDGER {@link LlmClient} (F4 — `strictLedger:true`), so a
 *     paid review/walkthrough/curator/rerank/fix-prompt call in the shell path that lacks an idempotency
 *     context throws `LedgerRequiredError` rather than paying un-ledgered (gate ②);
 *   - pass `sameRunTakeover:true` to `postReview` (E7 / W3.2 — the re-run IS the retry; recover an orphaned
 *     remote review by marker before creating, never strand the review as DEGRADED_UNPOSTED).
 *
 * The remaining ports are wrapped in {@link withAbortGate} unchanged — the gate is the per-port "no NEW
 * dispatch after abort" enforcement that holds for EVERY external surface (F7's enforceable guarantee).
 *
 * ## Plain-Node safety
 *
 * Everything here runs in a plain Node process (NO Temporal sandbox); the W1.1 proof
 * (test/unit/runner/plain_node_compat.test.ts) pins that orchestrate/degradation/posting import + behave
 * outside a workflow. The strict-ledger cache is the de-Temporal Phase-2 hardening of the ADR-0068 ledger.
 */

import { type Pool } from "pg";

import {
  type ReviewActivityPorts,
} from "#backend/review/pipeline/activity_ports.js";

import {
  cloneRepoIntoWorkspace,
  type CloneRepoIntoWorkspaceDeps,
} from "#backend/activities/clone_repo_into_workspace.activity.js";
import { doPost } from "#backend/activities/post_review_results.activity.js";
import { bedrockReviewChunk, type LlmClientCacheLike } from "#backend/review/review_activity.js";
import { WalkthroughActivities } from "#backend/review/walkthrough_activity.js";
import { buildStaticAnalysisActivity } from "#backend/activities/static_analysis.activity.js";
import { RuffInWorkerRunner } from "#backend/analysis/ruff_runner.js";
import { EslintInWorkerRunner } from "#backend/analysis/eslint_runner.js";
import { GitleaksInWorkerRunner } from "#backend/analysis/gitleaks_runner.js";
import { buildRetrieveKnowledgeActivity } from "#backend/wiring/retrievers.js";
import { FixPromptActivities } from "#backend/activities/generate_fix_prompt.activity.js";
import { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";

import { GitSubprocessCloner } from "#backend/integrations/git/cloner.js";
import { GitHubApiClient } from "#backend/integrations/github/api_client.js";
import { GitHubApiReviewClient, type GhReviewClient } from "#backend/integrations/github/review_client.js";
import { FetchGitHubHttpClient } from "#backend/integrations/github/api_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { resolveEmbeddingsConsumer } from "#backend/adapters/resolve_embeddings.js";

import {
  type ClientFactory,
  LlmClientCache,
  sharedClientCollaborators,
} from "#backend/integrations/llm/client_cache.js";
import { LlmClient } from "#backend/integrations/llm/client.js";
import { LlmCredentialsProvider } from "#backend/integrations/llm/credentials_provider.js";
import { LlmInvocationLedger } from "#backend/integrations/llm/invocation_ledger.js";
import { PostgresLlmProviderSettingsRepo } from "#backend/integrations/llm/llm_provider_settings_repo.js";

import { buildActivities } from "#backend/worker/build_activities.js";

import { WallClock } from "#platform/clock.js";

import { TerminalCancelError } from "./review_job_runner.js";

import type { PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import type { PostedReviewV1 } from "#contracts/posted_review.v1.js";
import type { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";
import type { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// withAbortGate — the abort SEAM the Temporal proxy boundary could not carry (E1).
//
// Wrap an underlying activity fn so that BEFORE it dispatches, an already-aborted `signal` throws
// `TerminalCancelError("aborted")` — the runner's `runOneJob` routes that through `terminalSettle`
// (the loser exits clean, never re-enqueued). The check reads the LIVE signal state at CALL time (not at
// construction), so an abort that fires between wrapping and the call is honoured. Pass-through otherwise:
// the underlying fn runs with the SAME single positional argument + returns its value unchanged.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function withAbortGate<I, O>(
  name: string,
  fn: (input: I) => Promise<O>,
  signal: AbortSignal,
): (input: I) => Promise<O> {
  return async (input: I): Promise<O> => {
    if (signal.aborted) {
      // No NEW dispatch after abort (gate ① / F7) — the side-effecting fn is never invoked.
      throw new TerminalCancelError("aborted", new Error(`abort gate fired before ${name} dispatch`));
    }
    return fn(input);
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// buildStrictLedgerReviewCache — the F4 strict-ledger LlmClientCache (gate ②).
//
// 1:1 with build_activities.ts::buildLlmClientCache EXCEPT the client factory threads `strictLedger:true`.
// Every review LlmClient is built with the REAL Postgres-backed ADR-0068 ledger AND strict-ledger mode, so
// a paid Bedrock call in the shell path with NO idempotency context throws `LedgerRequiredError` instead of
// paying un-ledgered. The Vault adapter is built from env inside the (lazy) factory — matching the
// deferred-Vault pattern; the cache façade defers the real build to first `forRole`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function buildStrictLedgerCache(dsn: string): LlmClientCache {
  const vault = VaultHttpPort.fromEnv();
  const repo = PostgresLlmProviderSettingsRepo.fromDsn({ dsn, vault });
  const credentialsProvider = new LlmCredentialsProvider({ repo });

  const strictLedgerClientFactory: ClientFactory = ({ sdk }) => {
    const { costCap, blobStore, telemetry, langfuse, clock } = sharedClientCollaborators(dsn);
    return new LlmClient({
      sdk,
      costCap,
      blobStore,
      telemetry,
      langfuse,
      clock,
      // F4 — the de-Temporal Phase-2 hardening: ledger + STRICT mode (un-ledgered paid call → throw).
      ledger: LlmInvocationLedger.fromDsn(dsn),
      strictLedger: true,
    });
  };

  return new LlmClientCache({ repo, credentialsProvider, clientFactory: strictLedgerClientFactory });
}

/**
 * A lazy {@link LlmClientCacheLike} that builds the strict-ledger {@link LlmClientCache} on first `forRole`
 * (the deferred-Vault pattern) and memoizes it. The review chunk / walkthrough / curator / rerank /
 * fix-prompt activities only ever call `forRole`, so this thin façade is a faithful, fully-real cache —
 * construction deferred to the moment a paid call actually fires (so the bundle build stays off Vault).
 */
export function buildStrictLedgerReviewCache(dsn: string): LlmClientCacheLike {
  let cache: LlmClientCache | undefined;
  return {
    forRole: (role) => {
      if (cache === undefined) {
        cache = buildStrictLedgerCache(dsn);
      }
      return cache.forRole(role as Parameters<LlmClientCache["forRole"]>[0]);
    },
  };
}

// ─── deferred-Vault GitHub seams (mirrors build_activities.ts; per-call installation routing) ─────

/** Build the REAL deferred-Vault {@link GitHubApiClient} (1:1 with build_activities.ts buildFixPromptApi). */
async function buildGithubApiClient(): Promise<GitHubApiClient> {
  const clock = new WallClock();
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  return new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
}

/**
 * The fix-prompt issue-comment seam (1:1 with build_activities.ts::makeLazyFixPromptIssueClient): builds the
 * real {@link GitHubApiClient} on first use (deferred-Vault) + memoizes it, then wraps it per-call in a thin
 * {@link GitHubApiReviewClient} bound to the call's numeric installation id (per-review routing).
 */
function makeLazyFixPromptIssueClient(): {
  createIssueComment(args: {
    installationId: number; owner: string; repo: string; prNumber: number; body: string;
  }): Promise<number>;
  listIssueComments(args: {
    installationId: number; owner: string; repo: string; prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;
} {
  let memo: Promise<GitHubApiClient> | undefined;
  const apiFor = async (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      memo = buildGithubApiClient();
    }
    return memo;
  };
  return {
    createIssueComment: async ({ installationId, ...rest }) => {
      const api = await apiFor();
      return new GitHubApiReviewClient({ api, installationId }).createIssueComment(rest);
    },
    listIssueComments: async ({ installationId, ...rest }) => {
      const api = await apiFor();
      return new GitHubApiReviewClient({ api, installationId }).listIssueComments(rest);
    },
  };
}

/**
 * Build the REAL {@link GhReviewClient} for the `postReview` port's `doPost`, per-call bound to the input's
 * numeric installation id (per-review routing; 1:1 with post_review_results.activity.ts::postReviewResults).
 * Deferred-Vault: the underlying api client is memoized across calls.
 */
function makeLazyPostReviewGhClient(): (installationId: number) => Promise<GhReviewClient> {
  let memo: Promise<GitHubApiClient> | undefined;
  const apiFor = async (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      memo = buildGithubApiClient();
    }
    return memo;
  };
  return async (installationId: number): Promise<GhReviewClient> => {
    const api = await apiFor();
    return new GitHubApiReviewClient({ api, installationId });
  };
}

/** The cloner deps (1:1 with build_activities.ts::buildClonerDeps): the real installation-agnostic cloner. */
async function buildClonerDeps(): Promise<CloneRepoIntoWorkspaceDeps> {
  const clock = new WallClock();
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  const cloner = new GitSubprocessCloner({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
  });
  return { cloner };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// InProcessPortDeps / makeInProcessPorts — assemble the ReviewActivityPorts for the shell.
//
// `signal` is the COMPOSED abort (the runner signal ∪ the shell's mutex-renew-loss controller — W5.2 step
// 4): EVERY port + the post path's doPost.signal receives it. `dsn` is the ADR-0062 core DSN. `pool` is the
// shared pool (threaded for symmetry; the ports build their own per-DSN collaborators).
//
// `overrides` lets the integration test (Step 3) inject COUNTING STUBS for every port at the bundle level
// (the "ALL ports stubbed at the in-process bundle level" assertion). When omitted, the production wiring is
// built ONCE here (the LLM/GitHub holders + the buildActivities() reuse). A provided override REPLACES the
// real fn for that port; the gate still wraps it (so the abort contract holds for stubs too).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type InProcessPortDeps = {
  /** ADR-0062 core DSN — the strict-ledger cache + GitHub/cloner seams + doPost all need it. */
  readonly dsn: string;
  /** Shared ADR-0062 pool (the shell threads it for the mutex; the ports build their own collaborators). */
  readonly pool: Pool;
  /**
   * Per-port override map (test seam). Each key is a {@link ReviewActivityPorts} method; the value REPLACES
   * the real wired fn (still wrapped in the abort gate). The integration test injects counting stubs here.
   */
  readonly overrides?: Partial<ReviewActivityPorts>;
};

/**
 * Build the {@link ReviewActivityPorts} the in-process shell hands to `orchestrate(ctx)`. The composed
 * `signal` gates every port; the strict-ledger cache backs every paid Bedrock call; `postReview` carries
 * `sameRunTakeover:true` + the signal. Non-overridden ports use the real wiring (built ONCE per call).
 */
export function makeInProcessPorts(deps: InProcessPortDeps, signal: AbortSignal): ReviewActivityPorts {
  const { dsn, overrides } = deps;

  // ── LAZY real wiring (E1 + test seam) ─────────────────────────────────────────────────────────────
  // EVERY heavy collaborator (the buildActivities() base surface, the strict-ledger cache, the embedder,
  // the GitHub/cloner seams, the LLM-bearing holders) is built on FIRST USE and memoized — NOT at
  // makeInProcessPorts() call time. So when a port is OVERRIDDEN (the integration test's counting stubs),
  // its real wiring is never constructed → the shell never reaches for the embedder / Vault / DSN env it
  // would otherwise need. This is what makes "ALL ports stubbed at the in-process bundle level" a true
  // no-real-wiring path while production (no overrides) still builds the FULLY-real surface, ONCE.
  let baseMemo: Record<string, (input: never) => Promise<unknown>> | undefined;
  const base = (): Record<string, (input: never) => Promise<unknown>> => {
    if (baseMemo === undefined) {
      baseMemo = buildActivities();
    }
    return baseMemo;
  };
  // A deferred real fn from the Temporal composition root (SOURCE OF TRUTH): construction is deferred to the
  // first dispatch. Used for the orchestrate ports that touch neither the review LLM nor an external abort
  // surface (loadRepoConfig, computePolicyRules, classify, chunkAndRedact, selectCarryForward, embedQuery,
  // dedupFindings, aggregate, persistReviewFindings, persistReviewWalkthrough, postCheckRun, cleanup,
  // citationValidate, emitOutputSafetyAudit, recordDeliverySkipped, buildRetrievedEvidence,
  // updatePrDescriptionSummary, applyArbitration, recordToolRuns) — exactly as build_activities registers.
  const baseFn = <I, O>(name: string): (input: I) => Promise<O> =>
    // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded build_activities registry key, not external input
    (input: I): Promise<O> => (base()[name] as unknown as (input: I) => Promise<O>)(input);

  // The strict-ledger cache (F4) + the LLM-bearing holders, built lazily ONCE.
  let strictCacheMemo: LlmClientCacheLike | undefined;
  const strictCache = (): LlmClientCacheLike => {
    if (strictCacheMemo === undefined) {
      strictCacheMemo = buildStrictLedgerReviewCache(dsn);
    }
    return strictCacheMemo;
  };
  let walkthroughMemo: WalkthroughActivities | undefined;
  const walkthrough = (): WalkthroughActivities => {
    walkthroughMemo ??= new WalkthroughActivities({ cache: strictCache() });
    return walkthroughMemo;
  };
  let retrieveMemo: ReturnType<typeof buildRetrieveKnowledgeActivity> | undefined;
  const retrieve = (): ReturnType<typeof buildRetrieveKnowledgeActivity> => {
    retrieveMemo ??= buildRetrieveKnowledgeActivity({
      embedder: resolveEmbeddingsConsumer(),
      rerankCache: strictCache(),
    });
    return retrieveMemo;
  };
  let staticMemo: ReturnType<typeof buildStaticAnalysisActivity> | undefined;
  const staticAnalysis = (): ReturnType<typeof buildStaticAnalysisActivity> => {
    staticMemo ??= buildStaticAnalysisActivity({
      runners: {
        ruff: new RuffInWorkerRunner(),
        eslint: new EslintInWorkerRunner(),
        gitleaks: new GitleaksInWorkerRunner(),
      },
      curatorCache: strictCache(),
      deadlineSeconds: 60,
      clock: new WallClock(),
    });
    return staticMemo;
  };
  let fixPromptMemo: FixPromptActivities | undefined;
  const fixPrompt = (): FixPromptActivities => {
    fixPromptMemo ??= new FixPromptActivities({
      cache: strictCache(),
      repo: FixPromptRepo.fromDsn(dsn),
      gh: makeLazyFixPromptIssueClient(),
      clock: new WallClock(),
    });
    return fixPromptMemo;
  };

  // clone: the real cloner deps, signal injected into cloner.clone per-call (in-flight abort, gate ①).
  const resolveClonerDeps = (() => {
    let memo: Promise<CloneRepoIntoWorkspaceDeps> | undefined;
    return (): Promise<CloneRepoIntoWorkspaceDeps> => {
      memo ??= buildClonerDeps();
      return memo;
    };
  })();
  const cloneWithSignal = async (req: CloneRepoIntoWorkspaceInput): Promise<ClonedRepoV1> => {
    const cd = await resolveClonerDeps();
    // Wrap the cloner so its clone() carries the COMPOSED signal (W4.1 pre-spawn + mid-clone teardown).
    const signalAwareDeps: CloneRepoIntoWorkspaceDeps = {
      ...cd,
      cloner: { clone: (input) => cd.cloner.clone({ ...input, signal }) },
    };
    return cloneRepoIntoWorkspace(req, signalAwareDeps);
  };

  // postReview: doPost directly with sameRunTakeover:true + the composed signal (E7 / W3.2 / W4.3).
  const ghClientFor = makeLazyPostReviewGhClient();
  const postReviewWithTakeover = async (input: PostReviewInputV1): Promise<PostedReviewV1> => {
    const installationId = input.github_installation_id;
    if (installationId === null) {
      throw new Error(
        "github_installation_id is null in the post_review_results input — cannot post the review " +
          "without a per-review installation id (per-review routing).",
      );
    }
    const ghClient = await ghClientFor(installationId);
    return doPost(input, { ghClient, dsn, sameRunTakeover: true, signal });
  };

  // Resolve each port: an override wins; else the real wired fn. EVERY port is wrapped in the abort gate.
  const pick = <I, O>(name: keyof ReviewActivityPorts, real: (input: I) => Promise<O>): (input: I) => Promise<O> => {
    // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded ReviewActivityPorts key, not external input
    const o = overrides?.[name] as ((input: I) => Promise<O>) | undefined;
    return withAbortGate<I, O>(name, o ?? real, signal);
  };

  const ports: ReviewActivityPorts = {
    clone: pick("clone", cloneWithSignal),
    loadRepoConfig: pick("loadRepoConfig", baseFn("loadRepoConfigActivity")),
    computePolicyRules: pick("computePolicyRules", baseFn("computePolicyRules")),
    classify: pick("classify", baseFn("classifyFiles")),
    chunkAndRedact: pick("chunkAndRedact", baseFn("chunkAndRedact")),
    staticAnalysis: pick("staticAnalysis", (input) => staticAnalysis().staticAnalysis(input)),
    selectCarryForward: pick("selectCarryForward", baseFn("selectCarryForward")),
    embedQuery: pick("embedQuery", baseFn("embedQuery")),
    retrieveKnowledge: pick("retrieveKnowledge", (input) => retrieve().retrieveKnowledge(input)),
    reviewChunk: pick("reviewChunk", (context) => bedrockReviewChunk(context, { cache: strictCache() })),
    dedupFindings: pick("dedupFindings", baseFn("dedupFindings")),
    aggregate: pick("aggregate", baseFn("aggregateFindings")),
    persistReviewFindings: pick("persistReviewFindings", baseFn("persistReviewFindings")),
    generateWalkthrough: pick("generateWalkthrough", (input) => walkthrough().generateWalkthrough(input)),
    persistReviewWalkthrough: pick("persistReviewWalkthrough", baseFn("persistReviewWalkthrough")),
    postReview: pick("postReview", postReviewWithTakeover),
    postCheckRun: pick("postCheckRun", baseFn("postCheckRun")),
    cleanup: pick("cleanup", baseFn("releaseWorkspace")),
    citationValidate: pick("citationValidate", baseFn("citationValidate")),
    emitOutputSafetyAudit: pick("emitOutputSafetyAudit", baseFn("emitOutputSafetyAudit")),
    recordDeliverySkipped: pick("recordDeliverySkipped", baseFn("recordDeliverySkipped")),
    buildRetrievedEvidence: pick("buildRetrievedEvidence", baseFn("buildRetrievedEvidence")),
    updatePrDescriptionSummary: pick("updatePrDescriptionSummary", baseFn("updatePrDescriptionSummary")),
    applyArbitration: pick("applyArbitration", baseFn("applyArbitrationActivity")),
    recordToolRuns: pick("recordToolRuns", baseFn("recordToolRuns")),
    generateFixPrompt: pick(
      "generateFixPrompt",
      (input) => fixPrompt().generateFixPrompt(input, signal),
    ),
  };

  return ports;
}
