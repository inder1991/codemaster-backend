/**
 * `fetchSuggestedReviewers` activity — 1:1 port of the frozen Python
 * `codemaster/activities/fetch_suggested_reviewers.py::FetchSuggestedReviewersActivity.fetch_suggested_reviewers`
 * (S23.AR.3 / B5 producer).
 *
 * Resolves the top-N CODEOWNERS-derived reviewer logins for a PR's changed files. The walkthrough's
 * "Suggested reviewers" section reads this output.
 *
 * Flow per invocation (ported exactly):
 *   1. Flag check on `code_owners_v1` (the injected `isEnabled`). Disabled → return `[]` without I/O.
 *   2. SELECT changed file paths for the PR from `core.pr_files`.
 *   3. SELECT CODEOWNERS rules for the repository from `core.code_owners`.
 *   4. Call {@link rankSuggestedReviewers} — ranks by file-match count DESC, alpha-sorted login ASC,
 *      truncates to top-N (default 3).
 *   5. Return the array of escaped logins (already markdown-safe).
 *
 * Empty-output cases (return `[]` cleanly): flag off; no PR files; no CODEOWNERS rules; no rule matches.
 *
 * Fail-open (per the task contract + ADR-0026 § 2): this activity makes NO GitHub call (it is pure DB +
 * ranking), so a `GitHubAppUnauthorized` cannot arise here. Any DB error surfaces to the workflow body,
 * whose try/except converts it to a "skipped" degradation note on the `fetch_suggested_reviewers` stage
 * → the renderer drops the section. That workflow wrapper is wired in the Workflow phase (NOT here).
 *
 * Typed-input envelope (CLAUDE.md invariant 11 / ADR-0047): the frozen Python dispatches with THREE
 * positional arguments; this port CLOSES that violation — the single positional input is the
 * {@link FetchSuggestedReviewersInputV1} envelope.
 */

import type { CodeOwnerRule } from "#backend/domain/repos/code_owners_repo.js";
import type { PrFilesRepoPort } from "#backend/domain/repos/pr_files_repo.js";
import { DEFAULT_TOP_N, rankSuggestedReviewers } from "#backend/llm/walkthrough_sections/suggested_reviewers.js";

import type { Clock } from "#platform/clock.js";

import type { FetchSuggestedReviewersInputV1 } from "#contracts/fetch_suggested_reviewers_input.v1.js";

/**
 * The CODEOWNERS-rules read slice the activity consumes (1:1 with the Python `CodeOwnersListPort`). The
 * concrete {@link PostgresCodeOwnersRepo} satisfies this shape — the activity depends on this narrow
 * surface, not the whole repo. The `CodeOwnerRule` shape is the parser's output type (path_pattern +
 * owner_logins drive the ranker), not the wire envelope.
 */
export type CodeOwnersListPort = {
  listRulesForRepository(args: {
    installationId: string;
    repositoryId: string;
  }): Promise<ReadonlyArray<CodeOwnerRule>>;
};

/** An async feature-flag check (1:1 with the Python `Callable[[], Awaitable[bool]]`). */
export type IsEnabled = () => Promise<boolean>;

/** Bound-method holder for `fetchSuggestedReviewers` (1:1 with `FetchSuggestedReviewersActivity`). */
export class FetchSuggestedReviewersActivity {
  readonly #prFilesRepo: PrFilesRepoPort;
  readonly #codeOwnersRepo: CodeOwnersListPort;
  readonly #isEnabled: IsEnabled;
  // The injected clock is part of the Python constructor's dependency set; retained for parity even
  // though the read path does no time math (the renderer-wiring sprint may surface a use).
  readonly #clock: Clock;
  readonly #topN: number;

  public constructor(args: {
    prFilesRepo: PrFilesRepoPort;
    codeOwnersRepo: CodeOwnersListPort;
    isEnabled: IsEnabled;
    clock: Clock;
    topN?: number;
  }) {
    this.#prFilesRepo = args.prFilesRepo;
    this.#codeOwnersRepo = args.codeOwnersRepo;
    this.#isEnabled = args.isEnabled;
    this.#clock = args.clock;
    this.#topN = args.topN ?? DEFAULT_TOP_N;
  }

  /**
   * Build the walkthrough's `suggested_reviewers` envelope. Returns the top-N reviewer logins
   * (markdown-escaped, no `@`); empty array in any of the empty-output cases. 1:1 with the Python
   * `fetch_suggested_reviewers`.
   */
  public async fetchSuggestedReviewers(input: FetchSuggestedReviewersInputV1): Promise<Array<string>> {
    if (!(await this.#isEnabled())) {
      return [];
    }

    // Step 1 — read changed file paths from core.pr_files.
    const filePaths = await this.#prFilesRepo.listFilePathsForPr({
      installationId: input.installation_id,
      prId: input.pr_id,
    });
    if (filePaths.length === 0) {
      return [];
    }

    // Step 2 — read CODEOWNERS rules from core.code_owners.
    const rules = await this.#codeOwnersRepo.listRulesForRepository({
      installationId: input.installation_id,
      repositoryId: input.repository_id,
    });
    if (rules.length === 0) {
      return [];
    }

    // Step 3 — pure-function ranking. The ranker handles dedup, markdown escaping, and the top-N cap.
    return rankSuggestedReviewers({
      prFiles: filePaths,
      rules,
      topN: this.#topN,
    });
  }

  /** Exposed for parity with the Python constructor's clock dependency (kept reachable). */
  public clock(): Clock {
    return this.#clock;
  }
}
