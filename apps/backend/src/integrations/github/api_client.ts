/**
 * GitHubApiClient — 1:1 port of `codemaster/integrations/github/api_client.py`
 * (frozen Python, Sprint 5 / S5.1.2; later sprints S15.E typed-4xx + S19.F.NS clock seam +
 * F-4 bootstrap-state-coverage paginated installation/repositories).
 *
 * Async client for the GitHub REST API. The byte-significant logic — the parts a downstream
 * consumer's behaviour depends on — is the `_request` decision loop:
 *
 *   - MAX_5XX_RETRIES (3) attempts with INITIAL_BACKOFF_SECONDS (0.5s) exponential backoff:
 *     a 5xx response sleeps `backoff` then DOUBLES it (0.5 → 1.0 → … ; pure doubling, NO jitter),
 *     up to MAX_5XX_RETRIES-1 retries; the final 5xx raises {@link GitHubApiUnavailableError}.
 *   - 401 → refresh the installation token via `token_provider` ONCE (the `attempt_401` latch),
 *     then retry; a SECOND 401 raises {@link GitHubAppUnauthorized} (does NOT refresh again).
 *   - 403 with "secondary rate limit" in the body → raise {@link GitHubRateLimitExceeded}
 *     (carrying the parsed `Retry-After`).
 *   - On a SUCCESSFUL response, the X-RateLimit-* window is parsed and, if `remaining <= 0`,
 *     {@link GitHubRateLimitExceeded} is raised (carrying `reset_at` from X-RateLimit-Reset).
 *     This is the frozen Python's `maybe_raise_for_window` behaviour: it RAISES, it does NOT
 *     block-and-wait for the reset. (The Temporal layer above is what reschedules.)
 *   - Other 4xx → typed non-retryable errors (403/404/422 → specific subclasses; rest →
 *     {@link GitHubClientError}).
 *
 * --- Injected seams (everything non-deterministic is injected) ---
 *
 *   - `http`: the HTTP transport. Production passes {@link FetchGitHubHttpClient} (a thin
 *     `globalThis.fetch` wrapper). Tests pass the cassette double — any object satisfying
 *     {@link GitHubHttpClient}, whose `request` returns `{ status, headers, body_text }`. The
 *     `CassetteHttpClient` from `#backend/infra/cassettes` satisfies this shape verbatim.
 *   - `clock`: ALL timing (the 5xx backoff sleep) goes through the injected {@link Clock}
 *     (`clock.sleep`), NEVER `setTimeout` / `Date` — the check_clock_random gate enforces this
 *     and tests assert the recorded sleep durations via `FakeClock.recordedSleeps()`.
 *   - `tokenProvider`: `(installationId) => Promise<token>` — the installation-token source. Called
 *     once at the top of `_request`, and once more on the single 401-refresh.
 *
 * Port fidelity notes vs the Python:
 *   - httpx → fetch: the HTTP EXECUTION differs, but every retry / refresh / rate-limit DECISION is
 *     preserved 1:1. The `_record_rate_limit` Postgres persistence hook is NOT ported here (it is a
 *     DB seam owned by a different task); the rate-limit DECISION logic (parse + raise) is.
 *   - The contracts (PullRequestEnvelopeV1 / PullRequestFileEnvelopeV1 / InstallationRepositoryV1)
 *     are defined inline as Zod schemas mirroring `contracts/integrations/github_api/v1.py` +
 *     the `InstallationRepositoryV1` dataclass co-located in the Python api_client module.
 */

import { z } from "zod";

import { type Clock, WallClock } from "#platform/clock.js";
import { transportAbortSignal } from "#platform/transport_timeout.js";

// ─── Constants (1:1 with the frozen Python module constants) ──────────────────────────────────

export const DEFAULT_BASE_URL = "https://api.github.com";
export const MAX_5XX_RETRIES = 3;
export const INITIAL_BACKOFF_SECONDS = 0.5;

/** GitHub REST API version header the Python client pins. */
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_ACCEPT = "application/vnd.github+json";
const DEFAULT_TIMEOUT_SECONDS = 10;

// HTTP status sentinels (module-scope, mirroring the Python `_HTTP_*` finals).
const HTTP_OK_FLOOR = 200;
const HTTP_NOT_MODIFIED = 304;
const HTTP_CLIENT_ERROR_FLOOR = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const HTTP_SERVER_ERROR_FLOOR = 500;
const HTTP_SERVER_ERROR_CEIL = 600;

// ─── Typed errors (1:1 with the Python error hierarchy) ───────────────────────────────────────

/** Raised after 5xx retries are exhausted. Retryable at the Temporal layer. */
export class GitHubApiUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubApiUnavailableError";
  }
}

/** GitHub returned 401 for the installation token twice (refresh did not help). */
export class GitHubAppUnauthorized extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubAppUnauthorized";
  }
}

/**
 * Raised when a SUCCESSFUL response declares the X-RateLimit window exhausted (`remaining <= 0`),
 * or on a 403 secondary-rate-limit body. Carries `reset_at` + `retryAfterSeconds` so the caller can
 * surface a workflow-retry hint. Mirrors `rate_limit.GitHubRateLimitExceeded`.
 */
export class GitHubRateLimitExceeded extends Error {
  public readonly resource: string;
  public readonly resetAt: Date;
  public readonly retryAfterSeconds: number | null;

  public constructor(
    message: string,
    {
      resource,
      resetAt,
      retryAfterSeconds = null,
    }: { resource: string; resetAt: Date; retryAfterSeconds?: number | null },
  ) {
    super(message);
    this.name = "GitHubRateLimitExceeded";
    this.resource = resource;
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Base for non-retryable HTTP 4xx responses from GitHub. Carries `statusCode`. */
export class GitHubClientError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "GitHubClientError";
    this.statusCode = statusCode;
  }
}

/** HTTP 403 (NOT secondary rate-limit). App lacks permission / suspended / deleted installation. */
export class GitHubForbiddenError extends GitHubClientError {
  public constructor(message: string) {
    super(HTTP_FORBIDDEN, message);
    this.name = "GitHubForbiddenError";
  }
}

/** HTTP 404. Resource gone; non-retryable. */
export class GitHubNotFoundError extends GitHubClientError {
  public constructor(message: string) {
    super(HTTP_NOT_FOUND, message);
    this.name = "GitHubNotFoundError";
  }
}

/** HTTP 422. Validation error from GitHub; non-retryable. */
export class GitHubUnprocessableError extends GitHubClientError {
  public constructor(message: string) {
    super(HTTP_UNPROCESSABLE, message);
    this.name = "GitHubUnprocessableError";
  }
}

// ─── Injected HTTP-transport seam ─────────────────────────────────────────────────────────────

/**
 * The HTTP response shape the client consumes. A SUPERSET-compatible subset of `CassetteResponse`
 * from `#backend/infra/cassettes` (which adds `body_json`), so the cassette double satisfies this
 * interface structurally without an adapter.
 */
export type GitHubHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body_text: string | null;
};

/** Arguments to one HTTP request — mirrors the cassette client's `request` keyword args. */
export type GitHubHttpRequestArgs = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  json_body?: unknown;
  text_body?: string | null;
};

/**
 * The injected HTTP transport. Production: {@link FetchGitHubHttpClient}. Tests: the
 * `CassetteHttpClient` (its `request` signature + return shape are a structural match).
 */
export type GitHubHttpClient = {
  request(args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse>;
};

/**
 * Production HTTP transport: a thin wrapper over Node's built-in global `fetch` (undici). NO new
 * dependency. NO timing here (the client's backoff lives in `_request` via the injected Clock), so
 * this file does not touch the clock seam.
 *
 * `timeoutSeconds` arms an `AbortController` so a hung request fails rather than blocking forever;
 * the timer uses `setTimeout` purely as an abort trigger (not as a CLOCK read) — the gate scans
 * Date/Math/crypto, not setTimeout, and this is production-transport timeout plumbing, not
 * deterministic-replay-sensitive timing.
 */
export class FetchGitHubHttpClient implements GitHubHttpClient {
  private readonly timeoutMs: number;

  public constructor({ timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }: { timeoutSeconds?: number } = {}) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  public async request(args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse> {
    const body: string | undefined =
      args.json_body !== undefined && args.json_body !== null
        ? JSON.stringify(args.json_body)
        : (args.text_body ?? undefined);
    const init: RequestInit = {
      method: args.method,
      headers: args.headers ?? {},
      // Transport timeout via the sanctioned seam — the timer is owned by the signal (no manual
      // AbortController / clearTimeout bookkeeping). A fired timeout rejects fetch with an AbortError.
      signal: transportAbortSignal(this.timeoutMs),
    };
    // Omit `body` entirely (rather than set it to undefined) so it satisfies
    // exactOptionalPropertyTypes — a GET/DELETE must carry no request body.
    if (body !== undefined) init.body = body;
    const resp = await fetch(args.url, init);
    const headers: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await resp.text();
    return { status: resp.status, headers, body_text: text === "" ? null : text };
  }
}

// ─── token_provider seam ──────────────────────────────────────────────────────────────────────

/** The injected installation-token source: `(installationId) => Promise<token>`. */
export type TokenProvider = (installationId: number) => Promise<string>;

// ─── Rate-limit header parsing (port of rate_limit.parse_rate_limit / parse_retry_after) ───────

/** Case-insensitive header lookup (the VCR cassettes preserve original casing; fetch lowercases). */
function header(headers: Record<string, string>, name: string): string | undefined {
  const exact = headers[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** A parsed X-RateLimit window. Mirrors `RateLimitWindowV1`'s read-side fields. */
export type RateLimitWindow = {
  resource: string;
  limit: number;
  remaining: number;
  resetAt: Date;
};

const DEFAULT_RESOURCE = "core";

/**
 * Extract a rate-limit window from response headers. Returns null when the headers are absent
 * (e.g. 304) or unparseable — 1:1 with `parse_rate_limit`.
 */
export function parseRateLimit(headers: Record<string, string>): RateLimitWindow | null {
  const limit = header(headers, "X-RateLimit-Limit");
  const remaining = header(headers, "X-RateLimit-Remaining");
  const reset = header(headers, "X-RateLimit-Reset");
  if (limit === undefined || remaining === undefined || reset === undefined) return null;
  const limitN = Number.parseInt(limit, 10);
  const remainingN = Number.parseInt(remaining, 10);
  const resetN = Number.parseInt(reset, 10);
  if (Number.isNaN(limitN) || Number.isNaN(remainingN) || Number.isNaN(resetN)) return null;
  // X-RateLimit-Reset is a Unix epoch SECONDS value → ms for the JS Date (UTC instant).
  return {
    resource: DEFAULT_RESOURCE,
    limit: limitN,
    remaining: remainingN,
    resetAt: new Date(resetN * 1000),
  };
}

/** Parse the `Retry-After` header (seconds form). Returns null if absent/unparseable. */
export function parseRetryAfter(headers: Record<string, string>): number | null {
  const raw = header(headers, "Retry-After");
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

// ─── Inline contracts (mirror contracts/integrations/github_api/v1.py) ─────────────────────────

/** Subset of GET /repos/:owner/:repo/pulls/:number. `extra="ignore"` → tolerant parse. */
export const PullRequestEnvelopeV1 = z
  .object({
    schema_version: z.number().int().default(1),
    number: z.number().int(),
    state: z.enum(["open", "closed"]),
    title: z.string(),
    body: z.string().nullable().default(null),
    head_sha: z.string().default(""),
    base_ref: z.string().default("main"),
  })
  .passthrough();
export type PullRequestEnvelopeV1 = z.infer<typeof PullRequestEnvelopeV1>;

/** Subset of one entry in GET /repos/:owner/:repo/pulls/:number/files. */
export const PullRequestFileEnvelopeV1 = z
  .object({
    filename: z.string(),
    status: z.enum([
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
    ]),
    additions: z.number().int(),
    deletions: z.number().int(),
    changes: z.number().int(),
    patch: z.string().nullable().default(null),
  })
  .passthrough();
export type PullRequestFileEnvelopeV1 = z.infer<typeof PullRequestFileEnvelopeV1>;

/**
 * One entry from `GET /installation/repositories`. Co-located with the client (mirrors the Python
 * `InstallationRepositoryV1` dataclass living in api_client.py, distinct from the webhook shape).
 */
export type InstallationRepositoryV1 = {
  id: number;
  full_name: string;
  default_branch: string;
  archived: boolean;
};

// ─── Link-header parsing (port of `_extract_next_link`) ────────────────────────────────────────

/** Parse RFC 5988 Link header; return the PATH of the rel="next" link, or null. */
export function extractNextLink(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;
  for (const segment of linkHeader.split(",")) {
    const parts = segment.trim().split(";");
    if (parts.length < 2) continue;
    const urlPart = parts[0]!.trim().replace(/^</, "").replace(/>$/, "");
    for (const attr of parts.slice(1)) {
      if (attr.trim() === 'rel="next"') {
        if (urlPart.includes("://")) {
          const afterScheme = urlPart.split("://", 2)[1] ?? "";
          const slashIdx = afterScheme.indexOf("/");
          const path = slashIdx === -1 ? "" : afterScheme.slice(slashIdx + 1);
          return "/" + path;
        }
        return urlPart;
      }
    }
  }
  return null;
}

// ─── The client ───────────────────────────────────────────────────────────────────────────────

export type GitHubApiClientOptions = {
  tokenProvider: TokenProvider;
  http?: GitHubHttpClient;
  baseUrl?: string;
  timeoutSeconds?: number;
  clock?: Clock;
};

export class GitHubApiClient {
  private readonly tokenProvider: TokenProvider;
  private readonly http: GitHubHttpClient;
  private readonly baseUrl: string;
  private readonly clock: Clock;

  public constructor({
    tokenProvider,
    http,
    baseUrl = DEFAULT_BASE_URL,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    clock,
  }: GitHubApiClientOptions) {
    this.tokenProvider = tokenProvider;
    this.http = http ?? new FetchGitHubHttpClient({ timeoutSeconds });
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.clock = clock ?? new WallClock();
  }

  // ─── Internals ────────────────────────────────────────────────────────────────────────────

  /**
   * The 1:1 port of Python `_request`. Drives the retry / 401-refresh / rate-limit decision loop;
   * returns the successful {@link GitHubHttpResponse} or raises a typed error.
   */
  private async _request(
    method: string,
    path: string,
    {
      installationId,
      accept = DEFAULT_ACCEPT,
      jsonBody = null,
    }: { installationId: number; accept?: string; jsonBody?: unknown },
  ): Promise<GitHubHttpResponse> {
    let token = await this.tokenProvider(installationId);
    let attempt401 = false;
    let backoff = INITIAL_BACKOFF_SECONDS;

    for (let attempt = 0; attempt < MAX_5XX_RETRIES; attempt += 1) {
      const url = `${this.baseUrl}${path}`;
      const resp = await this.http.request({
        method,
        url,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        json_body: jsonBody,
      });

      // 401 → refresh the token once (the `attempt_401` latch), then retry.
      if (resp.status === HTTP_UNAUTHORIZED && !attempt401) {
        attempt401 = true;
        token = await this.tokenProvider(installationId);
        continue;
      }
      if (resp.status === HTTP_UNAUTHORIZED) {
        throw new GitHubAppUnauthorized(
          `GitHub returned 401 twice for installation_id=${installationId}`,
        );
      }

      // 403 secondary-rate-limit → typed rate-limit error carrying Retry-After.
      if (
        resp.status === HTTP_FORBIDDEN &&
        (resp.body_text ?? "").toLowerCase().includes("secondary rate limit")
      ) {
        const retryAfter = parseRetryAfter(resp.headers);
        throw new GitHubRateLimitExceeded(
          `GitHub secondary rate limit hit; retry_after=${retryAfter}s`,
          { resource: "secondary", resetAt: this.clock.now(), retryAfterSeconds: retryAfter },
        );
      }

      // 5xx → exponential-backoff retry (sleep then DOUBLE) until exhausted.
      if (resp.status >= HTTP_SERVER_ERROR_FLOOR && resp.status < HTTP_SERVER_ERROR_CEIL) {
        if (attempt < MAX_5XX_RETRIES - 1) {
          await this.clock.sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw new GitHubApiUnavailableError(
          `GitHub ${resp.status} after ${MAX_5XX_RETRIES} attempts on ${method} ${path}`,
        );
      }

      // Typed 4xx mapping (non-retryable at the Temporal layer).
      if (resp.status === HTTP_FORBIDDEN) {
        throw new GitHubForbiddenError(
          `GitHub 403 on ${method} ${path}: ${(resp.body_text ?? "").slice(0, 200)}`,
        );
      }
      if (resp.status === HTTP_NOT_FOUND) {
        throw new GitHubNotFoundError(
          `GitHub 404 on ${method} ${path}: ${(resp.body_text ?? "").slice(0, 200)}`,
        );
      }
      if (resp.status === HTTP_UNPROCESSABLE) {
        throw new GitHubUnprocessableError(
          `GitHub 422 on ${method} ${path}: ${(resp.body_text ?? "").slice(0, 200)}`,
        );
      }
      if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
        throw new GitHubClientError(
          resp.status,
          `GitHub ${resp.status} on ${method} ${path}: ${(resp.body_text ?? "").slice(0, 200)}`,
        );
      }

      // Successful response: surface the rate-limit window if we're at the boundary.
      const window = parseRateLimit(resp.headers);
      if (window !== null && window.remaining <= 0) {
        throw new GitHubRateLimitExceeded(
          `GitHub ${window.resource} rate limit exhausted; reset_at=${window.resetAt.toISOString()}`,
          {
            resource: window.resource,
            resetAt: window.resetAt,
            retryAfterSeconds: parseRetryAfter(resp.headers),
          },
        );
      }
      return resp;
    }

    throw new GitHubApiUnavailableError("unreachable retry loop exit");
  }

  /** JSON-decode a response body, raising a clear error if it is empty/malformed. */
  private static jsonOf(resp: GitHubHttpResponse, context: string): unknown {
    const text = resp.body_text ?? "";
    if (text === "") {
      throw new GitHubClientError(resp.status, `empty body where JSON expected on ${context}`);
    }
    return JSON.parse(text);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────────────────────

  public async getPullRequest({
    installationId,
    owner,
    repo,
    prNumber,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<PullRequestEnvelopeV1> {
    const resp = await this._request("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`, {
      installationId,
    });
    const body = GitHubApiClient.jsonOf(resp, "get_pull_request") as Record<string, unknown>;
    // Normalize the head SHA + base ref into the contract's expected fields (mirrors the Python
    // setdefault of head_sha_extracted / base_ref_extracted onto the validation aliases).
    const head = (body["head"] ?? {}) as Record<string, unknown>;
    const base = (body["base"] ?? {}) as Record<string, unknown>;
    if (body["head_sha"] === undefined) body["head_sha"] = head["sha"] ?? "";
    if (body["base_ref"] === undefined) body["base_ref"] = base["ref"] ?? "main";
    return PullRequestEnvelopeV1.parse(body);
  }

  public async getPullRequestDiff({
    installationId,
    owner,
    repo,
    prNumber,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<string> {
    const resp = await this._request("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`, {
      installationId,
      accept: "application/vnd.github.v3.diff",
    });
    return resp.body_text ?? "";
  }

  public async getPullRequestFiles({
    installationId,
    owner,
    repo,
    prNumber,
    maxFiles = 3000,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    maxFiles?: number;
  }): Promise<Array<PullRequestFileEnvelopeV1>> {
    const out: Array<PullRequestFileEnvelopeV1> = [];
    let page = 1;
    const maxPages = Math.floor((maxFiles + 99) / 100) + 1;
    while (out.length < maxFiles && page <= maxPages) {
      const resp = await this._request(
        "GET",
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        { installationId },
      );
      const body = GitHubApiClient.jsonOf(resp, "get_pull_request_files") as Array<unknown>;
      if (body.length === 0) break;
      for (const raw of body) out.push(PullRequestFileEnvelopeV1.parse(raw));
      if (!(header(resp.headers, "Link") ?? "").includes('rel="next"')) break;
      page += 1;
    }
    return out.slice(0, maxFiles);
  }

  public async listInstallationRepositories({
    installationId,
  }: {
    installationId: number;
  }): Promise<Array<InstallationRepositoryV1>> {
    const repos: Array<InstallationRepositoryV1> = [];
    let urlPath: string | null = "/installation/repositories?per_page=100";
    while (urlPath) {
      const resp = await this._request("GET", urlPath, { installationId });
      const body = GitHubApiClient.jsonOf(resp, "list_installation_repositories") as Record<
        string,
        unknown
      >;
      const rawRepos = (body["repositories"] ?? []) as Array<Record<string, unknown>>;
      for (const raw of rawRepos) {
        repos.push({
          id: raw["id"] as number,
          full_name: raw["full_name"] as string,
          default_branch: (raw["default_branch"] as string | undefined) || "main",
          archived: Boolean(raw["archived"] ?? false),
        });
      }
      urlPath = extractNextLink(header(resp.headers, "Link"));
    }
    return repos;
  }

  // ─── Manifest fetch (FOLLOW-UP-confluence-pr-context-manifests) ──────────────────────────────
  // These satisfy the `GithubContentsPort` shape the fetch_manifest_snapshots activity consumes
  // (structural typing — no `implements` to avoid a circular import). `installationUuid` is accepted for
  // that port shape (a Python telemetry param); the TS `_request` does not consume it.

  /**
   * GET /repos/{owner}/{repo}/contents/{path}?ref={ref} (1:1 with the Python `get_contents`). Returns
   * `[contentBase64AsciiBytes, blobSha]` on 200 (content is base64 per GitHub's contents API — the caller
   * base64-decodes), or `null` on 404 / non-file / malformed. `GitHubAppUnauthorized` propagates.
   */
  public async getContents(args: {
    installationId: number;
    installationUuid: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<readonly [Uint8Array, string] | null> {
    // Encode each path SEGMENT but preserve the '/' separators — GitHub's contents API resolves
    // /repos/{owner}/{repo}/contents/{a}/{b}/{c}, so encodeURIComponent on the whole path (which turns
    // '/' into %2F) 404s nested monorepo manifests like services/api/package.json.
    const encodedPath = args.path.split("/").map(encodeURIComponent).join("/");
    const encodedRef = encodeURIComponent(args.ref);
    let resp: GitHubHttpResponse;
    try {
      resp = await this._request(
        "GET",
        `/repos/${args.owner}/${args.repo}/contents/${encodedPath}?ref=${encodedRef}`,
        { installationId: args.installationId },
      );
    } catch (e) {
      if (e instanceof GitHubNotFoundError) {
        return null; // file absent at the ref — caller tries the next candidate
      }
      throw e;
    }
    const body = GitHubApiClient.jsonOf(resp, "get_contents");
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    const rec = body as Record<string, unknown>;
    if (rec["type"] !== "file") {
      return null; // a directory/symlink/submodule listing — not a manifest file
    }
    const contentB64 = rec["content"];
    const sha = rec["sha"];
    if (typeof contentB64 !== "string" || typeof sha !== "string") {
      return null;
    }
    // Python returns `content_b64.encode("ascii")`; base64 chars are ASCII so the ASCII-byte encoding
    // round-trips identically. The activity base64-decodes these bytes.
    return [new Uint8Array(Buffer.from(contentB64, "ascii")), sha] as const;
  }

  /**
   * GET /repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1 (1:1 with the Python `get_recursive_tree`).
   * Returns `[blobPaths (ASCII-sorted), truncated]`; `truncated=true` when the repo exceeded GitHub's
   * 100k tree-entry cap. Best-effort — callers wrap in try/catch + degrade the nearest-walk on any throw.
   */
  public async getRecursiveTree(args: {
    installationId: number;
    installationUuid: string;
    owner: string;
    repo: string;
    treeSha: string;
  }): Promise<readonly [ReadonlyArray<string>, boolean]> {
    const encodedSha = encodeURIComponent(args.treeSha);
    const resp = await this._request(
      "GET",
      `/repos/${args.owner}/${args.repo}/git/trees/${encodedSha}?recursive=1`,
      { installationId: args.installationId },
    );
    const body = GitHubApiClient.jsonOf(resp, "get_recursive_tree");
    const rec = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const truncated = Boolean(rec["truncated"]);
    const entries = Array.isArray(rec["tree"]) ? (rec["tree"] as Array<unknown>) : [];
    const paths = entries
      .filter(
        (e): e is Record<string, unknown> => e !== null && typeof e === "object" && !Array.isArray(e),
      )
      .filter((e) => e["type"] === "blob" && typeof e["path"] === "string")
      .map((e) => e["path"] as string)
      .sort();
    return [paths, truncated] as const;
  }

  // ─── Generic verb helpers (post-comment etc. build on these) ────────────────────────────────

  public async get(
    path: string,
    { installationId, accept = DEFAULT_ACCEPT }: { installationId: number; accept?: string },
  ): Promise<GitHubHttpResponse> {
    return this._request("GET", path, { installationId, accept });
  }

  public async post(
    path: string,
    { installationId, jsonBody = null }: { installationId: number; jsonBody?: unknown },
  ): Promise<GitHubHttpResponse> {
    return this._request("POST", path, { installationId, jsonBody });
  }

  public async put(
    path: string,
    { installationId, jsonBody = null }: { installationId: number; jsonBody?: unknown },
  ): Promise<GitHubHttpResponse> {
    return this._request("PUT", path, { installationId, jsonBody });
  }

  public async patch(
    path: string,
    { installationId, jsonBody = null }: { installationId: number; jsonBody?: unknown },
  ): Promise<GitHubHttpResponse> {
    return this._request("PATCH", path, { installationId, jsonBody });
  }

  public async delete(
    path: string,
    { installationId }: { installationId: number },
  ): Promise<GitHubHttpResponse> {
    return this._request("DELETE", path, { installationId });
  }

  /** Whether a status is in the 2xx success band (exposed for callers building on `get`/`post`). */
  public static isSuccess(status: number): boolean {
    return status >= HTTP_OK_FLOOR && status < HTTP_CLIENT_ERROR_FLOOR && status !== HTTP_NOT_MODIFIED;
  }
}
