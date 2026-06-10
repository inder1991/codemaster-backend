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
 *   - (per-review routing: NO `CODEMASTER_GITHUB_INSTALLATION_ID` — the per-PR numeric installation id is
 *     threaded through each GitHub activity's input; the cloner + fix-prompt seam mint per-call.)
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
// Auto-registration activities (combined-pod worker reuse — project-owner directive). Registered under their
// snake_case Temporal NAMES below so the reconcile/repair workflows (all_workflows.ts bundle) dispatch them.
// Each resolves its own DSN/pool/GitHub client inside the activity body (like enrichPrFilesV2) — no deps to
// thread through buildActivities.
import { reconcileInstallation } from "#backend/activities/reconcile_installation.activity.js";
import { reconcileRepositories } from "#backend/activities/reconcile_repositories.activity.js";
import { hydrateInstallationRepositories } from "#backend/activities/hydrate_installation_repositories.activity.js";
import { mutexJanitorActivity } from "#backend/activities/mutex_janitor.activity.js";
import { reviewRunReaperActivity } from "#backend/activities/review_run_reaper.activity.js";
import { GitHubApiReviewClient } from "#backend/integrations/github/review_client.js";

// ── Wave-2 retention cron activities (combined-pod worker reuse). Registered under their snake_case
// Temporal NAMES below so the 3 Wave-2 retention workflows (all_workflows.ts bundle) dispatch them. The
// run_id PR-closer needs a GitHubApiClient (the close-stale-PRs sweep); the other six self-resolve their
// DSN (+ clock) inside the activity body. ──
import { RunIdRetentionActivities } from "#backend/activities/run_id_retention.activity.js";
import { runPgPartmanMaintenanceActivity } from "#backend/activities/partition_maintenance.activity.js";
import {
  runWorkspaceOrphanSweepActivity,
  runWorkspaceReapActivity,
  runWorkspaceReleasedRetentionActivity,
} from "#backend/activities/workspace_retention.activity.js";

// ── Wave-4 Confluence ingest activities (combined-pod worker reuse — ADR-0075). Registered under their
// snake_case Temporal NAMES below so the 3 confluence workflows (all_workflows.ts bundle) dispatch them. ──
import {
  ConfluenceSyncActivities,
  PoolExistingChunkRowsReader,
  type ConfluenceChunkClient,
} from "#backend/activities/confluence_sync.activity.js";
import { ListActiveConfluenceSpacesActivity } from "#backend/activities/list_active_confluence_spaces.activity.js";
import { MarkStaleChunksActivity } from "#backend/activities/mark_stale_chunks.activity.js";
import { PostgresConfluenceChunksRepo } from "#backend/domain/repos/confluence_chunks_repo.js";
import { PostgresConfluencePageApprovalsRepo } from "#backend/domain/repos/confluence_page_approvals_repo.js";
import { makeLazyEmbedderCache } from "#backend/adapters/embedder_cache.js";
import { ConfluenceClient } from "#backend/integrations/confluence/client.js";
import { ConfluenceTokenProvider } from "#backend/integrations/confluence/token_provider.js";
import { tenantKysely } from "#platform/db/database.js";

import { GitHubIssueClient } from "#backend/integrations/github/issue_client.js";
import { PostgresLinkedIssuesRepo } from "#backend/domain/repos/pr_issue_links_repo.js";
import { PostgresGithubIssuesCacheRepo } from "#backend/domain/repos/github_issues_cache_repo.js";
import { PostgresPrFilesRepo } from "#backend/domain/repos/pr_files_repo.js";
import { PostgresCodeOwnersRepo } from "#backend/domain/repos/code_owners_repo.js";

// ── Wave-3 spine activities (clone primitive + CODEOWNERS sync + semantic-docs refresh) ──
// The refresh_semantic_docs workflow (all_workflows.ts bundle) proxies clone_repository_activity (Step 1) +
// refresh_semantic_docs_activity (Step 2); the sync_code_owners workflow proxies sync_code_owners_activity.
// All three resolve their real collaborators here (the lazy deferred-Vault token provider / GitHub contents
// client + the shared embedder + the Postgres repos over the ADR-0062 pool).
import { cloneRepositoryActivity } from "#backend/activities/clone_repository.activity.js";
import {
  SyncCodeOwnersActivity,
  type CodeOwnersFilePort,
} from "#backend/activities/sync_code_owners.activity.js";
import { RefreshSemanticDocsActivity } from "#backend/activities/refresh_semantic_docs.activity.js";
import { PostgresKnowledgeChunkRepo } from "#backend/domain/repos/knowledge_chunks_repo.js";
import { type TokenProvider } from "#backend/integrations/github/api_client.js";

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
async function buildClonerDeps(): Promise<CloneRepoIntoWorkspaceDeps> {
  const clock = new WallClock();
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  // The cloner shells out to git with the minted installation token; it needs only the bound `getToken`
  // (a `(installationId) => Promise<string>` — the `TokenProvider` shape). Per-review routing: the cloner is
  // NO LONGER bound to one installation id — the clone activity passes the per-PR id to `cloner.clone()`.
  const cloner = new GitSubprocessCloner({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
  });
  return { cloner };
}

/**
 * Lazily build the cloner deps once, memoized across dispatches. The first `cloneRepoIntoWorkspace` call
 * constructs the real token provider (the deferred-Vault pattern); subsequent calls reuse it. A single
 * in-flight build is shared via the promise memo so concurrent first-dispatches don't double-construct.
 * The cloner is installation-agnostic (per-review routing); the per-PR id is threaded through each clone call.
 */
function makeClonerDepsResolver(): () => Promise<CloneRepoIntoWorkspaceDeps> {
  let memo: Promise<CloneRepoIntoWorkspaceDeps> | undefined;
  return () => {
    if (memo === undefined) {
      memo = buildClonerDeps();
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

/** The issue-comment slice the FixPromptActivities consumes (1:1 with its FixPromptIssueCommentClient):
 *  `createIssueComment` (post) + `listIssueComments` (the W3.3 operational-marker recovery oracle).
 *  `installationId` is PER-CALL (per-review routing) — the seam is no longer bound to one installation. */
type FixPromptIssueCommentClientShape = {
  createIssueComment(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;
  listIssueComments(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;
};

/**
 * Build the REAL {@link GitHubApiClient} for `generateFixPrompt`'s advisory PR-comment seam — the SAME
 * Vault token provider → GitHubApiClient wiring `post_review_results` uses. Installation-agnostic
 * (per-review routing): the per-PR id is supplied PER-CALL, so the thin {@link GitHubApiReviewClient}
 * wrapper is built per comment with the call's installation id (the expensive token provider + api are
 * memoized). Deferred to the first comment post (async `fromEnv`-build) so worker boot stays off
 * `VAULT_ADDR` / GitHub round-trips.
 */
async function buildFixPromptApi(): Promise<GitHubApiClient> {
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
 * A {@link FixPromptIssueCommentClientShape} that builds the real {@link GitHubApiClient} on first
 * `createIssueComment` (the deferred-Vault pattern) and memoizes it, then wraps it in a thin
 * {@link GitHubApiReviewClient} PER-CALL bound to the call's installation id (per-review routing — one seam
 * serves every org). A faithful, fully-real client seam.
 */
function makeLazyFixPromptIssueClient(): FixPromptIssueCommentClientShape {
  let memo: Promise<GitHubApiClient> | undefined;
  const apiFor = async (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      memo = buildFixPromptApi();
    }
    return memo;
  };
  return {
    createIssueComment: async ({ installationId, ...rest }) => {
      const api = await apiFor();
      return new GitHubApiReviewClient({ api, installationId }).createIssueComment(rest);
    },
    // W3.3 marker-recovery oracle — list the PR's issue comments so the activity can recover a comment that
    // was posted right before a crash (the marker scan happens activity-side). Per-call installation routing.
    listIssueComments: async ({ installationId, ...rest }) => {
      const api = await apiFor();
      return new GitHubApiReviewClient({ api, installationId }).listIssueComments(rest);
    },
  };
}

// ─── lazy GitHubApiClient (the run_id retention PR-closer seam — deferred-Vault, fail-open) ───────
//
// The Wave-2 `run_id_close_stale_prs` sweep closes ephemeral smoke PRs via a real {@link GitHubApiClient}
// (it calls `.get` to list open PRs by branch + `.patch` to close them). `RunIdRetentionActivities`
// fail-CLOSES if its `githubClient` is undefined (it throws at method entry, BEFORE any DB query) — so the
// holder MUST be handed a client object. We hand it a LAZY {@link GitHubApiClient} (the same deferred-Vault
// shape the issue / fix-prompt / manifest clients use): the underlying real client is built on the FIRST
// `.get`/`.patch` call and memoized, so worker boot stays off `VAULT_ADDR` / GitHub round-trips. In dev the
// candidate SQL returns ZERO ephemeral runs (none are stale), so the sweep never reaches a `.get`/`.patch`
// → the lazy client is NEVER built → an absent dev GitHub-App Vault token can't crash the daily 3am sweep.
// Only `.get` and `.patch` are reachable from the PR-closer, so the lazy structural proxy exposing exactly
// those two methods is a faithful, fully-real client seam (no stub).

/**
 * A {@link GitHubApiClient} that builds the real client on first `.get`/`.patch` (the deferred-Vault,
 * fail-open pattern) and memoizes it. The PR-closer (`runIdCloseStalePrsActivity`) only ever calls `.get`
 * (list open PRs by head) + `.patch` (close a PR), so exposing exactly those two lazily-resolving methods is
 * a faithful real seam. Cast to {@link GitHubApiClient} (the ctor field type) — the rest of the class
 * surface is unreachable from the PR-closer code path.
 */
function makeLazyRetentionGithubClient(): GitHubApiClient {
  let memo: Promise<GitHubApiClient> | undefined;
  const lazy = (): Promise<GitHubApiClient> => {
    if (memo === undefined) {
      // Same deferred-Vault wiring buildFixPromptApi / buildManifestContentsClient use.
      memo = buildFixPromptApi();
    }
    return memo;
  };
  return {
    get: async (path: Parameters<GitHubApiClient["get"]>[0], opts: Parameters<GitHubApiClient["get"]>[1]) =>
      (await lazy()).get(path, opts),
    patch: async (
      path: Parameters<GitHubApiClient["patch"]>[0],
      opts: Parameters<GitHubApiClient["patch"]>[1],
    ) => (await lazy()).patch(path, opts),
  } as unknown as GitHubApiClient;
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

// ─── lazy GitHubAppTokenProvider (the clone_repository_activity getToken seam — deferred-Vault) ────
//
// `clone_repository_activity` REQUIRES a `getToken: TokenProvider` (numeric installation id → install
// token) — there is no production default in the activity module (no Vault-backed provider lives there),
// so the integrator wires it here. It is the SAME token-provider construction the review cloner +
// issue/fix-prompt/manifest clients use (one shared GitHub HTTP transport + a Vault adapter from env + a
// {@link GitHubAppTokenProvider}). Deferred to the first clone dispatch (async `fromEnv`-build) + memoized,
// so worker boot stays off `VAULT_ADDR` / GitHub round-trips — mirroring the deferred-Vault pattern the
// other GitHub seams use.

/**
 * A {@link TokenProvider} that builds the real {@link GitHubAppTokenProvider} on first call (the
 * deferred-Vault pattern) and memoizes it, then mints the installation token for the per-call NUMERIC
 * installation id. `clone_repository_activity` calls this with `githubInstallationId` resolved at the
 * activity boundary. A faithful, fully-real token seam — no stub, just construction deferred + memoized.
 */
function makeLazyTokenProvider(): TokenProvider {
  let memo: Promise<GitHubAppTokenProvider> | undefined;
  const lazy = (): Promise<GitHubAppTokenProvider> => {
    if (memo === undefined) {
      memo = (async (): Promise<GitHubAppTokenProvider> => {
        const clock = new WallClock();
        const githubHttp = new FetchGitHubHttpClient({});
        const vault = VaultHttpPort.fromEnv();
        return GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
      })();
    }
    return memo;
  };
  return async (installationId: number): Promise<string> => (await lazy()).getToken(installationId);
}

// ─── CODEOWNERS file port (the sync_code_owners_activity GitHub seam — deferred-Vault, 3-path lookup) ──
//
// 1:1 with the Python `_SpineCodeOwnersAdapter` (worker/main.py:2565-2589): wrap a lazy deferred-Vault
// GitHubApiClient.getContents behind the activity's narrow {@link CodeOwnersFilePort}. Tries the three
// CODEOWNERS lookup paths in order (`.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`) per GitHub's
// documented resolution; returns the first one that exists (base64-ASCII bytes + blob SHA), or null when
// none of the conventional paths host a CODEOWNERS file (the activity treats null as a no-op → returns 0).

/** The three conventional CODEOWNERS paths, tried in order (1:1 with the Python `_CODEOWNERS_LOOKUP_PATHS`). */
const CODEOWNERS_LOOKUP_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/**
 * A {@link CodeOwnersFilePort} that wraps the lazy deferred-Vault {@link GithubContentsPort} (the SAME
 * `getContents` seam the manifest fetch uses) with the 3-path CODEOWNERS lookup. 1:1 with the Python
 * `_SpineCodeOwnersAdapter.fetch_codeowners`. `getContents` additionally takes a telemetry-only
 * `installationUuid` (NOT consumed by `_request`); the port only carries the numeric id, so the stringified
 * numeric id is supplied for that unused parameter.
 */
function makeCodeOwnersFilePort(): CodeOwnersFilePort {
  const contents = makeLazyManifestContentsClient();
  return {
    fetchCodeowners: async (args): Promise<readonly [Uint8Array, string] | null> => {
      for (const path of CODEOWNERS_LOOKUP_PATHS) {
        const result = await contents.getContents({
          installationId: args.installationId,
          // Telemetry-only param the GitHub `_request` does not consume; the port carries only the numeric
          // id, so the stringified numeric id stands in for the unused UUID telemetry slot.
          installationUuid: String(args.installationId),
          owner: args.owner,
          repo: args.repo,
          path,
          ref: args.ref,
        });
        if (result !== null) {
          return result;
        }
      }
      // None of the conventional paths host a CODEOWNERS file — no-op (the activity returns 0).
      return null;
    },
  };
}

// ─── lazy ConfluenceClient (the confluence-sync read seam — deferred-Vault, fail-open) ────────────
//
// The Confluence Vault token is ABSENT in dev (ADR-0075): there is no `codemaster/confluence/token` KV
// secret. `ConfluenceTokenProvider.fromVault` is fail-HARD (it rejects on a missing/invalid Vault secret),
// so building the real ConfluenceClient EAGERLY at worker boot would crash a dev pod that never even has a
// Confluence space configured. The lazy adapter below defers the entire Vault → token-provider → client
// construction to the FIRST `listPages`/`getPage` call and memoizes it. In dev,
// `list_active_confluence_spaces_activity` returns ZERO spaces (no `core.integrations` confluence_space
// rows), so the sync workflow never reaches a per-space `fetch_space_pages` → the client is NEVER built →
// the absent Vault token never trips boot. In prod (token present, spaces configured), the first sync tick
// builds the real client through the same Vault-backed token-provider the Python worker uses.

/**
 * Build the REAL {@link ConfluenceClient} from the Vault-backed {@link ConfluenceTokenProvider}. Mirrors
 * the deferred-Vault pattern the GitHub clients use: `ConfluenceTokenProvider.fromVault` reads the
 * `codemaster/confluence/token` KV secret (base_url + token [+ optional email]) and is fail-HARD on a
 * missing/invalid secret — so this is called LAZILY on first use, never at boot. The provider's
 * `tokenProvider` (`getToken`) is invoked per request so a rotated token propagates without restart; its
 * `baseUrl` + optional Cloud `authEmail` (HTTP-Basic vs Bearer) select the auth scheme. The background
 * refresh loop is started so the cached token stays fresh across the 6h sync cadence.
 */
async function buildConfluenceClient(): Promise<ConfluenceClient> {
  const vault = VaultHttpPort.fromEnv();
  const clock = new WallClock();
  const tokenProvider = await ConfluenceTokenProvider.fromVault({ vault, clock });
  tokenProvider.startRefreshLoop();
  // `authEmail` selects HTTP-Basic (Atlassian Cloud) vs Bearer (Server/DC PAT). It is OMITTED (not set to
  // `undefined`) when the provider has no Cloud email, per exactOptionalPropertyTypes — a `null` email keeps
  // the Bearer scheme.
  const authEmail = tokenProvider.authEmail;
  return new ConfluenceClient({
    baseUrl: tokenProvider.baseUrl,
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    ...(authEmail !== null ? { authEmail } : {}),
    clock,
  });
}

/**
 * A {@link ConfluenceChunkClient} (the narrow `listPages`/`getPage` slice {@link ConfluenceClient}
 * satisfies structurally) that builds the real client on first use (the deferred-Vault, fail-open
 * pattern) and memoizes it. Construction is deferred to the moment a sync actually touches Confluence —
 * which in dev (no configured spaces) NEVER happens, so the absent Vault token can't crash boot. A
 * faithful, fully-real client seam: no stub, just construction deferred + memoized.
 */
function makeLazyConfluenceClient(): ConfluenceChunkClient {
  let memo: Promise<ConfluenceClient> | undefined;
  const lazy = (): Promise<ConfluenceClient> => {
    if (memo === undefined) {
      memo = buildConfluenceClient();
    }
    return memo;
  };
  return {
    listPages: async (args) => (await lazy()).listPages(args),
    getPage: async (args) => (await lazy()).getPage(args),
  };
}

export function buildActivities(): Record<string, (input: never) => Promise<unknown>> {
  const dsn = requireCoreDsn();
  // Per-review routing: the worker composition root NO LONGER reads CODEMASTER_GITHUB_INSTALLATION_ID. Every
  // GitHub-touching activity (clone, post, check-run, fix-prompt, pr-description) resolves the per-PR numeric
  // installation id from its typed input; the cloner + fix-prompt seam mint per-call. One pod serves all orgs.

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
  const resolveClonerDeps = makeClonerDepsResolver();

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
    gh: makeLazyFixPromptIssueClient(),
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

  // ── Wave-4 Confluence ingest holders (combined-pod worker reuse — ADR-0075) ──
  // The 8 confluence activities run on THIS review worker (queue "review-default"); the 3 confluence
  // workflows (all_workflows.ts bundle) proxy them by their snake_case Temporal names. The sync holder is
  // wired with: the LAZY fail-open ConfluenceClient (the narrow listPages/getPage slice — built on first
  // Confluence touch, NEVER at boot, so the dev-absent Vault token can't crash startup); the SHARED real
  // embedder (the same EmbeddingsPort the review path resolves) + its model name (the same
  // "qwen3-embed-0.6b" the embed_query activity uses); the PostgresConfluenceChunksRepo over the shared
  // ADR-0062 pool (satisfies BOTH the idempotency-lookup `findExistingChunkEmbedding` AND the
  // upsert/reconcile writer slices); the PostgresConfluencePageApprovalsRepo (the `getActiveApproval`
  // reader); and the PoolExistingChunkRowsReader (the hard-limit candidate-row fetcher). embedderCache is
  // NOW wired (SCOPE-A) via the LAZY DSN-memoized façade: upsert dual-writes each vector to
  // core.chunk_embeddings under the active generation IN ADDITION to the legacy embedding column. The build
  // is deferred to the first upsert (the façade's refresh() builds + starts the real cache), keeping worker
  // boot off the DB. It is the SAME DSN-memoized singleton buildConfluencePort wires into the confluence
  // retrieval adapter (makeLazyEmbedderCache over the same dsn → buildEmbedderCacheForDsn(dsn) memo), so
  // retrieval + dual-write read ONE snapshot. SAFE-DEFAULT: the dual-write only POPULATES chunk_embeddings;
  // retrieval stays at retrieval_mode='fallback' (Phase A === legacy) until an operator flips to
  // 'generation_only'.
  const confluenceChunksRepo = new PostgresConfluenceChunksRepo({ db: tenantKysely(dsn), clock });
  const confluencePageApprovalsRepo = new PostgresConfluencePageApprovalsRepo({
    db: tenantKysely(dsn),
  });
  const confluenceSyncActivities = new ConfluenceSyncActivities({
    client: makeLazyConfluenceClient(),
    embeddings: embedder,
    modelName: "qwen3-embed-0.6b",
    chunkEmbeddingLookup: confluenceChunksRepo,
    chunksWriter: confluenceChunksRepo,
    approvalsReader: confluencePageApprovalsRepo,
    existingChunkRowsReader: new PoolExistingChunkRowsReader({ dsn }),
    embedderCache: makeLazyEmbedderCache(dsn, { clock }),
  });
  // The entry-point + staleness holders self-resolve the shared pool from the injected dsn (lazy pool —
  // no connection at construction). In dev, listActiveSpaces returns ZERO rows (no configured spaces), so
  // the sync loop never reaches the lazy ConfluenceClient.
  const listActiveConfluenceSpacesActivity = new ListActiveConfluenceSpacesActivity({ dsn });
  const markStaleChunksActivity = new MarkStaleChunksActivity({ dsn });

  // ── Wave-2 retention cron holder (run_id close-stale-PRs / retire-runs / delete-events) ──
  // The PR-closer needs a GitHubApiClient (the close-stale-PRs sweep lists + closes ephemeral smoke PRs);
  // it's handed the LAZY deferred-Vault client (built on first GitHub touch — never at boot, and never at
  // all in dev where the candidate SQL returns zero stale ephemeral runs). The retire-runs / delete-events
  // sweeps self-resolve the shared pool + clock from env inside the activity body (the holder injects
  // neither dsn nor clock → each sweep reads CODEMASTER_PG_CORE_DSN + WallClock). The 3 bound methods are
  // registered under their snake_case Temporal names below (the runIdRetentionWorkflow proxies them by
  // those exact keys). The other 4 Wave-2 activities (partition + the 3 workspace sweeps) are bare 0-arg
  // self-resolving functions — registered directly.
  const runIdRetentionActivities = new RunIdRetentionActivities({
    githubClient: makeLazyRetentionGithubClient(),
  });

  // ── Wave-3 spine holders (clone primitive + CODEOWNERS sync + semantic-docs refresh) ──
  // clone_repository_activity REQUIRES `getToken` (no production default in the module) — wired to the lazy
  // deferred-Vault token provider (the SAME GitHubAppTokenProvider mint the review cloner uses; called with
  // the per-PR NUMERIC installation id resolved at the activity boundary); `cloner`/`resolveRepo` fall to
  // their real production defaults. sync_code_owners_activity is wired with: the 3-path CODEOWNERS file port
  // (lazy deferred-Vault getContents — 1:1 with the Python `_SpineCodeOwnersAdapter`); PostgresCodeOwnersRepo
  // over the shared ADR-0062 pool; and `isEnabled` DEFAULT-OFF (the `code_owners_v1` flag reader is unported
  // — FOLLOW-UP-code-owners-v1-flag-reader, same default-off precedent as fetch_suggested_reviewers). The
  // refresh_semantic_docs holder shares the SAME real embedder + model name ("qwen3-embed-0.6b") the
  // confluence chunk_and_embed / embed_query path uses, over a PostgresKnowledgeChunkRepo on the shared pool.
  const cloneRepositoryGetToken = makeLazyTokenProvider();
  const syncCodeOwnersActivity = new SyncCodeOwnersActivity({
    github: makeCodeOwnersFilePort(),
    repo: PostgresCodeOwnersRepo.fromDsn(dsn),
    isEnabled: async (): Promise<boolean> => false,
    clock,
  });
  const refreshSemanticDocsActivity = new RefreshSemanticDocsActivity({
    embeddings: embedder,
    chunkRepo: PostgresKnowledgeChunkRepo.fromDsn(dsn),
    modelName: "qwen3-embed-0.6b",
  });

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
    // generateFixPrompt's bound arrow property has arity 3 (input, signal?, opts?). Temporal dispatches
    // activities with exactly ONE positional arg (single-typed-input invariant #11), so the REGISTERED
    // value is curried to a 1-arg wrapper that forwards only the input — signal/opts default to undefined
    // (their existing optional behavior). The non-Temporal shell calls the bound method directly with signal.
    generateFixPrompt: (input: Parameters<typeof fixPromptActivities.generateFixPrompt>[0]) =>
      fixPromptActivities.generateFixPrompt(input),
    // ── Auto-registration activities (combined-pod worker reuse — project-owner directive) ──
    // Registered under their snake_case TEMPORAL NAMES (NOT camelCase) because the reconcile/repair
    // workflows (reconcile.workflow.ts) proxy them by those exact names — a camelCase key would dispatch
    // `ActivityNotRegistered`. Each is a self-wiring 1-arg activity (resolves CODEMASTER_PG_CORE_DSN + its
    // own pool / GitHub client inside the body), so it's registered bare. The bracketed-string keys mirror
    // the Python `@activity.defn(name="...")` registration names.
    ["reconcile_installation_activity"]: reconcileInstallation,
    ["reconcile_repositories_activity"]: reconcileRepositories,
    ["hydrate_installation_repositories_activity"]: hydrateInstallationRepositories,
    // ── Wave-1 liveness-backstop activities (ADR-0074 / ADR-0064) ──
    // Cron-scheduled sweeps (mutex janitor every 5 min, review-run reaper every 10 min) registered under
    // their snake_case TEMPORAL NAMES because the MutexJanitor/ReviewRunReaper workflows proxy them by those
    // exact names (a camelCase key would dispatch `ActivityNotRegistered`). Self-wiring 0-arg activities
    // (resolve CODEMASTER_PG_CORE_DSN + clock inside the body), registered bare.
    ["mutex_janitor_activity"]: mutexJanitorActivity,
    ["review_run_reaper_activity"]: reviewRunReaperActivity,
    // ── Wave-4 Confluence ingest activities (combined-pod worker reuse — ADR-0075) ──
    // Registered under their snake_case TEMPORAL NAMES because the 3 confluence workflows
    // (confluence_ingest / mark_stale_chunks / trigger_page_resync, all in all_workflows.ts) proxy them by
    // those exact names — a camelCase key would dispatch `ActivityNotRegistered`. The bound-method holders
    // are bound (`.bind(holder)`) so the `this` stays wired when destructured into the map.
    ["list_active_confluence_spaces_activity"]:
      listActiveConfluenceSpacesActivity.listActiveSpaces.bind(listActiveConfluenceSpacesActivity),
    ["fetch_space_pages_activity"]:
      confluenceSyncActivities.fetchSpacePages.bind(confluenceSyncActivities),
    ["fetch_page_body_activity"]:
      confluenceSyncActivities.fetchPageBody.bind(confluenceSyncActivities),
    ["sanitize_page_activity"]: confluenceSyncActivities.sanitizePage.bind(confluenceSyncActivities),
    ["chunk_and_embed_activity"]:
      confluenceSyncActivities.chunkAndEmbed.bind(confluenceSyncActivities),
    ["upsert_chunks_activity"]: confluenceSyncActivities.upsertChunks.bind(confluenceSyncActivities),
    ["reconcile_deletions_activity"]:
      confluenceSyncActivities.reconcileDeletions.bind(confluenceSyncActivities),
    ["mark_stale_chunks_activity"]:
      markStaleChunksActivity.markStaleChunks.bind(markStaleChunksActivity),
    // ── Wave-2 retention cron activities (combined-pod worker reuse) ──
    // Registered under their snake_case TEMPORAL NAMES because the 3 Wave-2 retention workflows
    // (runIdRetentionWorkflow / partitionMaintenanceWorkflow / workspaceRetentionWorkflow, all in
    // all_workflows.ts) proxy them by those exact names — a camelCase key would dispatch
    // ActivityNotRegistered. The 3 run_id sweeps are bound methods of the RunIdRetentionActivities holder
    // (the PR-closer carries the lazy deferred-Vault GitHubApiClient); partition + the 3 workspace sweeps
    // are bare 0-arg self-resolving functions.
    ["run_id_close_stale_prs"]:
      runIdRetentionActivities.runIdCloseStalePrs.bind(runIdRetentionActivities),
    ["run_id_retire_old_runs"]:
      runIdRetentionActivities.runIdRetireOldRuns.bind(runIdRetentionActivities),
    ["run_id_delete_old_events"]:
      runIdRetentionActivities.runIdDeleteOldEvents.bind(runIdRetentionActivities),
    ["run_pg_partman_maintenance"]: runPgPartmanMaintenanceActivity,
    ["run_workspace_orphan_sweep_activity"]: runWorkspaceOrphanSweepActivity,
    ["run_workspace_reap_activity"]: runWorkspaceReapActivity,
    ["run_workspace_released_retention_activity"]: runWorkspaceReleasedRetentionActivity,
    // ── Wave-3 spine activities (clone primitive + CODEOWNERS sync + semantic-docs refresh) ──
    // Registered under their snake_case TEMPORAL NAMES because the 2 Wave-3 workflows (sync_code_owners +
    // refresh_semantic_docs, both in all_workflows.ts) proxy them by those exact names — a camelCase key
    // would dispatch ActivityNotRegistered (the refresh workflow proxies BOTH clone_repository_activity as
    // Step 1 AND refresh_semantic_docs_activity as Step 2). clone_repository_activity(input, deps) is
    // CURRIED with the lazy deferred-Vault token provider so the registered value is genuinely 1-arg; the
    // sync + refresh holders are bound (`.bind(holder)`) so `this` stays wired when destructured.
    ["clone_repository_activity"]: (input: Parameters<typeof cloneRepositoryActivity>[0]) =>
      cloneRepositoryActivity(input, { getToken: cloneRepositoryGetToken }),
    ["sync_code_owners_activity"]:
      syncCodeOwnersActivity.syncCodeOwners.bind(syncCodeOwnersActivity),
    ["refresh_semantic_docs_activity"]:
      refreshSemanticDocsActivity.refreshSemanticDocs.bind(refreshSemanticDocsActivity),
  } as Record<string, (input: never) => Promise<unknown>>;
}
