/**
 * `enrich_pr_files_activity_v2` — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/enrich_pr_files_v2.py` (the `EnrichPrFilesActivityV2`
 * holder) + the v1-module primitives it imports (`GitHubPrFilesPort`, `_normalize_status`).
 *
 * THIS stage populates the real `changed_paths` / `changed_line_ranges` the orchestrator was
 * previously fed empty. The activity fetches the PR's changed files from GitHub
 * (`GET /repos/{owner}/{repo}/pulls/{n}/files`, paginated — handled inside the ported
 * {@link GitHubApiClient.getPullRequestFiles}), normalises each entry into a {@link PrFileV1},
 * parses each file's `patch` into post-image hunk ranges via {@link parseUnifiedDiffRanges}, upserts
 * the rows through the {@link PrFilesRepoPort}, and returns the typed
 * {@link PrFilesEnrichmentResultV1} (file list + per-file ranges + truncation marker) capped at
 * {@link MAX_FILES_PER_ENRICHMENT}.
 *
 * ## GATE COLLAPSE (enrich-pr-files-v2 is collapse-on)
 *
 * The frozen v2 source dropped the `pr_files_v1` / `is_enabled` short-circuit (2026-05-24
 * drop-rollout-flags commit 3) — the activity ALWAYS attempts the fetch when dispatched. The TS port
 * mirrors that: there is NO `is_enabled` constructor seam, and the v1 legacy holder (the `int`-return
 * `enrich_pr_files_activity`) is NOT ported (the workflow body dispatches v2 only). The
 * `workflow.patched("enrich-pr-files-v2")` gate is a workflow-body concern that is collapsed-on; this
 * activity is the live entry point.
 *
 * ## Behaviour (1:1 with `enrich_pr_files_v2`)
 *
 *  - Empty GitHub result → `{ files: [], changed_line_ranges: {}, truncated_at: null }`; no upsert.
 *  - `unchanged` status → skipped (no file, no range). `changed` → coerced to `modified`. Unknown
 *    status → skipped with a WARN (future GitHub API drift surfaces in the log).
 *  - Per-file malformed-patch errors degrade to "no ranges for that file" — the file is still
 *    persisted; other files still contribute their ranges.
 *  - null `patch` → the file is persisted but contributes no ranges (renamed/copied with no content
 *    edit, or a binary file).
 *  - File-count cap: > {@link MAX_FILES_PER_ENRICHMENT} envelopes → the first N are processed and
 *    `truncated_at` is set to N (the mass-rename PayloadTooLargeError guard).
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime (NOT the workflow sandbox): real I/O (the GitHub HTTP
 * round-trip + the shared-pool repo) is available here. The Temporal activity wrapper
 * {@link enrichPrFilesV2} resolves the DSN + the numeric GitHub installation id from the environment
 * and constructs the production client (Vault deferred-token provider over the shared GitHub HTTP
 * transport — the SAME wiring pattern as `post_review_results.activity.ts`); the pure state machine
 * {@link doEnrichPrFiles} takes the GitHub/repo/clock seams INJECTED so unit + cassette tests drive
 * it with test doubles. The Workflow phase wires the dispatch — this file does NOT touch the workflow
 * body, registry, ports, or orchestrator.
 */

import { type Clock, WallClock } from "#platform/clock.js";

import { type PullRequestFileEnvelopeV1 } from "#backend/integrations/github/api_client.js";
import {
  FetchGitHubHttpClient,
  GitHubApiClient,
} from "#backend/integrations/github/api_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import {
  type PrFilesRepoPort,
  PostgresPrFilesRepo,
  derivePrFileId,
} from "#backend/domain/repos/pr_files_repo.js";
import { parseUnifiedDiffRanges } from "#backend/integrations/github/unified_diff_parser.js";

import { EnrichPrFilesInputV1 } from "#contracts/enrich_pr_files_input.v1.js";
import { type PrFileStatus, PrFileV1 } from "#contracts/pr_file.v1.js";
import {
  type HunkRange,
  PrFilesEnrichmentResultV1,
} from "#contracts/pr_files_enrichment.v1.js";

// ─── constants (1:1 with the frozen Python module constants) ──────────────────────────────────────

/**
 * GitHub's PR Files API returns up to ~3000 entries for mass-rename or generated-file commits. Each
 * {@link PrFileV1} (~200 bytes) + per-file ranges (~50 bytes avg) puts the Temporal payload
 * comfortably under the 2 MB default at 500 files. 1:1 with the Python `MAX_FILES_PER_ENRICHMENT`.
 * Bumping requires measuring real payload sizes against Temporal's configured limit AND confirming the
 * orchestrator's downstream caps still bind the user-visible output.
 */
export const MAX_FILES_PER_ENRICHMENT = 500;

// ─── GitHub-client port (1:1 with the frozen `GitHubPrFilesPort`) ─────────────────────────────────

/**
 * The slice of the GitHub API client the activity consumes. 1:1 with the Python `GitHubPrFilesPort`
 * Protocol. The production {@link GitHubApiClient.getPullRequestFiles} is adapted onto this shape in
 * {@link enrichPrFilesV2} (it takes `prNumber`/`installationId`; this port keeps the Python keyword
 * names so the unit/cassette doubles mirror the frozen `_FakeGitHub`).
 */
export type GitHubPrFilesPort = {
  getPullRequestFiles(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    installationUuid?: string;
  }): Promise<Array<PullRequestFileEnvelopeV1>>;
};

// ─── status normalisation (1:1 with the frozen `_normalize_status`) ───────────────────────────────

/**
 * Map a GitHub API status string to the contract's {@link PrFileStatus}, or `null` when the row
 * should be skipped. 1:1 with the Python `_normalize_status`:
 *
 *  - `added/removed/modified/renamed/copied` → returned verbatim.
 *  - `changed` → coerced to `modified` (the diff DID modify the file).
 *  - `unchanged` → `null` (no actual change to record).
 *  - anything else → `null` + a WARN (future GitHub API drift surfaces in the activity log).
 */
export function normalizeStatus(raw: string): PrFileStatus | null {
  if (
    raw === "added" ||
    raw === "removed" ||
    raw === "modified" ||
    raw === "renamed" ||
    raw === "copied"
  ) {
    return raw;
  }
  if (raw === "changed") {
    return "modified";
  }
  if (raw === "unchanged") {
    return null;
  }
  console.warn(`enrich_pr_files: unknown GitHub status ${JSON.stringify(raw)}; skipping row`);
  return null;
}

// ─── the pure state machine ───────────────────────────────────────────────────────────────────────

/** Dependencies injected into {@link doEnrichPrFiles} (production wires these; tests stub them). */
export type DoEnrichPrFilesDeps = {
  /** The GitHub PR-files client slice (production: an adapter over {@link GitHubApiClient}). */
  github: GitHubPrFilesPort;
  /** The `core.pr_files` repo (production: {@link PostgresPrFilesRepo}). */
  repo: PrFilesRepoPort;
  /** The clock seam — the persisted `created_at` is `clock.now()` (Clock-and-Random Protocol). */
  clock: Clock;
};

/**
 * Fetch + persist + return the file manifest for one PR. The pure state machine behind the activity;
 * 1:1 with the frozen `EnrichPrFilesActivityV2.enrich_pr_files_v2`. The GitHub/repo/clock seams are
 * injected so unit + cassette tests drive it without a live GitHub or a Temporal worker.
 */
export async function doEnrichPrFiles(
  input: EnrichPrFilesInputV1,
  deps: DoEnrichPrFilesDeps,
): Promise<PrFilesEnrichmentResultV1> {
  const {
    installation_id: installationIdUuid,
    github_installation_id: installationIdInt,
    repository_id: repositoryId,
    pr_id: prId,
    gh_owner: owner,
    gh_repo_name: repo,
    pr_number: prNumber,
  } = input;

  let envelopes = await deps.github.getPullRequestFiles({
    installationId: installationIdInt,
    owner,
    repo,
    prNumber,
    installationUuid: installationIdUuid,
  });

  let truncatedAt: number | null = null;
  if (envelopes.length > MAX_FILES_PER_ENRICHMENT) {
    console.warn(
      `enrich_pr_files_v2: PR has ${envelopes.length} files; capping at ` +
        `${MAX_FILES_PER_ENRICHMENT} (event=enrich_pr_files_v2.truncated original_count=` +
        `${envelopes.length} cap=${MAX_FILES_PER_ENRICHMENT})`,
    );
    envelopes = envelopes.slice(0, MAX_FILES_PER_ENRICHMENT);
    truncatedAt = MAX_FILES_PER_ENRICHMENT;
  }

  const files: Array<PrFileV1> = [];
  // Prototype-null map: GitHub-supplied file paths are UNTRUSTED keys. A plain `{}` would let an
  // exotic path like "__proto__" shadow the prototype slot; `Object.create(null)` has no prototype, so
  // every path is a pure own-property write — faithful to the Python plain-dict assignment (Python
  // dicts have no prototype-pollution surface) AND prototype-pollution-safe in JS. The result is
  // re-validated by `PrFilesEnrichmentResultV1.parse` (a strict `z.record`) before return.
  const changedLineRanges: Record<string, Array<HunkRange>> = Object.create(null) as Record<
    string,
    Array<HunkRange>
  >;
  const now = deps.clock.now();

  for (const env of envelopes) {
    const status = normalizeStatus(env.status);
    if (status === null) {
      continue;
    }
    const filePath = env.filename;
    files.push(
      PrFileV1.parse({
        schema_version: 1,
        pr_file_id: derivePrFileId({ prId, filePath }),
        pr_id: prId,
        installation_id: installationIdUuid,
        repository_id: repositoryId,
        file_path: filePath,
        status,
        additions: Math.max(0, env.additions),
        deletions: Math.max(0, env.deletions),
        previous_path: null,
        language: null,
        created_at: now.toISOString(),
      }),
    );
    if (env.patch === null) {
      continue;
    }
    let ranges: Array<HunkRange>;
    try {
      ranges = parseUnifiedDiffRanges(env.patch);
    } catch (e) {
      console.warn(
        `enrich_pr_files_v2: malformed patch for ${filePath}; skipping ranges ` +
          `(event=enrich_pr_files_v2.patch_parse_failed file_path=${filePath} ` +
          `error=${e instanceof Error ? e.message : String(e)})`,
      );
      continue;
    }
    if (ranges.length > 0) {
      // eslint-disable-next-line security/detect-object-injection -- write-only into a null-prototype object (Object.create(null) above); the GitHub-supplied `filePath` is a pure own-property write with no prototype-chain read or pollution surface
      changedLineRanges[filePath] = ranges;
    }
  }

  if (files.length > 0) {
    await deps.repo.upsertFiles({
      prId,
      installationId: installationIdUuid,
      repositoryId,
      files,
    });
  }

  return PrFilesEnrichmentResultV1.parse({
    schema_version: 1,
    files,
    changed_line_ranges: changedLineRanges,
    truncated_at: truncatedAt,
  });
}

// ─── Temporal activity entry point ─────────────────────────────────────────────────────────────────

/**
 * Adapt the production {@link GitHubApiClient} onto the {@link GitHubPrFilesPort} the activity
 * consumes. The client's paginated `getPullRequestFiles({ installationId, owner, repo, prNumber })`
 * IS the `GET .../pulls/{n}/files` round-trip; this wrapper maps the port's keyword names onto it.
 */
function gitHubPrFilesAdapter(api: GitHubApiClient): GitHubPrFilesPort {
  return {
    getPullRequestFiles: async ({ installationId, owner, repo, prNumber }) =>
      api.getPullRequestFiles({ installationId, owner, repo, prNumber }),
  };
}

/**
 * The registered `enrich_pr_files_activity_v2` Temporal activity (single typed-input envelope per
 * CLAUDE.md invariant 11). Resolves the DSN from `CODEMASTER_PG_CORE_DSN` + the numeric GitHub
 * installation id from `CODEMASTER_GITHUB_INSTALLATION_ID`, constructs the production
 * {@link GitHubApiClient} (Vault deferred-token provider over the shared GitHub HTTP transport — the
 * SAME wiring as `post_review_results`), builds the shared-pool {@link PostgresPrFilesRepo}, and
 * delegates to the pure {@link doEnrichPrFiles}. 1:1 in intent with the frozen Python
 * `EnrichPrFilesActivityV2.enrich_pr_files_v2`.
 */
export async function enrichPrFilesV2(
  input: EnrichPrFilesInputV1,
): Promise<PrFilesEnrichmentResultV1> {
  const parsed = EnrichPrFilesInputV1.parse(input);
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot run the enrich_pr_files_activity_v2 persistence",
    );
  }
  // Per-review routing: the files-fetch is scoped to the input's `github_installation_id` (used by
  // `doEnrichPrFiles` for the GitHub client) — no pod-wide env read. The contract requires it (non-null).
  const clock = new WallClock();
  // One GitHub HTTP transport shared by the token-provider's JWT→installation-token mint AND the
  // GitHubApiClient's files calls (mirrors the frozen-Python worker passing one `_http_client` to both).
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  const repo = PostgresPrFilesRepo.fromDsn({ dsn, clock });

  return doEnrichPrFiles(parsed, { github: gitHubPrFilesAdapter(api), repo, clock });
}
