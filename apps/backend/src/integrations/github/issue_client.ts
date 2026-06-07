/**
 * GitHubIssueClient — 1:1 port of the ETag-aware `get_issue` method on the frozen Python
 * `codemaster/integrations/github/api_client.py::GitHubApiClient` (DM-WIRE T4 / S22.DM.16).
 *
 * The Python `get_issue` deliberately bypasses the shared `_request` retry/refresh loop because the
 * ETag round-trip needs a CUSTOM request header (`If-None-Match`) and a CUSTOM response-header read
 * (`ETag`) that `_request` does not expose. This port mirrors that: it talks to the injected
 * {@link GitHubHttpClient} transport directly (the same seam the `GitHubApiClient` uses — production
 * `FetchGitHubHttpClient`, tests the cassette double), wraps the same `tokenProvider` pattern, and
 * NEVER raises on a non-2xx — it returns `(payload, etag, status)` so the consuming
 * `fetchLinkedIssues` activity can absorb failures into a `(null, null)` resolver entry instead of
 * cascading into a workflow-stage error.
 *
 * This is a NEW source module (not an edit to `api_client.ts`): the existing `GitHubApiClient` is a
 * frozen, already-ported file. The ETag-aware read lives alongside it as a sibling client over the same
 * injected transport + token-provider seams, exactly as the Python keeps `get_issue` as a method that
 * uses the lower-level client directly.
 *
 * Return contract (1:1 with the Python tuple `(payload, etag, status_code)`):
 *   - 200  → `[payload dict, fresh ETag header value, 200]`. Caller upserts the cache.
 *   - 304  → `[null, the inbound if_none_match (still valid), 304]`. Caller refreshes cached_at,
 *            keeps the cached body.
 *   - 404  → `[null, null, 404]`. Caller falls back to `(title=null, state=null)`.
 *   - other ≥ 400 → `[null, null, status]`. Surfaced (NOT raised) — caller's responsibility to map
 *            (e.g. the activity treats 403 as a rate-limit circuit-breaker signal).
 */

import {
  DEFAULT_BASE_URL,
  type GitHubHttpClient,
  FetchGitHubHttpClient,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";

// HTTP status sentinels (mirroring the Python `_HTTP_*` finals used inside `get_issue`).
const HTTP_NOT_MODIFIED = 304;
const HTTP_NOT_FOUND = 404;
const HTTP_CLIENT_ERROR_FLOOR = 400;

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_ACCEPT = "application/vnd.github+json";

/** The `(payload, etag, status)` tuple returned by {@link GitHubIssueClient.getIssue}. */
export type GetIssueResult = readonly [Record<string, unknown> | null, string | null, number];

/** Case-insensitive response-header lookup (cassettes preserve original casing; fetch lowercases). */
function header(headers: Record<string, string>, name: string): string | undefined {
  const exact = headers[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export type GitHubIssueClientOptions = {
  tokenProvider: TokenProvider;
  http?: GitHubHttpClient;
  baseUrl?: string;
  timeoutSeconds?: number;
};

/**
 * Sibling client carrying ONLY the ETag-aware `getIssue` read. Constructed over the same injected
 * transport + token-provider seams as {@link GitHubApiClient}.
 */
export class GitHubIssueClient {
  readonly #tokenProvider: TokenProvider;
  readonly #http: GitHubHttpClient;
  readonly #baseUrl: string;

  public constructor({ tokenProvider, http, baseUrl = DEFAULT_BASE_URL, timeoutSeconds }: GitHubIssueClientOptions) {
    this.#tokenProvider = tokenProvider;
    this.#http =
      http ??
      new FetchGitHubHttpClient(timeoutSeconds === undefined ? {} : { timeoutSeconds });
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * GET `/repos/{owner}/{repo}/issues/{n}` with ETag support, 1:1 with the Python `get_issue`.
   *
   * Sends `If-None-Match` when `ifNoneMatch` is provided. Reads the `ETag` response header (case
   * insensitive). Returns `[payload, etag, status]` per the contract documented on this module —
   * never raises on a non-2xx; the caller absorbs failures.
   */
  public async getIssue(args: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    ifNoneMatch?: string | null;
  }): Promise<GetIssueResult> {
    const { installationId, owner, repo, issueNumber } = args;
    const ifNoneMatch = args.ifNoneMatch ?? null;

    const token = await this.#tokenProvider(installationId);
    const headers: Record<string, string> = {
      Accept: DEFAULT_ACCEPT,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (ifNoneMatch !== null) {
      headers["If-None-Match"] = ifNoneMatch;
    }

    const url = `${this.#baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`;
    const resp = await this.#http.request({ method: "GET", url, headers });

    const etag = header(resp.headers, "ETag") ?? header(resp.headers, "etag") ?? null;
    const status = resp.status;

    if (status === HTTP_NOT_MODIFIED) {
      // ETag still valid — body unchanged; surface the inbound if_none_match.
      return [null, ifNoneMatch, status];
    }
    if (status === HTTP_NOT_FOUND) {
      return [null, null, status];
    }
    if (status >= HTTP_CLIENT_ERROR_FLOOR) {
      // 4xx/other — the activity absorbs failures into a null resolver entry; raising here would
      // cascade into a workflow-stage error. Surface (None, None, status) instead.
      return [null, null, status];
    }

    const text = resp.body_text ?? "";
    const payload = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    return [payload, etag, status];
  }
}
