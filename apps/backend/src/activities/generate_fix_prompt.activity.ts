/**
 * `generateFixPrompt` activity — 1:1 in intent with the frozen Python
 * `@activity.defn generate_fix_prompt_activity`
 * (`vendor/codemaster-py/codemaster/review/fix_prompt_theme_activity.py::FixPromptActivities.generate_fix_prompt_activity`).
 *
 * Builds a copy-pasteable Claude-Code fix prompt from the aggregated findings — a DETERMINISTIC primary
 * section (`buildFixPromptDeterministic`) PLUS an ADDITIVE best-effort LLM theme-synthesis (the
 * `## Cross-cutting patterns` section); on any LLM failure the deterministic section still ships. Persists
 * the prompt via the ported `FixPromptRepo` and posts it as an advisory PR conversation-tab comment.
 *
 * ## Bound-method holder (mirrors WalkthroughActivities)
 *
 * The frozen Python is a class `FixPromptActivities(cache, repo, gh_client, clock)` with an `@activity.defn`
 * method. This port mirrors that: a {@link FixPromptActivities} class holding the injected collaborators,
 * exposing `generateFixPrompt` as an arrow property so it stays bound when the worker bootstrap destructures
 * it into the activities map (Temporal registers the function value directly, losing `this`). The Workflow
 * phase wires the construction in `build_activities.ts` (NOT this file — HARD RULE).
 *
 * ## Single typed input — CLAUDE.md invariant 11 / ADR-0047
 *
 * The single positional input is a {@link GenerateFixPromptInputV1} envelope (review identity + tenant + PR
 * coordinates + the aggregated findings). The Temporal DataConverter validates it through the Zod contract
 * on the wire, so the body never re-validates a raw dict.
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The LLM client, the
 * `pg.Pool` the repo opens (ADR-0062 shared seam), the GitHub HTTP client, and the wall clock all live
 * here, exactly like `generateWalkthrough`.
 *
 * ## Fail-open posture (1:1 with the Python)
 *
 *   - Empty findings → short-circuit, return `{ generated: false, generation_mode: "", comment_posted: false }`.
 *   - The LLM theme-synthesis is best-effort INSIDE `buildFixPrompt` (degrades to the deterministic base).
 *   - The PR comment POST is best-effort: a post failure is caught and `comment_posted=false` is returned;
 *     the review is NEVER failed (the persisted record still serves the API/UI). The comment is RENDERED
 *     before the try so a render bug propagates rather than masquerading as a GitHub-post failure.
 */

import { type Clock } from "#platform/clock.js";

import type { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { recordFixPromptGenerated } from "#backend/observability/fix_prompt_metrics.js";
import {
  type LlmClientCacheLike,
  buildFixPrompt,
  renderFixPromptComment,
} from "#backend/review/fix_prompt/fix_prompt_theme_activity.js";

import { FixPromptActivityResultV1 } from "#contracts/fix_prompt_activity_result.v1.js";
import type { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";

/**
 * The GitHub issue-comment surface the activity needs — the slice of `GhReviewClient` it uses
 * (`createIssueComment` only). Kept loosely-typed (structural subset) so the activity depends only on the
 * one method, mirroring how the Python keeps `gh_client` loosely typed to avoid import weight.
 */
export type FixPromptIssueCommentClient = {
  createIssueComment(args: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;
};

/**
 * Bound-method holder for the generate_fix_prompt activity — 1:1 with the frozen Python
 * `FixPromptActivities(cache=…, repo=…, gh_client=…, clock=…)`. The worker bootstrap constructs it with
 * the shared ledger-wired {@link LlmClientCacheLike} (the fix_prompt purpose resolves to sonnet via the
 * central seed), the ported {@link FixPromptRepo}, the installation-bound issue-comment client, and the
 * shared clock; it registers the `generateFixPrompt` bound arrow property.
 */
export class FixPromptActivities {
  private readonly cache: LlmClientCacheLike;
  private readonly repo: FixPromptRepo;
  private readonly gh: FixPromptIssueCommentClient;
  private readonly clock: Clock;

  public constructor(args: {
    cache: LlmClientCacheLike;
    repo: FixPromptRepo;
    gh: FixPromptIssueCommentClient;
    clock: Clock;
  }) {
    this.cache = args.cache;
    this.repo = args.repo;
    this.gh = args.gh;
    this.clock = args.clock;
  }

  /**
   * The activity. 1:1 with the Python `generate_fix_prompt_activity`. Arrow property so it stays bound
   * when destructured into the worker activities map.
   */
  public readonly generateFixPrompt = async (
    payload: GenerateFixPromptInputV1,
  ): Promise<FixPromptActivityResultV1> => {
    // No findings → nothing to build. Short-circuit with the not-generated result (empty generation_mode).
    if (payload.aggregated.findings.length === 0) {
      return FixPromptActivityResultV1.parse({
        generated: false,
        generation_mode: "",
        comment_posted: false,
      });
    }

    const record = await buildFixPrompt({
      reviewId: payload.review_id,
      aggregated: payload.aggregated,
      prNumber: payload.pr_number,
      // TS hardening divergence (ADR-0068) — thread the REAL installation_id to the LLM client (cost-cap /
      // blob / telemetry). The Python platform-scopes the fix_prompt call (omits it).
      installationId: payload.installation_id,
      cache: this.cache,
      clock: this.clock,
    });

    await this.repo.persist(record, { installationId: payload.installation_id });
    recordFixPromptGenerated({
      generationMode: record.generation_mode,
      truncated: record.truncated,
    });

    // Render BEFORE the try so a render bug propagates rather than masquerading as a GitHub-post failure;
    // the post itself stays best-effort.
    const commentBody = renderFixPromptComment(record.prompt);
    let posted = false;
    try {
      await this.gh.createIssueComment({
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
        body: commentBody,
      });
      posted = true;
    } catch {
      // Advisory post; never fail the review. The persisted record still serves the API/UI. 1:1 with the
      // Python bare `except Exception:` (which warns + continues; the WARN log is an off-observable side-effect).
    }

    return FixPromptActivityResultV1.parse({
      generated: true,
      generation_mode: record.generation_mode,
      comment_posted: posted,
    });
  };
}
