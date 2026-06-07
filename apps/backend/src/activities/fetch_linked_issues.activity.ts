/**
 * `fetchLinkedIssues` activity — 1:1 port of the frozen Python
 * `codemaster/activities/fetch_linked_issues.py::FetchLinkedIssuesActivity.fetch_linked_issues`
 * (DM-WIRE T4 / S22.DM.16).
 *
 * Resolves the PR's linked-issues envelope: reads parsed `(github_issue_number, linkage_kind, source)`
 * link rows from `core.pr_issue_links`, layers a `(title, state)` cache (`core.github_issues_cache`) +
 * ETag-aware GitHub refresh on top, and returns `Array<LinkedIssueV1>` ready for the walkthrough
 * envelope. Per ADR-0026 § 3 the assembly happens INSIDE the activity so the workflow body only carries
 * the final contract type across the Temporal payload boundary.
 *
 * Flow per invocation (ported exactly):
 *   1. SELECT issue link rows from `core.pr_issue_links` for the PR.
 *   2. Distinct, ASC-sorted issue numbers; cap at MAX_ISSUES_PER_INVOCATION (the remainder surface as
 *      (null, null) in the resolver → "(title unavailable)").
 *   3. Bulk SELECT cache entries from `core.github_issues_cache`.
 *   4. Fresh cache hit (< CACHE_TTL_SECONDS) → use cached body, skip GitHub.
 *   5. Stale hit / miss → ETag-aware GET. 304 → refresh cached_at, keep body. 200 → upsert + new ETag.
 *      404 / other 4xx / failure → (null, null). 403 → trip the circuit breaker (rate-limit guard).
 *   6. After MAX_CONSECUTIVE_FAILURES consecutive non-success responses → trip the circuit breaker; every
 *      remaining issue short-circuits to (null, null).
 *   7. Assemble the final `Array<LinkedIssueV1>` via {@link assembleLinkedIssues} (owns dedup +
 *      linkage-kind ordering).
 *
 * Fail-open (per the task contract + ADR-0026 § 2): the per-issue GitHub call is wrapped in
 * {@link FetchLinkedIssuesActivity._safeFetch} which traps ALL errors (incl. `GitHubAppUnauthorized`)
 * and degrades to `(null, null, 0)`; an issue that can't resolve simply renders "(title unavailable)".
 * Any uncaught error in the outer flow surfaces to the workflow body, whose try/except converts it to a
 * "skipped" degradation note on the `fetch_linked_issues` stage — that workflow wrapper is wired in the
 * Workflow phase (NOT here).
 *
 * Replay-safety / runtime context: activities run in the NORMAL Node runtime (NOT the workflow
 * sandbox), so the GitHub API / DB I/O is permitted. ALL timing (the cache-TTL age math) flows through
 * the injected {@link Clock}; there is no `Date.now()` here.
 *
 * Typed-input envelope (CLAUDE.md invariant 11 / ADR-0047): the frozen Python dispatches with SIX
 * positional arguments; this port CLOSES that violation — the single positional input is the
 * {@link FetchLinkedIssuesInputV1} envelope.
 */

import { assembleLinkedIssues, type TitleStateEntry } from "#backend/llm/walkthrough_sections/linked_issues.js";
import type { GithubIssuesCacheRepoPort } from "#backend/domain/repos/github_issues_cache_repo.js";
import type { LinkedIssuesPort } from "#backend/domain/repos/pr_issue_links_repo.js";

import type { Clock } from "#platform/clock.js";

import type { FetchLinkedIssuesInputV1 } from "#contracts/fetch_linked_issues_input.v1.js";
import type { LinkedIssueV1 } from "#contracts/walkthrough.v1.js";

/**
 * TTL after which a cache entry is considered stale enough to attempt an ETag-aware refresh. 5 minutes
 * (1:1 with the Python `CACHE_TTL_SECONDS`).
 */
export const CACHE_TTL_SECONDS = 5 * 60;

/** HTTP status sentinels exposed by `getIssue` (mirroring the Python `_HTTP_*` finals). */
const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;
const HTTP_RATE_LIMITED = 403;

/**
 * Circuit-breaker: after N consecutive non-success responses, skip remaining issue lookups in the same
 * activity invocation. 1:1 with the Python `MAX_CONSECUTIVE_FAILURES`.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Hard cap on issues fetched per invocation. 1:1 with the Python `MAX_ISSUES_PER_INVOCATION`. */
export const MAX_ISSUES_PER_INVOCATION = 50;

/**
 * The GitHub-API slice the activity consumes. Returns `[payload, etag, status]`. The concrete
 * {@link GitHubIssueClient} satisfies this shape verbatim (its `getIssue` is structurally compatible).
 * 1:1 with the Python `GithubIssuePort`.
 */
export type GithubIssuePort = {
  getIssue(args: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    ifNoneMatch?: string | null;
  }): Promise<readonly [Record<string, unknown> | null, string | null, number]>;
};

/** Bound-method holder for `fetchLinkedIssues` (1:1 with the Python `FetchLinkedIssuesActivity`). */
export class FetchLinkedIssuesActivity {
  readonly #linksRepo: LinkedIssuesPort;
  readonly #cacheRepo: GithubIssuesCacheRepoPort;
  readonly #github: GithubIssuePort;
  readonly #clock: Clock;

  public constructor(args: {
    linksRepo: LinkedIssuesPort;
    cacheRepo: GithubIssuesCacheRepoPort;
    github: GithubIssuePort;
    clock: Clock;
  }) {
    this.#linksRepo = args.linksRepo;
    this.#cacheRepo = args.cacheRepo;
    this.#github = args.github;
    this.#clock = args.clock;
  }

  /**
   * Build the walkthrough's `linked_issues` envelope. Returns an empty array when the PR has no parsed
   * links, or all rows produced no resolvable titles. 1:1 with the Python `fetch_linked_issues`.
   */
  public async fetchLinkedIssues(input: FetchLinkedIssuesInputV1): Promise<Array<LinkedIssueV1>> {
    // Step 1 — read pr_issue_links rows (full link triples).
    const links = await this.#linksRepo.listLinksForPr({
      installationId: input.installation_id_uuid,
      prId: input.pr_id,
    });
    if (links.length === 0) {
      return [];
    }

    // Distinct, ASC-sorted issue numbers for the cache fetch.
    const allIssueNumbers = [...new Set(links.map((l) => l.github_issue_number))].sort((a, b) => a - b);

    // Cap per-invocation issue count (rate-limit guard). The first MAX_ISSUES_PER_INVOCATION ASC-sorted
    // are kept; the remainder surface as (null, null) → "(title unavailable)".
    const issueNumbers =
      allIssueNumbers.length > MAX_ISSUES_PER_INVOCATION
        ? allIssueNumbers.slice(0, MAX_ISSUES_PER_INVOCATION)
        : allIssueNumbers;

    // Step 2 — bulk SELECT cache entries.
    const cached = await this.#cacheRepo.getMany({
      installationId: input.installation_id_uuid,
      issueNumbers,
    });

    const now = this.#clock.now();
    const resolver = new Map<number, TitleStateEntry>();
    let consecutiveFailures = 0;
    let circuitOpen = false;

    for (const issueNumber of issueNumbers) {
      const entry = cached.get(issueNumber);
      if (entry !== undefined) {
        const ageSeconds = (now.getTime() - entry.cached_at.getTime()) / 1000;
        if (ageSeconds < CACHE_TTL_SECONDS) {
          // Fresh hit — use cached values; no GitHub call.
          resolver.set(issueNumber, [entry.title, entry.state]);
          continue;
        }
      }

      // Circuit breaker — once tripped, every remaining issue short-circuits to (null, null). A stale
      // cache entry (if any) is NOT used to mask the failure; consumers see absence.
      if (circuitOpen) {
        resolver.set(issueNumber, [null, null]);
        continue;
      }

      // Either cache miss or stale entry — attempt an ETag-aware GitHub fetch.
      const [payload, etag, status] = await this.safeFetch({
        installationId: input.installation_id_int,
        owner: input.owner,
        repo: input.repo,
        issueNumber,
        ifNoneMatch: entry !== undefined ? entry.etag : null,
      });

      // Rate-limit signal: GitHub returns 403 for both primary and secondary rate-limit hits. Bail out
      // immediately — the next call would just stack more 403s.
      if (status === HTTP_RATE_LIMITED) {
        circuitOpen = true;
        resolver.set(issueNumber, [null, null]);
        continue;
      }

      if (status === HTTP_NOT_MODIFIED && entry !== undefined) {
        // ETag still valid — refresh cached_at, keep body.
        await this.#cacheRepo.upsert({
          installationId: input.installation_id_uuid,
          repositoryId: input.repository_id,
          githubIssueNumber: issueNumber,
          title: entry.title,
          body: entry.body,
          state: entry.state,
          etag: entry.etag,
        });
        resolver.set(issueNumber, [entry.title, entry.state]);
        consecutiveFailures = 0;
        continue;
      }

      if (status === HTTP_OK && payload !== null) {
        // Fresh body — upsert + populate resolver.
        const title = extractTitle(payload);
        const bodyText = extractBody(payload);
        const state = extractState(payload);
        await this.#cacheRepo.upsert({
          installationId: input.installation_id_uuid,
          repositoryId: input.repository_id,
          githubIssueNumber: issueNumber,
          title,
          body: bodyText,
          state,
          etag,
        });
        resolver.set(issueNumber, [title, state]);
        consecutiveFailures = 0;
        continue;
      }

      // 404 / 4xx / network failure — fall through to (null, null). A stale cache entry (if any) is NOT
      // used to mask the failure; consumers see the absence explicitly. Bump the consecutive-failure
      // counter; trip the breaker once we cross the threshold.
      resolver.set(issueNumber, [null, null]);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        circuitOpen = true;
      }
    }

    // Step 7 — assemble the final envelope. The assembler owns dedup-by-issue-number + linkage-kind
    // ordering, so the activity's only contribution is the resolver Map.
    return assembleLinkedIssues({ parsed: links, titleResolver: resolver });
  }

  /**
   * Wrap the GitHub-API call in a broad error trap. Failures degrade to `[null, null, 0]` per the
   * fail-mode contract (1:1 with the Python `_safe_fetch`).
   *
   * Note: the Python wraps the call in `asyncio.wait_for(2.0s)`; the TS `GitHubIssueClient` enforces
   * its transport timeout via the injected `FetchGitHubHttpClient` AbortSignal seam, so the per-call
   * wall-clock bound lives in the transport rather than a clock-driven race here. The error-trap
   * fail-open semantics are identical.
   */
  private async safeFetch(args: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    ifNoneMatch: string | null;
  }): Promise<readonly [Record<string, unknown> | null, string | null, number]> {
    try {
      return await this.#github.getIssue({
        installationId: args.installationId,
        owner: args.owner,
        repo: args.repo,
        issueNumber: args.issueNumber,
        ifNoneMatch: args.ifNoneMatch,
      });
    } catch {
      // Any error (incl. GitHubAppUnauthorized) degrades to (null, null, 0) — fail-open per issue.
      return [null, null, 0];
    }
  }
}

/** Extract + bound the issue title (1:1 with the Python `_extract_title`). */
function extractTitle(payload: Record<string, unknown>): string {
  const title = payload["title"];
  return typeof title === "string" ? title.slice(0, 500) : "";
}

/** Extract the issue body, null when absent/non-string (1:1 with the Python `_extract_body`). */
function extractBody(payload: Record<string, unknown>): string | null {
  const body = payload["body"];
  return typeof body === "string" ? body : null;
}

/**
 * Extract the issue state, mapping anything other than "open" to "closed" (1:1 with the Python
 * `_extract_state` — soft-deleted issues sometimes return a non-vocabulary state; the conservative
 * default keeps the contract Literal valid).
 */
function extractState(payload: Record<string, unknown>): "open" | "closed" {
  const state = payload["state"];
  if (state === "open" || state === "closed") {
    return state;
  }
  return "closed";
}
