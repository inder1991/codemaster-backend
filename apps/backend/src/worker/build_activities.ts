/**
 * `buildActivities()` — the Temporal worker COMPOSITION ROOT for the review pipeline.
 *
 * 1:1 in intent with the frozen Python worker bootstrap's activity wiring
 * (vendor/codemaster-py/codemaster/worker/main.py ~2897-2967 for the LlmClientCache wiring, plus the
 * per-activity bound-method / closure registrations). This is the ONE place that:
 *
 *   1. Constructs the REAL collaborators ONCE (the git cloner, the platform embedder, the retrieve /
 *      embed / aggregate activity instances, the role-keyed LlmClientCache with its ledger-wired client
 *      factory).
 *   2. BINDS / CURRIES every activity into a 1-arg `(input) => Promise<…>` Temporal activity, so the map
 *      it returns is exactly the `{ name: fn }` shape `Worker.create({ activities })` consumes and EVERY
 *      value is dispatch-safe (a single positional argument is all Temporal ever passes).
 *
 * ## Why a composition root (vs the prior static registry)
 *
 * The prior static registry (`registry.ts`) registered a partial slice of the surface AND registered the
 * 2-arg `cloneRepoIntoWorkspace(req, deps)` BARE — so a Temporal dispatch (one positional arg) left
 * `deps === undefined` and crashed. A composition root fixes both: it registers the full review-pipeline
 * surface and curries every 2-arg activity (`cloneRepoIntoWorkspace`, `bedrockReviewChunk`) so the
 * registered value is genuinely 1-arg. The `build_activities.test.ts` coverage test pins both invariants
 * (every name present; every value `fn.length <= 1`).
 *
 * ## ADR-0068 — the LLM idempotency ledger is wired HERE (was dormant)
 *
 * The default `LlmClientCache` client factory (`defaultClientFactory`) builds an `LlmClient` WITHOUT a
 * `ledger`, so the ADR-0068 idempotency ledger was structurally present but never invoked on the
 * production review path. This composition root supplies a CUSTOM client factory that builds
 * `new LlmClient({ sdk, ...sharedClientCollaborators(dsn), ledger: LlmInvocationLedger.fromDsn(dsn) })`,
 * closing the ADR-0068 #5 "production follow-up" — a post-call persistence failure + a Temporal retry now
 * REPLAYS the stored provider response instead of buying a second paid Bedrock completion.
 *
 * ## Construction cost (no DB, no network at build time)
 *
 * Every Postgres collaborator is built via a `*.fromDsn(...)` constructor that opens a LAZY pool (no
 * connection until the first query), so `buildActivities()` does NOT touch Postgres. The LlmClientCache
 * (and the Vault adapter its settings-repo needs) is built LAZILY on the first `bedrockReviewChunk`
 * invocation and memoized — exactly the production-deferred-Vault pattern the sibling `post_check_run` /
 * `post_review_results` activities use (they call `VaultHttpPort.fromEnv()` inside the activity body, not
 * at module load). This keeps the build cheap AND off the `VAULT_ADDR` requirement at construction, while
 * the wiring stays FULLY REAL (no stub, no mock) — the real Vault/repo/cache are built the moment a review
 * chunk is actually dispatched.
 *
 * ## Env it reads (the same fail-loud reads the activities already use)
 *
 *   - `CODEMASTER_PG_CORE_DSN`            — the ADR-0062 core pool DSN (cloner has no DB; the LLM cache,
 *                                           retrievers, and ledger need it).
 *   - `CODEMASTER_GITHUB_INSTALLATION_ID` — the numeric GitHub App installation id the cloner clones as.
 *   - `CODEMASTER_QWEN_DSN` / `CODEMASTER_EMBEDDINGS_PROVIDER` (+ openai_compat vars) — read transitively
 *                                           by `resolveEmbeddingsConsumer()` (fail-loud per ADR-0059).
 *
 * Self-defaulting activities (`allocateWorkspace`, `releaseWorkspace`) take an OPTIONAL second `deps` arg
 * and resolve everything from env on a single-arg call; their `fn.length === 1` (the default param is not
 * counted), so they are registered BARE and stay dispatch-safe.
 */

import {
  AggregateFindingsActivity,
} from "#backend/activities/aggregate_findings.activity.js";
import { allocateWorkspace } from "#backend/activities/allocate_workspace.activity.js";
import {
  chunkAndRedact,
  redactChunks,
} from "#backend/activities/chunk_and_redact.activity.js";
import { classifyFiles } from "#backend/activities/classify_files.activity.js";
import {
  cloneRepoIntoWorkspace,
  type CloneRepoIntoWorkspaceDeps,
} from "#backend/activities/clone_repo_into_workspace.activity.js";
import { computePolicyRules } from "#backend/activities/compute_policy_rules.activity.js";
import { DedupFindingsActivity } from "#backend/activities/dedup_findings.activity.js";
import { EmbedQueryActivity } from "#backend/activities/embed_query.activity.js";
import { loadRepoConfigActivity } from "#backend/activities/load_repo_config.activity.js";
import { persistReviewFindings } from "#backend/activities/persist_review_findings.activity.js";
import { persistReviewWalkthrough } from "#backend/activities/persist_review_walkthrough.activity.js";
import { postCheckRun } from "#backend/activities/post_check_run.activity.js";
import { postReviewResults } from "#backend/activities/post_review_results.activity.js";
import { releaseWorkspace } from "#backend/activities/release_workspace.activity.js";
import { selectCarryForward } from "#backend/activities/select_carry_forward.activity.js";
import { buildStaticAnalysisActivity } from "#backend/activities/static_analysis.activity.js";
import { RuffInWorkerRunner } from "#backend/analysis/ruff_runner.js";
import { EslintInWorkerRunner } from "#backend/analysis/eslint_runner.js";
import { GitleaksInWorkerRunner } from "#backend/analysis/gitleaks_runner.js";

// ── Stage-2 lifecycle activities (mutex GATE + lease renew/release + placeholder post/delete) ──
// The workflow body (review_pull_request.workflow.ts) dispatches these directly by their registered names
// (NOT through the orchestrator's activity_proxy bridge). Each is a self-defaulting 1-arg activity (the
// mutex/renew/release take an optional 2nd `deps` arg → fn.length === 1, registered bare; the gate +
// placeholder take exactly one positional input).
import { startReviewForWebhook } from "#backend/activities/start_review_for_webhook.activity.js";
import { renewPrReviewMutexLeaseActivity } from "#backend/activities/renew_pr_review_mutex_lease.activity.js";
import { releasePrReviewMutexActivity } from "#backend/activities/release_pr_review_mutex.activity.js";
import { postReviewPlaceholder } from "#backend/activities/post_review_placeholder.activity.js";
import { deleteReviewPlaceholder } from "#backend/activities/delete_review_placeholder.activity.js";

// ── Stage-3 run-lifecycle + finding-delivery + citation + audit activities ──
// The workflow body (ANALYSIS_STARTED / ANALYZED / finalize / run-failed / run-cancelled + the three
// delivery setters) and the orchestrator (citation_validate Step 7.5 + the output-safety audit emit)
// dispatch these by their registered names. The four run-lifecycle + three delivery activities are 1-arg
// (their `deps` 2nd arg defaults → fn.length === 1); citationValidate / emitOutputSafetyAuditEvent are
// strictly 1-arg.
import {
  recordReviewLifecycleEvent,
  finalizeReviewRun,
  recordRunFailed,
  recordRunCancelled,
} from "#backend/activities/record_review_lifecycle.activity.js";
import {
  recordDeliveryFinalized,
  recordDeliverySkipped,
  recordDeliveryDegraded,
} from "#backend/activities/record_delivery_lifecycle.activity.js";
import { citationValidate } from "#backend/activities/citation_validate.activity.js";
import { emitOutputSafetyAuditEvent } from "#backend/activities/emit_output_safety_audit.activity.js";

// ── Stage-4 enrichment activities (changed-files enrich + linked-issues + suggested-reviewers + PR-desc +
// evidence manifest) ──
// The workflow body dispatches enrichPrFilesV2 / fetchLinkedIssues / fetchSuggestedReviewers by their
// registered names; the orchestrator (via the activity_proxy bridge) dispatches buildRetrievedEvidence
// (per chunk) + updatePrDescriptionSummary (posting). The two self-wiring activities (enrichPrFilesV2,
// updatePrDescriptionSummary) read env inside the activity body (the deferred-Vault pattern) → registered
// bare. buildRetrievedEvidence is stateless → registered bare. The two bound-method holders
// (FetchLinkedIssuesActivity, FetchSuggestedReviewersActivity) are constructed here with their real repos.
import { enrichPrFilesV2 } from "#backend/activities/enrich_pr_files.activity.js";
import { FetchLinkedIssuesActivity } from "#backend/activities/fetch_linked_issues.activity.js";
import { FetchSuggestedReviewersActivity } from "#backend/activities/fetch_suggested_reviewers.activity.js";
import { updatePrDescriptionSummary } from "#backend/activities/update_pr_description_summary.activity.js";
import { buildRetrievedEvidence } from "#backend/activities/build_retrieved_evidence.activity.js";

// ── Stage-5 activities (arbitration apply + tool-run record + fix-prompt) ──
// applyArbitrationActivity / recordToolRuns self-wire their repos from CODEMASTER_PG_CORE_DSN inside the
// activity body (1-arg → registered bare). The FixPromptActivities bound-method holder is constructed here
// with the shared ledger-wired LlmClientCache + the ported FixPromptRepo + a lazy issue-comment client
// (deferred-Vault) + the shared clock.
import { applyArbitrationActivity } from "#backend/activities/apply_arbitration.activity.js";
import { recordToolRuns } from "#backend/activities/record_tool_runs.activity.js";
import { FixPromptActivities } from "#backend/activities/generate_fix_prompt.activity.js";
import { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { GitHubApiClient } from "#backend/integrations/github/api_client.js";
import {
  FetchManifestSnapshotsActivity,
  type GithubContentsPort,
} from "#backend/activities/fetch_manifest_snapshots.activity.js";
import { ParseManifestDependenciesActivity } from "#backend/activities/parse_manifest_dependencies.activity.js";
import { loadParentReviewFindingsActivity } from "#backend/activities/load_parent_review_findings.activity.js";
import { GitHubApiReviewClient } from "#backend/integrations/github/review_client.js";

import { GitHubIssueClient } from "#backend/integrations/github/issue_client.js";
import { PostgresLinkedIssuesRepo } from "#backend/domain/repos/pr_issue_links_repo.js";
import { PostgresGithubIssuesCacheRepo } from "#backend/domain/repos/github_issues_cache_repo.js";
import { PostgresPrFilesRepo } from "#backend/domain/repos/pr_files_repo.js";
import { PostgresCodeOwnersRepo } from "#backend/domain/repos/code_owners_repo.js";

import { resolveEmbeddingsConsumer } from "#backend/adapters/resolve_embeddings.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";

import { FetchGitHubHttpClient } from "#backend/integrations/github/api_client.js";
import { GitSubprocessCloner } from "#backend/integrations/git/cloner.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";

import {
  type ClientFactory,
  LlmClientCache,
  sharedClientCollaborators,
} from "#backend/integrations/llm/client_cache.js";
import { LlmClient } from "#backend/integrations/llm/client.js";
import { LlmCredentialsProvider } from "#backend/integrations/llm/credentials_provider.js";
import { LlmInvocationLedger } from "#backend/integrations/llm/invocation_ledger.js";
import { PostgresLlmProviderSettingsRepo } from "#backend/integrations/llm/llm_provider_settings_repo.js";

import {
  type LlmClientCacheLike,
  bedrockReviewChunk,
} from "#backend/review/review_activity.js";

import { WalkthroughActivities } from "#backend/review/walkthrough_activity.js";

import { buildRetrieveKnowledgeActivity } from "#backend/wiring/retrievers.js";

import { WallClock } from "#platform/clock.js";

// ─── env reads (the same fail-loud reads the individual activities use) ──────────────────────────

/**
 * The Tier-1 static-analysis soft-barrier deadline (seconds). 1:1 with the frozen Python default
 * `review_budgets.yaml::tier1_static_analysis_seconds: 60` — the StaticAnalysisOrchestrator owns this
 * authoritative deadline (per-tool runner timeouts are only safety guards). The DB/yaml-backed budgets
 * config loader (`review_budgets.py::load_budgets`) is NOT ported to TS yet; this constant is the
 * unconfigured default until it lands. FOLLOW-UP-review-budgets-loader.
 */
const TIER1_STATIC_ANALYSIS_SECONDS = 60;

/**
 * Read the canonical core-store DSN, fail-loud when unset. Mirrors the private `requireCoreDsn()` in
 * `client_cache.ts` (which is not exported) + the identical reads in the workspace activities — the LLM
 * cache, retrievers, and idempotency ledger all need a real Postgres pool, and a silent fallthrough is
 * exactly the hazard the de-stub work removed. Static `process.env.X` access (no dynamic indexing).
 */
function requireCoreDsn(): string {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; the worker composition root cannot wire the LLM client " +
        "cache, the retrieve-knowledge ports, or the LLM idempotency ledger without a core Postgres DSN",
    );
  }
  return dsn;
}

/**
 * Read + validate `CODEMASTER_GITHUB_INSTALLATION_ID` (the numeric GitHub App installation id this pod
 * clones as). 1:1 with `post_check_run.activity.ts::readGithubInstallationId` (which mirrors the frozen
 * Python `_read_github_installation_id`). Static `process.env.X` access (no dynamic indexing).
 */
function readGithubInstallationId(): number {
  const raw = process.env.CODEMASTER_GITHUB_INSTALLATION_ID;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "CODEMASTER_GITHUB_INSTALLATION_ID env var is required for the worker composition root " +
        "(the git cloner clones as this GitHub App installation). Set it to the numeric installation id.",
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`CODEMASTER_GITHUB_INSTALLATION_ID must be an integer; got ${JSON.stringify(raw)}`);
  }
  if (value <= 0) {
    throw new Error(`CODEMASTER_GITHUB_INSTALLATION_ID must be >= 1; got ${value}`);
  }
  return value;
}

// ─── real git cloner (the cloneRepoIntoWorkspace production deps) ─────────────────────────────────

/**
 * Build the REAL {@link GitSubprocessCloner} for `cloneRepoIntoWorkspace`'s deps. Reuses the exact
 * token-provider construction the sibling GitHub activities use: ONE GitHub HTTP transport shared by the
 * token-provider's JWT→installation-token mint AND (here) the cloner's `getToken` calls, a Vault adapter
 * built from env, and a {@link GitHubAppTokenProvider} bound to `getToken`. The cloner takes the bound
 * `getToken` (a `(installationId) => Promise<string>` — the `TokenProvider` shape) + the env installation
 * id. Mirrors the frozen Python worker constructing `GitSubprocessCloner(token_provider=…, installation_id=…)`.
 *
 * Construction is deferred to the first `cloneRepoIntoWorkspace` dispatch (async — it `fromEnv`-builds the
 * token provider) and memoized, so the build stays off `VAULT_ADDR` / GitHub round-trips at worker boot,
 * matching the post_* activities that construct `VaultHttpPort.fromEnv()` inside the activity body.
 */
async function buildClonerDeps(githubInstallationId: number): Promise<CloneRepoIntoWorkspaceDeps> {
  const clock = new WallClock();
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  // The cloner shells out to git with the minted installation token; it needs only the bound `getToken`
  // (a `(installationId) => Promise<string>` — the `TokenProvider` shape) + the env installation id.
  const cloner = new GitSubprocessCloner({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    githubInstallationId,
  });
  return { cloner };
}

/**
 * Lazily build the cloner deps once, memoized across dispatches. The first `cloneRepoIntoWorkspace` call
 * constructs the real token provider (the deferred-Vault pattern); subsequent calls reuse it. A single
 * in-flight build is shared via the promise memo so concurrent first-dispatches don't double-construct.
 */
function makeClonerDepsResolver(
  githubInstallationId: number,
): () => Promise<CloneRepoIntoWorkspaceDeps> {
  let memo: Promise<CloneRepoIntoWorkspaceDeps> | undefined;
  return () => {
    if (memo === undefined) {
      memo = buildClonerDeps(githubInstallationId);
    }
    return memo;
  };
}

// ─── lazy GitHubIssueClient (the fetch_linked_issues github seam — deferred-Vault) ────────────────

/** The `getIssue` slice the FetchLinkedIssuesActivity consumes (1:1 with its `GithubIssuePort`). */
type GithubIssuePortShape = {
  getIssue(args: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    ifNoneMatch?: string | null;
  }): Promise<readonly [Record<string, unknown> | null, string | null, number]>;
};

/**
 * Build the REAL {@link GitHubIssueClient} for `fetchLinkedIssues`'s `github` seam. Reuses the exact
 * token-provider construction the cloner + the sibling GitHub activities use (one shared GitHub HTTP
 * transport, a Vault adapter from env, a {@link GitHubAppTokenProvider} bound to `getToken`). Deferred to
 * the first `getIssue` call (async `fromEnv`-build) so the worker boot stays off `VAULT_ADDR` / GitHub
 * round-trips — mirroring the deferred-Vault pattern the cloner + post_* activities use.
 */
async function buildIssueClient(): Promise<GitHubIssueClient> {
  const clock = new WallClock();
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  return new GitHubIssueClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
  });
}

/**
 * A {@link GithubIssuePortShape} that builds the real {@link GitHubIssueClient} on first `getIssue` (the
 * deferred-Vault pattern) and memoizes it. `fetchLinkedIssues` only ever calls `getIssue`, so this thin
 * lazy adapter is a faithful, fully-real client seam — construction is deferred to the moment a linked-issue
 * lookup actually fires (so `buildActivities()` stays cheap + off `VAULT_ADDR`).
 */
function makeLazyIssueClient(): GithubIssuePortShape {
  let memo: Promise<GitHubIssueClient> | undefined;
  return {
    getIssue: async (args) => {
      if (memo === undefined) {
        memo = buildIssueClient();
      }
      const client = await memo;
      return client.getIssue(args);
    },
  };
}

// ─── lazy GitHubApiReviewClient (the fix-prompt advisory-comment seam — deferred-Vault) ───────────

/** The `createIssueComment` slice the FixPromptActivities consumes (1:1 with its FixPromptIssueCommentClient). */
type FixPromptIssueCommentClientShape = {
  createIssueComment(args: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;
};

/**
 * Build the REAL {@link GitHubApiReviewClient} for `generateFixPrompt`'s advisory PR-comment seam — the SAME
 * wiring `post_review_placeholder` / `post_review_results` use (Vault token provider → GitHubApiClient →
 * wrapped client). The fix-prompt activity only ever calls `createIssueComment`, so the wrapped client
 * satisfies its loose {@link FixPromptIssueCommentClientShape}. Deferred to the first comment post (async
 * `fromEnv`-build) so worker boot stays off `VAULT_ADDR` / GitHub round-trips.
 */
async function buildFixPromptReviewClient(githubInstallationId: number): Promise<GitHubApiReviewClient> {
  const clock = new WallClock();
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  return new GitHubApiReviewClient({ api, installationId: githubInstallationId });
}

/**
 * A {@link FixPromptIssueCommentClientShape} that builds the real {@link GitHubApiReviewClient} on first
 * `createIssueComment` (the deferred-Vault pattern) and memoizes it. A faithful, fully-real client seam —
 * construction is deferred to the moment a fix-prompt advisory comment actually posts.
 */
function makeLazyFixPromptIssueClient(githubInstallationId: number): FixPromptIssueCommentClientShape {
  let memo: Promise<GitHubApiReviewClient> | undefined;
  return {
    createIssueComment: async (args) => {
      if (memo === undefined) {
        memo = buildFixPromptReviewClient(githubInstallationId);
      }
      const client = await memo;
      return client.createIssueComment(args);
    },
  };
}

// ─── real LlmClientCache (ledger-wired client factory — ADR-0068) ────────────────────────────────

/**
 * Build the REAL role-keyed {@link LlmClientCache} with the ledger-wired client factory (ADR-0068).
 *
 * 1:1 with the frozen Python worker `_client_factory` + `LlmClientCache(...)` wiring: the settings repo
 * (`PostgresLlmProviderSettingsRepo`, the real Vault-Transit decrypt) feeds BOTH the credentials provider
 * (TTL-refreshing per-role creds) AND the cache's freshness probe; the cache's custom `clientFactory`
 * builds a real {@link LlmClient} over the shared per-process collaborators (`sharedClientCollaborators`
 * — the Postgres cost-cap, blob store, telemetry writer, Langfuse exporter, clock) PLUS the real
 * {@link LlmInvocationLedger} (the de-dormant ADR-0068 #5 wiring). The default factory omits the ledger;
 * THIS factory supplies it, which is the whole point of doing the wiring in the composition root.
 *
 * The Vault adapter is built from env here — so this function is called LAZILY (first `bedrockReviewChunk`
 * dispatch), matching the deferred-Vault pattern; `buildActivities()` itself never calls it.
 */
function buildLlmClientCache(dsn: string): LlmClientCache {
  const vault = VaultHttpPort.fromEnv();
  const repo = PostgresLlmProviderSettingsRepo.fromDsn({ dsn, vault });
  const credentialsProvider = new LlmCredentialsProvider({ repo });

  // ADR-0068 — the ledger-wired client factory. The default `defaultClientFactory` builds the LlmClient
  // WITHOUT a ledger (the dormant state); here we thread the real Postgres-backed ledger so review
  // invocations are idempotent (a post-call persistence failure + a Temporal retry replays the stored
  // provider response instead of paying for a second Bedrock completion). `sharedClientCollaborators(dsn)`
  // is the same process-wide memo the default factory uses (cost-cap, blob, telemetry, Langfuse, clock),
  // so every role's client shares the spine singletons — exactly the Python `_client_factory` closure.
  const ledgerClientFactory: ClientFactory = ({ sdk }) => {
    const { costCap, blobStore, telemetry, langfuse, clock } = sharedClientCollaborators(dsn);
    return new LlmClient({
      sdk,
      costCap,
      blobStore,
      telemetry,
      langfuse,
      clock,
      ledger: LlmInvocationLedger.fromDsn(dsn),
    });
  };

  return new LlmClientCache({
    repo,
    credentialsProvider,
    clientFactory: ledgerClientFactory,
  });
}

/**
 * A {@link LlmClientCacheLike} that builds the real {@link LlmClientCache} on first `forRole` (the
 * deferred-Vault pattern) and memoizes it. `bedrockReviewChunk` only ever calls `forRole`, so this thin
 * lazy wrapper is a faithful, fully-real cache façade — no stub, just construction deferred to the moment
 * a review chunk is actually dispatched (so `buildActivities()` stays cheap + off `VAULT_ADDR`).
 */
function makeLazyLlmClientCache(dsn: string): LlmClientCacheLike {
  let cache: LlmClientCache | undefined;
  return {
    forRole: (role) => {
      if (cache === undefined) {
        cache = buildLlmClientCache(dsn);
      }
      return cache.forRole(role as Parameters<LlmClientCache["forRole"]>[0]);
    },
  };
}

// ─── the composition root ────────────────────────────────────────────────────────────────────────

/**
 * Build the activities map the worker registers. Constructs the real collaborators ONCE, binds / curries
 * every activity into a 1-arg Temporal activity, and returns the full review-pipeline surface.
 *
 * Every value is a `(input) => Promise<…>` — Temporal dispatches with exactly one positional argument, so
 * the 2-arg activities (`cloneRepoIntoWorkspace`, `bedrockReviewChunk`) are CURRIED with their real
 * collaborators, and the bound-method activities (`aggregateFindings`, `embedQuery`, `retrieveKnowledge`)
 * are registered as arrow-property methods that stay bound when destructured into the map.
 */
/**
 * Build a bare {@link GitHubApiClient} (which structurally satisfies {@link GithubContentsPort} via its
 * getContents/getRecursiveTree methods) through the SAME deferred-Vault wiring the issue/fix-prompt clients
 * use: Vault token provider → GitHubApiClient. Deferred to the first manifest fetch so worker boot stays off
 * VAULT_ADDR / GitHub round-trips.
 */
async function buildManifestContentsClient(): Promise<GitHubApiClient> {
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

/** A {@link GithubContentsPort} that lazily builds + memoizes the real client on first call (deferred-Vault). */
function makeLazyManifestContentsClient(): GithubContentsPort {
  let memo: Promise<GitHubApiClient> | undefined;
  const lazy = (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      memo = buildManifestContentsClient();
    }
    return memo;
  };
  return {
    getContents: async (args) => (await lazy()).getContents(args),
    getRecursiveTree: async (args) => (await lazy()).getRecursiveTree(args),
  };
}

export function buildActivities(): Record<string, (input: never) => Promise<unknown>> {
  const dsn = requireCoreDsn();
  const githubInstallationId = readGithubInstallationId();

  // The real platform embedder (Qwen / OpenAI-compat per ADR-0059; fail-loud on missing env). Shared by
  // the aggregate semantic-merge stage, the embed_query activity, and the retrieve-knowledge ANN port.
  const embedder = resolveEmbeddingsConsumer();

  // Bound-method activity holders — the real embedder threads into all three (1:1 with the frozen Python
  // bound-method-holder activity registrations). `.aggregateFindings` / `.embedQuery` / `.retrieveKnowledge`
  // are arrow properties, so they stay bound when destructured into the map (Temporal registers the value).
  const aggregateActivity = new AggregateFindingsActivity({ embedder });
  const embedQueryActivity = new EmbedQueryActivity({ embeddings: embedder, modelName: "qwen3-embed-0.6b" });
  // The lazy real LLM cache (deferred-Vault pattern; built on first forRole). Shared by bedrockReviewChunk,
  // walkthrough, fix-prompt, AND (E) the retrieve_knowledge per-invocation LLM reranker (default-off behind
  // CODEMASTER_LLM_RERANK_ENABLED — wired here so an operator can enable it without a code change).
  const llmCache = makeLazyLlmClientCache(dsn);
  const retrieveKnowledgeActivity = buildRetrieveKnowledgeActivity({ embedder, rerankCache: llmCache });
  // dedup_findings — the Temporal-activity port of the frozen Python `dedup_linter_with_llm` (the
  // semantic dedup stage embeds over the network, so it CANNOT run in the workflow sandbox; ADR-0065/0066).
  // Shares the same real embedder as the aggregate stage. FOLLOW-UP-dedup-findings-orchestrator-wiring:
  // the Workflow phase dispatches this between fan-out (Step 5) and aggregate (Step 7), replacing the
  // Python's inline `dedup_linter_with_llm` call. Registered here so the surface is dispatch-ready.
  const dedupFindingsActivity = new DedupFindingsActivity({ embedder });

  // The lazy real cloner-deps (deferred-Vault pattern; constructed on first dispatch). The shared LLM cache
  // (llmCache) is built earlier (above the retrieve-knowledge activity, which now also consumes it for E).
  const resolveClonerDeps = makeClonerDepsResolver(githubInstallationId);

  // generate_walkthrough bound-method holder — 1:1 with the frozen Python `WalkthroughActivities(cache=…)`.
  // It SHARES the same lazy ledger-wired LlmClientCache the review-chunk activity uses (the cache is
  // role-keyed; the walkthrough resolves `forRole("primary")` then selects `modelForPurpose("walkthrough")`
  // — claude-opus, distinct from the review role's sonnet — inside the activity body, exactly like
  // bedrockReviewChunk). `.generateWalkthrough` is an arrow property so it stays bound when destructured.
  const walkthroughActivities = new WalkthroughActivities({ cache: llmCache });

  // ── Stage-4 bound-method holders (fetch_linked_issues + fetch_suggested_reviewers) ──
  // Both read tenancy-scoped tables off the core DSN (lazy pool — no connection at construction). The
  // linked-issues holder additionally takes the lazy GitHubIssueClient (deferred-Vault). The
  // suggested-reviewers holder is flag-gated on `code_owners_v1` via `isEnabled`; the `core.flags` reader
  // is NOT ported to TS yet (it is an ingest-side helper out of this stage's scope), so `isEnabled` is
  // wired DEFAULT-OFF — 1:1 with the Python `read_code_owners_v1_enabled` production default (off until an
  // operator flips the rollout; the activity short-circuits to [] and the renderer drops the section).
  // FOLLOW-UP-code-owners-v1-flag-reader: port the `core.flags` reader so the operator can flip the rollout.
  const clock = new WallClock();
  const fetchLinkedIssuesActivity = new FetchLinkedIssuesActivity({
    linksRepo: PostgresLinkedIssuesRepo.fromDsn(dsn),
    cacheRepo: PostgresGithubIssuesCacheRepo.fromDsn({ dsn, clock }),
    github: makeLazyIssueClient(),
    clock,
  });
  const fetchSuggestedReviewersActivity = new FetchSuggestedReviewersActivity({
    prFilesRepo: PostgresPrFilesRepo.fromDsn({ dsn, clock }),
    codeOwnersRepo: PostgresCodeOwnersRepo.fromDsn(dsn),
    isEnabled: async (): Promise<boolean> => false,
    clock,
  });

  // ── Stage-5 fix-prompt bound-method holder (generate_fix_prompt) ──
  // Shares the SAME lazy ledger-wired LlmClientCache the review-chunk + walkthrough activities use (the
  // fix_prompt purpose resolves to sonnet via the central seed, inside the activity body). The repo is the
  // ported FixPromptRepo over the shared ADR-0062 pool; the GitHub seam is the lazy deferred-Vault
  // issue-comment client; the clock is the shared WallClock. `.generateFixPrompt` is an arrow property so it
  // stays bound when destructured into the map.
  const fixPromptActivities = new FixPromptActivities({
    cache: llmCache,
    repo: FixPromptRepo.fromDsn(dsn),
    gh: makeLazyFixPromptIssueClient(githubInstallationId),
    clock,
  });

  // ── static_analysis bound-method holder (REAL runner orchestration) ──
  // 1:1 with the frozen Python `_wire_static_analysis_activity`: the three in-worker runners
  // (Ruff/ESLint/Gitleaks — default binary names on $PATH; the worker-image provides the binaries) +
  // the soft-barrier StaticAnalysisOrchestrator (Tier-1 deadline + the shared WallClock) + the Haiku
  // AnalysisCurator (which resolves `forRole("secondary")` off the SAME lazy ledger-wired LlmClientCache
  // the review-chunk/walkthrough/fix-prompt activities use). The K8s-Job runners (Semgrep/Trivy/Checkov/
  // Kube-linter) are DEFERRED owner-provided infra — only the in-worker runners are registered today
  // (FOLLOW-UP-static-analysis-k8s-job-runners). The Tier-1 deadline is the frozen Python default
  // (review_budgets.yaml `tier1_static_analysis_seconds: 60`); the config-loader port is a separate
  // follow-up (FOLLOW-UP-review-budgets-loader). `.staticAnalysis` is an arrow property so it stays
  // bound when destructured into the map.
  const staticAnalysisActivity = buildStaticAnalysisActivity({
    runners: {
      ruff: new RuffInWorkerRunner(),
      eslint: new EslintInWorkerRunner(),
      gitleaks: new GitleaksInWorkerRunner(),
    },
    curatorCache: llmCache,
    deadlineSeconds: TIER1_STATIC_ANALYSIS_SECONDS,
    clock,
  });

  // ── #4 manifest fetch + parse bound-method holders ──
  // fetch_manifest_snapshots: the lazy deferred-Vault GitHubApiClient satisfies GithubContentsPort; the
  // holder defaults a fresh per-pod LRU cache. parse_manifest_dependencies: the shared WallClock drives the
  // per-manifest time-budget. (#6 load_parent_review_findings is a bare 1-arg function — registered below.)
  const fetchManifestSnapshotsHolder = new FetchManifestSnapshotsActivity({
    githubClient: makeLazyManifestContentsClient(),
  });
  const parseManifestDependenciesHolder = new ParseManifestDependenciesActivity({ clock });

  return {
    // ── 1-arg activities, ready as-is ──
    persistReviewFindings,
    persistReviewWalkthrough,
    classifyFiles,
    loadRepoConfigActivity,
    computePolicyRules,
    postCheckRun,
    postReviewResults,
    chunkAndRedact,
    redactChunks,
    // selectCarryForward(input) — pure deterministic 1-arg activity (no collaborators); registered bare.
    selectCarryForward,
    // staticAnalysis(input) — REAL runner orchestration. Bound arrow property holding the in-worker
    // runners + soft-barrier orchestrator + Haiku curator (shared ledger-wired LlmClientCache).
    staticAnalysis: staticAnalysisActivity.staticAnalysis,
    // ── self-defaulting (optional 2nd `deps` arg → fn.length === 1) — registered bare ──
    allocateWorkspace,
    releaseWorkspace,
    // ── Stage-2 lifecycle (gate + mutex lease renew/release + placeholder post/delete) ──
    // The gate (1-arg, raw payload), the renew/release mutex (mutex_id string + optional deps → fn.length
    // === 1), and the placeholder post/delete (1 typed input each). All registered bare. The workflow body
    // dispatches them directly by these registered names.
    startReviewForWebhook,
    renewPrReviewMutexLeaseActivity,
    releasePrReviewMutexActivity,
    postReviewPlaceholder,
    deleteReviewPlaceholder,
    // ── Stage-3 run-lifecycle (RUNNING→COMPLETED/FAILED/CANCELLED + ANALYSIS_STARTED/ANALYZED milestones) ──
    // Self-defaulting (optional 2nd `deps` arg → fn.length === 1); registered bare. Dispatched by the body.
    recordReviewLifecycleEvent,
    finalizeReviewRun,
    recordRunFailed,
    recordRunCancelled,
    // ── Stage-3 finding-delivery setters (the body's lifecycle-bookkeeping block + the orchestrator's H-2
    // inline skip). 1-arg typed inputs; registered bare. ──
    recordDeliveryFinalized,
    recordDeliverySkipped,
    recordDeliveryDegraded,
    // ── Stage-3 citation validation (orchestrator Step 7.5) + output-safety audit emit (chunk/walkthrough
    // sanitization_event). 1-arg typed inputs; registered bare. ──
    citationValidate,
    emitOutputSafetyAuditEvent,
    // ── Stage-4 enrichment (changed-files enrich + PR-desc summary + evidence manifest) ──
    // enrichPrFilesV2 / updatePrDescriptionSummary self-wire env inside the activity body (deferred-Vault)
    // → 1-arg → registered bare. buildRetrievedEvidence is stateless (pure modulo the node:crypto ev_id
    // mint, which is fine here in the Node runtime) → 1-arg → registered bare.
    enrichPrFilesV2,
    updatePrDescriptionSummary,
    buildRetrievedEvidence,
    // ── Stage-4 bound-method activities (linked-issues + suggested-reviewers; bound so they stay wired when
    // destructured into the map) ──
    fetchLinkedIssues: fetchLinkedIssuesActivity.fetchLinkedIssues.bind(fetchLinkedIssuesActivity),
    fetchSuggestedReviewers:
      fetchSuggestedReviewersActivity.fetchSuggestedReviewers.bind(fetchSuggestedReviewersActivity),
    // ── bound-method activities (real embedder) ──
    aggregateFindings: aggregateActivity.aggregateFindings,
    // dedup_findings — bound arrow property holding the shared real embedder (semantic dedup stage).
    dedupFindings: dedupFindingsActivity.dedupFindings,
    embedQuery: embedQueryActivity.embedQuery.bind(embedQueryActivity),
    retrieveKnowledge: retrieveKnowledgeActivity.retrieveKnowledge.bind(retrieveKnowledgeActivity),
    // generate_walkthrough — bound arrow property holding the shared ledger-wired LlmClientCache.
    generateWalkthrough: walkthroughActivities.generateWalkthrough,
    // ── #4 manifest fetch/parse + #6 carry-forward loader (camelCase keys = the workflow-body proxy names) ──
    fetchManifestSnapshots:
      fetchManifestSnapshotsHolder.fetchManifestSnapshots.bind(fetchManifestSnapshotsHolder),
    parseManifestDependencies:
      parseManifestDependenciesHolder.parseManifestDependencies.bind(parseManifestDependenciesHolder),
    loadParentReviewFindings: loadParentReviewFindingsActivity,
    // ── curried 2-arg activities (real collaborators threaded as the 2nd arg) ──
    // cloneRepoIntoWorkspace(req, deps) — curry the real GitSubprocessCloner deps so the registered
    // activity is genuinely 1-arg (the latent 2-arg-crash fix). Deps resolve lazily on first dispatch.
    cloneRepoIntoWorkspace: async (req: Parameters<typeof cloneRepoIntoWorkspace>[0]) =>
      cloneRepoIntoWorkspace(req, await resolveClonerDeps()),
    // bedrockReviewChunk(context, { cache }) — curry the real ledger-wired LlmClientCache.
    bedrockReviewChunk: (context: Parameters<typeof bedrockReviewChunk>[0]) =>
      bedrockReviewChunk(context, { cache: llmCache }),
    // ── Stage-5 (arbitration apply + tool-run record + fix-prompt) ──
    // applyArbitrationActivity / recordToolRuns self-wire their repos from CODEMASTER_PG_CORE_DSN (1-arg →
    // registered bare). generateFixPrompt is the FixPromptActivities bound arrow property (shared LLM cache +
    // repo + lazy GitHub client). The orchestrator dispatches all three under these registered names (Step
    // 7.7 arbitration + tool-runs; posting.ts fix-prompt).
    applyArbitrationActivity,
    recordToolRuns,
    generateFixPrompt: fixPromptActivities.generateFixPrompt,
  } as Record<string, (input: never) => Promise<unknown>>;
}
