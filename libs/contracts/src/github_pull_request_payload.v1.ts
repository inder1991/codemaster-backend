import { z } from "zod";

// Zod port of contracts/integrations/github_payloads/v1.py (the GitHub `pull_request` webhook event +
// its nested objects). This is the TRUST-TIER boundary contract: the raw webhook body is validated
// against it before any internal id resolution. All Python models use `ConfigDict(extra="ignore")` →
// Zod default `.strip()` (NO `.strict()`) — GitHub adds fields freely and we drop the ones we don't model.
//
// Parity note: field constraints are transcribed verbatim from the frozen Python (read 2026-06-06). The
// `pull_request.title` cap here is 10_000 (the GitHub contract); the review payload's 500-char
// `pr_title` truncation happens later in extractPrMetadata, not here.

/** GitHub-side account (`user` / `owner` / `sender`). */
export const GitHubAccountV1 = z.object({
  id: z.number().int(),
  login: z.string().min(1).max(100),
  type: z.enum(["User", "Organization", "Bot"]),
});
export type GitHubAccountV1 = z.infer<typeof GitHubAccountV1>;

/** The embedded `installation` object (pull_request events carry only `id`; `account` is optional). */
export const GitHubInstallationV1 = z.object({
  id: z.number().int(),
  account: GitHubAccountV1.nullable().default(null),
});
export type GitHubInstallationV1 = z.infer<typeof GitHubInstallationV1>;

/** A `head.repo` / `base.repo` reference (cross-fork detection compares `full_name`). */
export const GitHubRepositoryRefV1 = z.object({
  full_name: z.string().min(1).max(200),
});
export type GitHubRepositoryRefV1 = z.infer<typeof GitHubRepositoryRefV1>;

/**
 * A `head` / `base` commit ref. `sha` accepts SHA-1 (40) or SHA-256 (64), hex-only (GitHub's SHA-256
 * migration forward-compat). KNOWN LATENT GAP, shared verbatim with the frozen Python:
 * ReviewPullRequestPayloadV1.head_sha is exactly-40, so a 64-char SHA-256 head_sha would pass intake here
 * but dead-letter at the v2 workflow boundary. GitHub sends 40-char SHA-1 today; when the SHA-256
 * migration lands, widen the v2 head_sha + this bound in lockstep (on both the TS + Python contracts).
 */
export const GitHubCommitRefV1 = z.object({
  sha: z
    .string()
    .min(40)
    .max(64)
    .regex(/^[0-9a-f]+$/),
  repo: GitHubRepositoryRefV1,
  ref: z.string().max(255).default(""),
});
export type GitHubCommitRefV1 = z.infer<typeof GitHubCommitRefV1>;

/** GitHub's `repository` object (subset). `gh_owner` is derived from `owner.login`. */
export const GitHubRepositoryV1 = z.object({
  id: z.number().int(),
  full_name: z.string().min(1).max(200),
  default_branch: z.string().default("main"),
  archived: z.boolean().default(false),
  owner: GitHubAccountV1,
});
export type GitHubRepositoryV1 = z.infer<typeof GitHubRepositoryV1>;

/** The `pull_request` object (subset). `body` coerces null → "" (GitHub allows a null body). */
export const GitHubPullRequestRefV1 = z.object({
  number: z.number().int().gte(1),
  title: z.string().max(10_000).default(""),
  // 1:1 with the Python `field_validator(body, mode="before")` None → "" + default "".
  body: z.preprocess((v) => (v == null ? "" : v), z.string().default("")),
  state: z.enum(["open", "closed"]).default("open"),
  draft: z.boolean().default(false),
  head: GitHubCommitRefV1,
  base: GitHubCommitRefV1,
  user: GitHubAccountV1.nullable().default(null),
  merged: z.boolean().default(false),
  // GitHub's stable BIGINT PR id; 0 → "absent" (the handler treats id<=0 as skip-persist).
  id: z.number().int().gte(0).default(0),
  // Plain datetime in Python (no tz validator) → accept Z-offset or local ISO-8601.
  created_at: z.string().datetime({ offset: true, local: true }).nullable().default(null),
});
export type GitHubPullRequestRefV1 = z.infer<typeof GitHubPullRequestRefV1>;

/** The full `pull_request` webhook event. Unknown `action` REJECTS (a GitHub expansion surfaces in test). */
export const GitHubPullRequestPayloadV1 = z.object({
  schema_version: z.number().int().default(1),
  action: z.enum([
    "opened",
    "synchronize",
    "reopened",
    "closed",
    "edited",
    "ready_for_review",
    "converted_to_draft",
  ]),
  number: z.number().int().gte(1),
  pull_request: GitHubPullRequestRefV1,
  repository: GitHubRepositoryV1,
  installation: GitHubInstallationV1,
  sender: GitHubAccountV1,
});
export type GitHubPullRequestPayloadV1 = z.infer<typeof GitHubPullRequestPayloadV1>;
