/**
 * GhCheckRunClient — 1:1 port of `codemaster/integrations/github/check_run_client.py`
 * (frozen Python, Sprint 15 / S15.X-post-check-run-wiring).
 *
 * Production impl of the 3-method check-run surface the `post_check_run` activity needs (declared in the
 * frozen Python as the `GhCheckRunClient` Protocol at
 * `vendor/codemaster-py/codemaster/activities/post_check_run.py:42-75`). Wraps the ported
 * {@link GitHubApiClient}'s GET / POST / PATCH helpers so the 3 methods route through the shared
 * retry / 401-refresh / rate-limit-header / typed-error envelope (`_request`).
 *
 * ## CLAUDE.md invariant 9 — advisory, never blocks merge
 *
 * The bot's `conclusion` is ALWAYS `"neutral"`. The {@link GhCheckRunClient} type pins this via the
 * `conclusion: "neutral"` literal on `createCheckRun` / `updateCheckRun`; this impl just round-trips the
 * value to GitHub.
 *
 * ## Exact REST endpoints (byte-ported from the Python concrete impl)
 *
 *   - findExistingCheckRun → GET  /repos/{owner}/{repo}/commits/{head_sha}/check-runs
 *       Reads the FIRST page only (GitHub's default per_page=30). Returns the id of the first run whose
 *       `name` matches (client-side filter), else null. v1 pagination caveat preserved from the Python:
 *       the codemaster check-run name only ever has ONE active run per head_sha, so 30 is plenty unless
 *       another producer spams many same-name runs (unlikely; documented). Full Link-header pagination is
 *       the same Sprint-16+ optimization the Python defers.
 *   - createCheckRun → POST /repos/{owner}/{repo}/check-runs
 *       Body: { name, head_sha, status, conclusion, output: { title: name, summary } }. Returns
 *       int(resp.json()["id"]).
 *   - updateCheckRun → PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}
 *       GitHub uses PATCH for update — NOT PUT (a PUT yields a confusing 405). Body:
 *       { status, conclusion, output: { title: "codemaster/review", summary } }. The Python pins the
 *       PATCH-not-PUT contract via `test_update_check_run_uses_PATCH_not_PUT`; this port pins it via the
 *       recording-stub test asserting `method === "PATCH"`.
 *
 * ## Summary truncation
 *
 * GitHub's Check Runs API caps `output.summary` at 65535 chars. The Python truncates at
 * SUMMARY_MAX_CHARS = 65000 and appends a footer marker so PR readers see "... [truncated]" rather than
 * a silent cutoff. Ported verbatim ({@link truncateSummary}).
 *
 * ## Why a class over the GitHubApiClient (not a bare fetch)
 *
 * The Python `GhCheckRunHttpClient` wraps `GitHubApiClient` so the 3 methods inherit the unified retry /
 * rate-limit posture across ALL GitHub-facing activities (the worker reuses ONE `GitHubApiClient`
 * singleton). The TS impl preserves that: the client is constructed over an injected
 * {@link GitHubApiClient} + a fixed `installation_id`.
 */

import { type GitHubApiClient } from "#backend/integrations/github/api_client.js";

// GitHub's documented limit is 65_535; we cap a bit lower to leave headroom for the truncation footer.
export const SUMMARY_MAX_CHARS = 65_000;
export const SUMMARY_TRUNCATION_FOOTER = "\n\n... [truncated]";

/** The check-run name codemaster posts. Mirrors the Python module-level `CHECK_RUN_NAME` final. */
export const CHECK_RUN_NAME = "codemaster/review";

/** The two check-run lifecycle states the activity may set. Mirrors the Python `Literal[...]`. */
export type CheckRunStatus = "completed" | "in_progress";

/**
 * The minimal 3-method surface `doPostCheckRun` needs from the GitHub API — the TS analogue of the
 * frozen Python `GhCheckRunClient` Protocol. Keyword-only Python args → a single args object per method
 * (camelCase members), so the dispatch is positional-arg-free at the seam.
 */
export type GhCheckRunClient = {
  /**
   * Returns the most-recent matching check-run id at `headSha`, or null when no run with the given
   * `name` exists. v1 inspects the FIRST page only (GitHub's default per_page=30).
   */
  findExistingCheckRun(args: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
  }): Promise<number | null>;

  /** POST a new check-run; returns the new check-run id. `conclusion` is ALWAYS "neutral". */
  createCheckRun(args: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
    status: CheckRunStatus;
    conclusion: "neutral";
    summary: string;
  }): Promise<number>;

  /** PATCH an existing check-run in place. `conclusion` is ALWAYS "neutral". */
  updateCheckRun(args: {
    owner: string;
    repo: string;
    checkRunId: number;
    status: CheckRunStatus;
    conclusion: "neutral";
    summary: string;
  }): Promise<void>;
};

/**
 * Truncate `output.summary` to GitHub's cap with a footer marker. 1:1 with the Python `_truncate_summary`:
 * strings at or under SUMMARY_MAX_CHARS pass through unchanged; longer strings are sliced and footered.
 */
export function truncateSummary(summary: string): string {
  if (summary.length <= SUMMARY_MAX_CHARS) {
    return summary;
  }
  return summary.slice(0, SUMMARY_MAX_CHARS) + SUMMARY_TRUNCATION_FOOTER;
}

/**
 * Production {@link GhCheckRunClient}: implements the 3 methods over an injected {@link GitHubApiClient}.
 * 1:1 with the Python `GhCheckRunHttpClient`.
 */
export class GitHubApiCheckRunClient implements GhCheckRunClient {
  private readonly api: GitHubApiClient;
  private readonly installationId: number;

  public constructor({ api, installationId }: { api: GitHubApiClient; installationId: number }) {
    if (installationId <= 0) {
      throw new Error(`installation_id must be >= 1, got ${installationId}`);
    }
    this.api = api;
    this.installationId = installationId;
  }

  public async findExistingCheckRun({
    owner,
    repo,
    headSha,
    name,
  }: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
  }): Promise<number | null> {
    // GitHub supports a `?check_name=` filter but we filter client-side too so the test surface verifies
    // the contract regardless of which way the API surfaces multi-name responses (1:1 with the Python).
    const path = `/repos/${owner}/${repo}/commits/${headSha}/check-runs`;
    const resp = await this.api.get(path, { installationId: this.installationId });
    const body = JSON.parse(resp.body_text ?? "{}") as { check_runs?: Array<Record<string, unknown>> };
    const runs = body.check_runs ?? [];
    for (const run of runs) {
      if (run["name"] === name) {
        return Number(run["id"]);
      }
    }
    return null;
  }

  public async createCheckRun({
    owner,
    repo,
    headSha,
    name,
    status,
    conclusion,
    summary,
  }: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
    status: CheckRunStatus;
    conclusion: "neutral";
    summary: string;
  }): Promise<number> {
    const jsonBody = {
      name,
      head_sha: headSha,
      status,
      conclusion,
      output: {
        title: name,
        summary: truncateSummary(summary),
      },
    };
    const resp = await this.api.post(`/repos/${owner}/${repo}/check-runs`, {
      installationId: this.installationId,
      jsonBody,
    });
    const parsed = JSON.parse(resp.body_text ?? "{}") as { id: number };
    return Number(parsed.id);
  }

  public async updateCheckRun({
    owner,
    repo,
    checkRunId,
    status,
    conclusion,
    summary,
  }: {
    owner: string;
    repo: string;
    checkRunId: number;
    status: CheckRunStatus;
    conclusion: "neutral";
    summary: string;
  }): Promise<void> {
    // GitHub's API uses PATCH for update — NOT PUT. Getting that wrong yields a confusing 405.
    const jsonBody = {
      status,
      conclusion,
      output: {
        title: CHECK_RUN_NAME,
        summary: truncateSummary(summary),
      },
    };
    await this.api.patch(`/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
      installationId: this.installationId,
      jsonBody,
    });
  }
}
