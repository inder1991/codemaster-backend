/**
 * `delete_review_placeholder` activity — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/delete_review_placeholder.py` (Phase 1 PR-1c).
 *
 * Tears down the PR conversation-tab placeholder comment posted by `post_review_placeholder` after the
 * heavy `post_review_results_activity` has successfully landed the real review. The placeholder vanishes
 * from the PR conversation tab, leaving the developer with just the real review.
 *
 * ## Strategy (1:1 with the Python)
 *
 *   1. List the PR's issue comments.
 *   2. Filter for any comment whose body contains the placeholder marker
 *      (`<!-- codemaster:placeholder-marker:{pr_id} -->`).
 *   3. DELETE each matching comment via `DELETE /repos/{owner}/{repo}/issues/comments/{id}`.
 *   4. Emit a `REVIEW_PLACEHOLDER_DELETED` audit event for each deletion.
 *
 * ## Best-effort (CLAUDE.md core-loop discipline)
 *
 * All GitHub I/O failures are logged at WARNING and SWALLOWED. The cleanup is a UX nicety; an orphaned
 * placeholder is strictly worse than no placeholder but better than a failed review pipeline. A 404 on
 * DELETE ({@link GitHubNotFoundError}) is treated as success — the comment was already removed by an
 * earlier retry or a human. The activity NEVER raises.
 *
 * ## Idempotency
 *
 * Stateless marker-based filtering: re-running after a successful delete sees zero matching comments and
 * no-ops. A Temporal retry between a prior POST and its audit-emit can leave MULTIPLE matching comments;
 * the cleanup deletes EVERY match to avoid orphans (a delete failure on one match is logged + swallowed,
 * then the loop continues to the next).
 *
 * ## No feature flag of its own
 *
 * Unlike the placeholder POST, the cleanup has NO feature flag. It is invoked unconditionally from the
 * workflow body; if no placeholder was posted (the POST flag was OFF on the workflow that ran), no marker
 * matches and the activity no-ops. 1:1 with the Python.
 *
 * ## Marker duplication (deliberate)
 *
 * {@link markerForDeletePlaceholder} is byte-identical to `post_review_placeholder::markerForPlaceholder`
 * but DUPLICATED here (rather than imported) so the cleanup does not pull a dependency on the placeholder
 * module's import graph — 1:1 with the Python `_marker_for` duplication. The marker string is the contract
 * between the two activities; the marker-lockstep unit test pins them so neither can drift.
 *
 * ## DI idiom
 *
 * Same as the placeholder POST: a pure inner {@link doDeletePlaceholder} taking injected deps + a thin
 * Temporal wrapper {@link deleteReviewPlaceholder} constructing the production GitHub client + audit-emit
 * closure. The Python module-level `configure` / `_require_configured` has no analogue (the wrapper builds
 * deps unconditionally).
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

import { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";

// ─── marker (duplicated from post_review_placeholder by design) ──────────────────────────────────────

/**
 * Mirror of `post_review_placeholder::markerForPlaceholder`. Duplicated (not imported) so the cleanup
 * activity does not pull the placeholder module's import graph. The marker-lockstep unit test pins them.
 * 1:1 with the Python `delete_review_placeholder._marker_for`.
 */
export function markerForDeletePlaceholder(prId: string): string {
  return `<!-- codemaster:placeholder-marker:${prId} -->`;
}

// ─── injected collaborators ───────────────────────────────────────────────────────────────────────

/**
 * The minimal issue-comment GitHub surface the cleanup depends on — a structural subset of
 * {@link GhReviewClient}, so the production `GitHubApiReviewClient` satisfies it and a unit-test stub need
 * only implement these two methods. 1:1 with the Python `GhIssueCommentClient` Protocol (list + delete).
 */
export type GhIssueCommentDeleteClient = {
  listIssueComments(args: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;
  deleteIssueComment(args: { owner: string; repo: string; commentId: number }): Promise<void>;
};

/**
 * Best-effort audit-emit callback: writes one `REVIEW_PLACEHOLDER_DELETED` workflow event per deletion.
 * 1:1 in role with the per-deletion `emit_workflow_event(...)` call in the Python loop body.
 */
export type DeletePlaceholderAuditEmit = (args: {
  runId: string;
  reviewId: string;
  installationId: string;
  prId: string;
  prNumber: number;
  githubCommentId: number;
}) => Promise<void>;

/** Injected collaborators for {@link doDeletePlaceholder}. Both REQUIRED (the wrapper builds production ones). */
export type DeletePlaceholderDeps = {
  ghClient: GhIssueCommentDeleteClient;
  emitEvent: DeletePlaceholderAuditEmit;
};

// ─── pure activity body ────────────────────────────────────────────────────────────────────────────

/**
 * Delete the placeholder issue comment(s) (best-effort, never raises). 1:1 with the frozen Python
 * `delete_review_placeholder_activity` body (sans the not-configured guard — handled by the wrapper):
 *
 *   1. List PR issue comments. A list failure is logged + swallowed (return without deleting).
 *   2. Collect every comment whose body contains the placeholder marker (skipping null/empty bodies).
 *   3. No matches → no-op (debug log). Otherwise, for EACH matching id:
 *      a. DELETE the comment. A 404 (already gone) or any other error is logged + swallowed; the loop
 *         CONTINUES to the next matching id (a failure on one delete must not skip the rest).
 *      b. Emit `REVIEW_PLACEHOLDER_DELETED`. A flaky audit emit is logged + swallowed.
 */
export async function doDeletePlaceholder(
  req: DeleteReviewPlaceholderInput,
  deps: DeletePlaceholderDeps,
): Promise<void> {
  const marker = markerForDeletePlaceholder(req.pr_id);

  let comments: Array<Record<string, unknown>>;
  try {
    comments = await deps.ghClient.listIssueComments({
      owner: req.owner,
      repo: req.repo_name,
      prNumber: req.pr_number,
    });
  } catch (e) {
    console.warn(
      `delete_review_placeholder.list_failed pr_id=${req.pr_id} pr_number=${req.pr_number} ` +
        `error=${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Defensive: a Temporal retry between a prior POST and audit-emit can leave multiple matching comments;
  // delete every match to avoid orphans. Skip null/empty bodies (GitHub returns null bodies sometimes).
  const matchingIds: Array<number> = [];
  for (const comment of comments) {
    const body = comment["body"];
    const cid = comment["id"];
    if (typeof body === "string" && body.includes(marker) && cid !== undefined && cid !== null) {
      matchingIds.push(Number(cid));
    }
  }

  if (matchingIds.length === 0) {
    console.debug(
      `delete_review_placeholder.no_marker_match pr_id=${req.pr_id} pr_number=${req.pr_number}`,
    );
    return;
  }

  for (const commentId of matchingIds) {
    try {
      await deps.ghClient.deleteIssueComment({
        owner: req.owner,
        repo: req.repo_name,
        commentId,
      });
    } catch (e) {
      // GitHubNotFoundError on 404 (comment already gone) is a success from our perspective; other
      // 4xx/5xx are logged + we move on to the next matching id.
      console.warn(
        `delete_review_placeholder.delete_failed pr_id=${req.pr_id} comment_id=${commentId} ` +
          `error=${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

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
        `delete_review_placeholder.audit_emit_failed pr_id=${req.pr_id} comment_id=${commentId} ` +
          `error=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

// ─── production audit-emit closure ──────────────────────────────────────────────────────────────────

/**
 * Build the production {@link DeletePlaceholderAuditEmit}: open ONE transaction over the ADR-0062 shared
 * pool for `dsn` per deletion and emit `REVIEW_PLACEHOLDER_DELETED` inside it. 1:1 with the Python `async
 * with session_factory() as session, session.begin(): await emit_workflow_event(...)` per-deletion block.
 */
export function makeDeletePlaceholderAuditEmit(dsn: string, clock: Clock): DeletePlaceholderAuditEmit {
  const db = tenantKysely<unknown>(dsn);
  return async (args): Promise<void> => {
    await db.transaction().execute(async (tx: Transaction<unknown>) => {
      await emitWorkflowEvent({
        dbOrTx: tx,
        provider: "github",
        runId: args.runId,
        reviewId: args.reviewId,
        eventType: "REVIEW_PLACEHOLDER_DELETED",
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
 * The registered `delete_review_placeholder` Temporal activity (single typed-input envelope per CLAUDE.md
 * invariant 11). Resolves the DSN + numeric GitHub installation id from env; constructs the production
 * {@link GitHubApiReviewClient} (Vault token provider → GitHubApiClient → wrapped client) — the SAME
 * wiring `post_review_results` uses — and delegates to {@link doDeletePlaceholder} with the production
 * audit-emit closure. Mirrors the frozen Python `delete_review_placeholder_activity`. NEVER raises
 * (best-effort): even env-resolution faults are swallowed so a misconfigured pod cannot fail the pipeline.
 */
export async function deleteReviewPlaceholder(input: DeleteReviewPlaceholderInput): Promise<void> {
  const parsed = DeleteReviewPlaceholderInput.parse(input);

  let deps: DeletePlaceholderDeps;
  try {
    const dsn = process.env.CODEMASTER_PG_CORE_DSN;
    if (dsn === undefined || dsn === "") {
      throw new Error("CODEMASTER_PG_CORE_DSN is not set");
    }
    // Per-review routing: the numeric installation id comes from the input. A null id is caught by the
    // surrounding try → logged "not_configured" → the cleanup is skipped (best-effort, non-fatal).
    const installationId = parsed.github_installation_id;
    if (installationId === null) {
      throw new Error("github_installation_id is null in the delete_review_placeholder input (per-review routing)");
    }
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
    deps = { ghClient, emitEvent: makeDeletePlaceholderAuditEmit(dsn, clock) };
  } catch (e) {
    console.warn(
      `delete_review_placeholder.not_configured pr_id=${parsed.pr_id} ` +
        `error=${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  await doDeletePlaceholder(parsed, deps);
}
