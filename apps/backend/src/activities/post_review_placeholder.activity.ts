/**
 * `post_review_placeholder` activity — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/post_review_placeholder.py` (Phase 1 PR-1c).
 *
 * Posts a short "reviewing this PR..." placeholder **PR conversation-tab comment** (issue comment)
 * immediately when the review workflow starts — after the gate accepts the PR, before the heavy
 * clone/classify/chunk/review work runs. Engineers see life on the PR within ~5 seconds of webhook
 * receipt instead of a 30-120s silent gap.
 *
 * ## Surface choice — issue comment, NOT review
 *
 * The placeholder uses the issue-comment surface (POST /issues/{n}/comments) NOT the review surface
 * (POST /pulls/{n}/reviews) — three reasons, all preserved from the Python docstring:
 *   1. The heavy `post_review_results._do_post` activity claims `core.posted_reviews` atomically
 *      (Sprint 14 / S14.D). The placeholder does NOT participate in that claim — the correctness-load-
 *      bearing review path stays completely untouched.
 *   2. GitHub finalises a posted review's inline comments at create time; the review API offers no path
 *      to add inline comments to an existing review. A shared-placeholder + update-in-place pattern
 *      would silently lose every inline comment.
 *   3. Issue comments are an orthogonal surface — the heavy review and the placeholder don't fight over
 *      the same resource.
 *
 * ## Best-effort (CLAUDE.md core-loop discipline)
 *
 * GitHub I/O failures during the placeholder are logged at WARNING and SWALLOWED. The placeholder is a
 * UX affordance, not a correctness primitive; failing the review on placeholder failure would be a worse
 * outcome than a 30s silent gap. The audit emit is also swallowed (loses dashboards, not state). The
 * activity NEVER raises — the review pipeline proceeds regardless.
 *
 * ## Idempotency
 *
 * Temporal at-least-once retry calls this activity multiple times. The list-issue-comments + marker
 * filter short-circuits subsequent calls so exactly one placeholder comment exists per PR (covers both a
 * Temporal retry of this activity AND a re-trigger workflow on the same PR).
 *
 * ## Feature flag (read at invocation, fail-safe default OFF)
 *
 * `CODEMASTER_REVIEW_PLACEHOLDER_ENABLED` MUST equal `"1"` to enable the placeholder; ANY other value
 * (including unset) disables it. The flag is read INSIDE {@link postReviewPlaceholder} (not at module
 * import) so a Helm value flip takes effect on the next workflow without a worker restart — 1:1 with the
 * Python `os.getenv` placement inside the activity body.
 *
 * ## DI idiom (matches the sibling `allocate_workspace` / `post_review_results` ports)
 *
 * The Python uses a module-level `configure(gh_client, session_factory, clock)` + `_require_configured`.
 * The TS port follows the established activity idiom instead: a pure inner function {@link doPostPlaceholder}
 * that takes its collaborators as INJECTED deps (so unit tests drive it with a stub GitHub client + a stub
 * audit-emit callback, and the DB-integration test drives it with the real {@link emitWorkflowEvent} over a
 * disposable PG), plus a thin Temporal-activity wrapper {@link postReviewPlaceholder} that constructs the
 * production GitHub client (Vault-token-provider → GitHubApiClient → GitHubApiReviewClient) + the
 * audit-emit closure (a transaction over the ADR-0062 shared pool). The `not_configured` RuntimeError
 * swallow has no analogue here — the wrapper's deps are constructed unconditionally, so the
 * "configure() was never called" failure mode is structurally unreachable in TS.
 */

import { tenantKysely } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import { type Transaction } from "kysely";

import {
  GitHubApiReviewClient,
} from "#backend/integrations/github/review_client.js";
import { FetchGitHubHttpClient, GitHubApiClient } from "#backend/integrations/github/api_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { emitWorkflowEvent } from "#backend/ingest/_workflow_events_repository.js";

import { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";

// ─── marker ─────────────────────────────────────────────────────────────────────────────────────
//
// The placeholder marker is DELIBERATELY DISTINCT from the review marker
// (`<!-- codemaster:review-marker:{pr_id} -->` in post_review_results.activity.ts::markerFor) so the
// two surfaces cannot accidentally collide. The cleanup activity finds the placeholder via THIS marker;
// the review's atomic claim path uses its own marker. 1:1 with the Python `_marker_for`.

/** The hidden HTML-comment marker embedded in the placeholder issue-comment body. */
export function markerForPlaceholder(prId: string): string {
  return `<!-- codemaster:placeholder-marker:${prId} -->`;
}

/**
 * Render the placeholder issue-comment body with the embedded marker. 1:1 (byte-for-byte) with the
 * Python `_placeholder_body`. The marker is the contract with `delete_review_placeholder_activity`; its
 * list-issue-comments + marker filter locates this comment for cleanup.
 */
export function placeholderBody(prId: string): string {
  const marker = markerForPlaceholder(prId);
  return (
    "🤖 **codemaster review** - reviewing this PR...\n\n" +
    "> This comment will be replaced with the full review when " +
    "the analysis completes (typically 30-120 seconds).\n\n" +
    `${marker}\n`
  );
}

// ─── injected collaborators ───────────────────────────────────────────────────────────────────────

/**
 * The minimal issue-comment GitHub surface the placeholder POST depends on — a structural subset of
 * {@link GhReviewClient}, so the production `GitHubApiReviewClient` satisfies it and a unit-test stub need
 * only implement these two methods. 1:1 with the Python `GhIssueCommentClient` Protocol (list + create).
 */
export type GhIssueCommentPostClient = {
  listIssueComments(args: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;
  createIssueComment(args: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;
};

/**
 * Best-effort audit-emit callback: writes the `REVIEW_PLACEHOLDER_POSTED` workflow event. The production
 * wrapper closes over a transaction on the ADR-0062 shared pool + {@link emitWorkflowEvent}; the unit test
 * supplies a spy (or a throwing stub to exercise the swallow path). 1:1 in role with the Python
 * `emit_workflow_event(...)` call inside the `session_factory()` block.
 */
export type PlaceholderAuditEmit = (args: {
  runId: string;
  reviewId: string;
  installationId: string;
  prId: string;
  prNumber: number;
  githubCommentId: number;
}) => Promise<void>;

/**
 * Injected collaborators for {@link doPostPlaceholder}. Both REQUIRED here — the pure function takes its
 * deps explicitly (the wrapper constructs the production ones). 1:1 in role with the Python
 * `configure(gh_client=..., session_factory=...)` triple (the clock is folded into {@link emitEvent}).
 */
export type PostPlaceholderDeps = {
  ghClient: GhIssueCommentPostClient;
  emitEvent: PlaceholderAuditEmit;
};

// ─── pure activity body ────────────────────────────────────────────────────────────────────────────

/**
 * Post the placeholder issue comment (best-effort, never raises). 1:1 with the frozen Python
 * `post_review_placeholder_activity` body (sans the flag check + the not-configured guard — both handled
 * by the wrapper):
 *
 *   1. List existing PR issue comments; if one already carries our marker → skip the POST (Temporal-retry
 *      idempotency). A list failure is logged + swallowed (return without posting).
 *   2. POST a placeholder issue comment with the body template. A post failure is logged + swallowed.
 *   3. Emit the `REVIEW_PLACEHOLDER_POSTED` audit event. The POST already succeeded; a flaky audit emit
 *      loses a dashboard event but the placeholder is on GitHub → swallowed.
 */
export async function doPostPlaceholder(
  req: PostReviewPlaceholderInput,
  deps: PostPlaceholderDeps,
): Promise<void> {
  const marker = markerForPlaceholder(req.pr_id);

  // Idempotency: if a placeholder with this marker already exists, skip the POST. Covers (a) a Temporal
  // retry of this activity and (b) a re-trigger workflow run on the same PR.
  let existing: Array<Record<string, unknown>>;
  try {
    existing = await deps.ghClient.listIssueComments({
      owner: req.owner,
      repo: req.repo_name,
      prNumber: req.pr_number,
    });
  } catch (e) {
    console.warn(
      `post_review_placeholder.list_failed pr_id=${req.pr_id} pr_number=${req.pr_number} ` +
        `error=${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  for (const comment of existing) {
    const body = comment["body"];
    if (typeof body === "string" && body.includes(marker)) {
      console.info(
        `post_review_placeholder.skipped_existing pr_id=${req.pr_id} comment_id=${String(comment["id"])}`,
      );
      return;
    }
  }

  // POST the placeholder issue comment.
  let commentId: number;
  try {
    commentId = await deps.ghClient.createIssueComment({
      owner: req.owner,
      repo: req.repo_name,
      prNumber: req.pr_number,
      body: placeholderBody(req.pr_id),
    });
  } catch (e) {
    console.warn(
      `post_review_placeholder.post_failed pr_id=${req.pr_id} pr_number=${req.pr_number} ` +
        `error=${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Audit emit. The POST already succeeded; a flaky audit emit here loses a dashboard event but the
  // placeholder is on GitHub.
  try {
    await deps.emitEvent({
      runId: req.run_id,
      reviewId: req.review_id,
      installationId: req.installation_id,
      prId: req.pr_id,
      prNumber: req.pr_number,
      githubCommentId: commentId,
    });
  } catch (e) {
    console.warn(
      `post_review_placeholder.audit_emit_failed pr_id=${req.pr_id} comment_id=${commentId} ` +
        `error=${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ─── production audit-emit closure ──────────────────────────────────────────────────────────────────

/**
 * Build the production {@link PlaceholderAuditEmit}: open ONE transaction over the ADR-0062 shared pool
 * for `dsn` and emit `REVIEW_PLACEHOLDER_POSTED` inside it (the caller owns no outer transaction — the
 * placeholder audit row stands alone). 1:1 with the Python `async with session_factory() as session,
 * session.begin(): await emit_workflow_event(...)` block.
 */
export function makePlaceholderAuditEmit(dsn: string, clock: Clock): PlaceholderAuditEmit {
  const db = tenantKysely<unknown>(dsn);
  return async (args): Promise<void> => {
    await db.transaction().execute(async (tx: Transaction<unknown>) => {
      await emitWorkflowEvent({
        dbOrTx: tx,
        provider: "github",
        runId: args.runId,
        reviewId: args.reviewId,
        eventType: "REVIEW_PLACEHOLDER_POSTED",
        payload: {
          pr_id: args.prId,
          pr_number: args.prNumber,
          github_comment_id: args.githubCommentId,
        },
        installationId: args.installationId,
        clock,
      });
    });
  };
}

// ─── Temporal activity entry point ───────────────────────────────────────────────────────────────────

/**
 * Read the feature flag. `CODEMASTER_REVIEW_PLACEHOLDER_ENABLED === "1"` enables; ANY other value
 * (including unset) disables — fail-safe default OFF, 1:1 with the Python `os.getenv(...) != "1"`. Static
 * `process.env.X` access (no dynamic indexing) so no object-injection sink is introduced.
 */
function placeholderEnabled(): boolean {
  return process.env.CODEMASTER_REVIEW_PLACEHOLDER_ENABLED === "1";
}

/**
 * The registered `post_review_placeholder` Temporal activity (single typed-input envelope per CLAUDE.md
 * invariant 11). Reads the feature flag (returns early when disabled); resolves the DSN from
 * `CODEMASTER_PG_CORE_DSN` + the numeric GitHub installation id from `CODEMASTER_GITHUB_INSTALLATION_ID`;
 * constructs the production {@link GitHubApiReviewClient} (Vault token provider → GitHubApiClient → wrapped
 * client) — the SAME wiring the `post_review_results` activity uses — and delegates to
 * {@link doPostPlaceholder} with the production audit-emit closure. Mirrors the frozen Python
 * `post_review_placeholder_activity`. NEVER raises (best-effort): even the env-resolution faults are
 * swallowed so a misconfigured pod cannot fail the review pipeline.
 */
export async function postReviewPlaceholder(input: PostReviewPlaceholderInput): Promise<void> {
  if (!placeholderEnabled()) {
    console.debug("post_review_placeholder: flag disabled; skipping");
    return;
  }

  const parsed = PostReviewPlaceholderInput.parse(input);

  let deps: PostPlaceholderDeps;
  try {
    const dsn = process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error("CODEMASTER_PG_CORE_DSN is not set");
    }
    const installationId = readGithubInstallationId();
    const clock = new WallClock();
    const githubHttp = new FetchGitHubHttpClient({});
    const vault = VaultHttpPort.fromEnv();
    const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
    const api = new GitHubApiClient({
      tokenProvider: tokenProvider.getToken.bind(tokenProvider),
      http: githubHttp,
      clock,
    });
    const ghClient = new GitHubApiReviewClient({ api, installationId });
    deps = { ghClient, emitEvent: makePlaceholderAuditEmit(dsn, clock) };
  } catch (e) {
    // Programmer/operator error (missing env, Vault unreachable at construction) — surfaced for
    // visibility but NEVER fails the review pipeline (the analogue of the Python not-configured swallow).
    console.warn(
      `post_review_placeholder.not_configured pr_id=${parsed.pr_id} ` +
        `error=${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  await doPostPlaceholder(parsed, deps);
}

/**
 * Read + validate `CODEMASTER_GITHUB_INSTALLATION_ID` (the numeric GitHub App installation id this pod
 * authenticates as). 1:1 with the sibling `post_review_results.activity.ts::readGithubInstallationId`.
 * Static `process.env.X` access (no dynamic indexing) so no object-injection sink is introduced.
 */
function readGithubInstallationId(): number {
  const raw = process.env.CODEMASTER_GITHUB_INSTALLATION_ID;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "CODEMASTER_GITHUB_INSTALLATION_ID env var is required for the post_review_placeholder activity. " +
        "Set it to the numeric GitHub App installation id this pod authenticates as.",
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(
      `CODEMASTER_GITHUB_INSTALLATION_ID must be an integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (value <= 0) {
    throw new Error(`CODEMASTER_GITHUB_INSTALLATION_ID must be >= 1; got ${value}`);
  }
  return value;
}
