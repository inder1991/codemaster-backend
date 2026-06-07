// Pure body extractors for the GitHub webhook persistence layer (1:1 with the `_extract_*` functions in
// codemaster/ingest/github_webhook_persistence.py). Each parses the raw webhook body (a Buffer of JSON)
// best-effort and fails CLOSED (returns null / absent) on malformed JSON or missing fields — the audit row
// is still written upstream; only the dispatch path is skipped.

import { GitHubPullRequestPayloadV1 } from "#contracts/github_pull_request_payload.v1.js";

// Truncation caps mirror ReviewPullRequestPayloadV1.{pr_title,pr_description}.max_length (the v2 payload
// the extracted slice feeds). Kept in sync with libs/contracts/src/review_pull_request.v1.ts.
const PR_TITLE_MAX_CHARS = 500;
const PR_DESCRIPTION_MAX_CHARS = 10_000;

/**
 * Normalize a GitHub ISO timestamp to byte-match the Python wire shape. Python's `created_at` is a Pydantic
 * `datetime` emitted via `.isoformat()`, which renders UTC as `+00:00` (NOT `Z`). GitHub sends
 * second-precision `...Z`; rewriting a trailing `Z` → `+00:00` yields the exact Python form. An explicit
 * offset (or null) passes through unchanged. Same instant either way; this only closes a byte-level
 * parity drift against the frozen Python at the outbox seam.
 */
function normalizeOpenedAt(createdAt: string | null): string | null {
  return createdAt !== null && createdAt.endsWith("Z") ? `${createdAt.slice(0, -1)}+00:00` : createdAt;
}

/** Parse the raw body to a plain object, or null on malformed JSON / non-object. */
function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** GitHub `installation.id` (int) or null (ping / anonymous events). */
export function extractInstallationId(body: Uint8Array): number | null {
  const payload = parseJsonObject(body);
  const inst = payload?.["installation"];
  if (typeof inst === "object" && inst !== null) {
    const iid = (inst as Record<string, unknown>)["id"];
    if (typeof iid === "number" && Number.isInteger(iid)) {
      return iid;
    }
  }
  return null;
}

/** (`repository.id`, `pull_request.number`) — non-PR events return [repoId, null]; pr_number must be > 0. */
export function extractRepoAndPr(body: Uint8Array): [number | null, number | null] {
  const payload = parseJsonObject(body);
  if (payload === null) {
    return [null, null];
  }
  let repoId: number | null = null;
  let prNumber: number | null = null;
  const repo = payload["repository"];
  if (typeof repo === "object" && repo !== null) {
    const rid = (repo as Record<string, unknown>)["id"];
    if (typeof rid === "number" && Number.isInteger(rid)) {
      repoId = rid;
    }
  }
  const pr = payload["pull_request"];
  if (typeof pr === "object" && pr !== null) {
    const n = (pr as Record<string, unknown>)["number"];
    if (typeof n === "number" && Number.isInteger(n) && n > 0) {
      prNumber = n;
    }
  }
  return [repoId, prNumber];
}

/** `"user:<sender.login>"` (the actor-kind-namespaced triggered_by) or null. */
export function extractSenderLogin(body: Uint8Array): string | null {
  const payload = parseJsonObject(body);
  const sender = payload?.["sender"];
  if (typeof sender === "object" && sender !== null) {
    const login = (sender as Record<string, unknown>)["login"];
    if (typeof login === "string" && login !== "") {
      return `user:${login}`;
    }
  }
  return null;
}

/** GitHub's `pull_request.node_id` (the stable provider_pr_id) or null (caller synthesizes a fallback). */
export function extractPrNodeId(body: Uint8Array): string | null {
  const payload = parseJsonObject(body);
  const pr = payload?.["pull_request"];
  if (typeof pr === "object" && pr !== null) {
    const nodeId = (pr as Record<string, unknown>)["node_id"];
    if (typeof nodeId === "string" && nodeId !== "") {
      return nodeId;
    }
  }
  return null;
}

/** The pre-resolution slice of ReviewPullRequestPayloadV1 (1:1 with the Python `_PrMetadata` dataclass). */
export type PrMetadata = {
  action: string;
  prNumber: number;
  headSha: string;
  ghOwner: string;
  ghRepoName: string;
  prTitle: string;
  prDescription: string;
  githubRepoId: number;
  isCrossFork: boolean;
  headRepoFullName: string;
  githubPullRequestId: number | null;
  authorGithubUserId: number | null;
  authorLogin: string | null;
  authorUserType: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  draft: boolean;
  merged: boolean;
  /** GitHub `pull_request.created_at` (ISO-8601) or null — passed through to the v2 payload's opened_at. */
  openedAt: string | null;
};

/**
 * Validate the raw body against GitHubPullRequestPayloadV1 (the trust-tier boundary) and project the slice
 * the v2 outbox payload needs. Returns null for non-PR events / malformed JSON / any contract violation —
 * fail-CLOSED at the API trust boundary (1:1 with the Python `_extract_pr_metadata`).
 */
export function extractPrMetadata(body: Uint8Array): PrMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const parsed = GitHubPullRequestPayloadV1.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const p = parsed.data;
  const headRepoFullName = p.pull_request.head.repo.full_name;
  const user = p.pull_request.user;
  const rawPrId = p.pull_request.id;
  return {
    action: p.action,
    prNumber: p.number,
    headSha: p.pull_request.head.sha,
    ghOwner: p.repository.owner.login,
    // Mirror Python `full_name.split("/", 1)[-1]` — everything after the first slash.
    ghRepoName: p.repository.full_name.split("/").slice(1).join("/"),
    prTitle: p.pull_request.title.slice(0, PR_TITLE_MAX_CHARS),
    prDescription: p.pull_request.body.slice(0, PR_DESCRIPTION_MAX_CHARS),
    githubRepoId: p.repository.id,
    isCrossFork: headRepoFullName !== p.repository.full_name,
    headRepoFullName,
    // Map GitHub's BIGINT id 0 → null so the "skip persist" guard treats absent uniformly.
    githubPullRequestId: rawPrId > 0 ? rawPrId : null,
    authorGithubUserId: user ? user.id : null,
    authorLogin: user ? user.login : null,
    authorUserType: user ? user.type : null,
    authorName: null, // GitHubAccountV1 carries no name (future expansion)
    authorAvatarUrl: null,
    baseRef: p.pull_request.base.ref,
    baseSha: p.pull_request.base.sha,
    headRef: p.pull_request.head.ref,
    draft: p.pull_request.draft,
    merged: p.pull_request.merged,
    openedAt: normalizeOpenedAt(p.pull_request.created_at),
  };
}
