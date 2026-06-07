/**
 * `postCheckRun` activity — Phase-2.1 core-loop activity #5 port. 1:1 in intent with the frozen Python
 * `@activity.defn post_check_run` + `_do_post_check_run`
 * (vendor/codemaster-py/codemaster/activities/post_check_run.py): post a `codemaster/review` GitHub
 * check-run alongside every review so PR authors see a status indicator next to the merge button even
 * when there are zero findings.
 *
 * ## Conclusion is ALWAYS "neutral" (CLAUDE.md invariant 9)
 *
 * codemaster is advisory and NEVER blocks a merge — the bot can flag issues but cannot fail status. The
 * `conclusion` is pinned to `"neutral"` both in the {@link GhCheckRunClient} type (the `"neutral"`
 * literal) and at every call site below.
 *
 * ## Idempotent find→update/create
 *
 * If a check-run with the same name (`codemaster/review`) already exists at the same head SHA, the
 * activity UPDATEs it in place (one rolling run) rather than creating a duplicate. GitHub permits
 * multiple same-name runs, but maintaining one keeps the PR UI clean. The byte-significant logic is the
 * {@link doPostCheckRun} decision: validate non-empty summary + head_sha (else throw); look up the
 * existing run; PATCH-or-POST; return `{check_run_id, was_update}`.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with FIVE positional arguments
 * (`post_check_run(pr_meta, head_sha, summary, owner, repo_name)`) — an invariant-11 violation, sibling
 * to the classify_files / aggregate_findings 2-positional dispatches. This port CLOSES it: the single
 * positional input is the {@link PostCheckRunInputV1} envelope. There is no Python Pydantic counterpart
 * for the envelope — it is introduced during the port.
 *
 * ## Pure logic vs. real wiring (the stub-vs-real test split)
 *
 * {@link doPostCheckRun} is the pure `_do_post_check_run` orchestration with the {@link GhCheckRunClient}
 * INJECTED — the Tier-1 parity oracle drives it against the frozen Python over a scripted STUB client, so
 * the find→update/create LOGIC is byte-verifiable WITHOUT any real GitHub round-trip. {@link postCheckRun}
 * is the registered activity that constructs the REAL {@link GitHubApiCheckRunClient} over a
 * {@link GitHubApiClient} (Vault token provider + env installation id), mirroring the frozen-Python worker
 * wiring (`_post_check_run_activity = PostCheckRunActivity(gh_client=GhCheckRunHttpClient(api=github_client,
 * installation_id=github_installation_id))`). Like the sibling activities, the real client is CONSTRUCTED
 * but not invoked during the skeleton BUILD (no live GitHub / Vault); the REST round-trips are covered by
 * the recording-stub test against the GitHubApiClient transport.
 */

import { FetchGitHubHttpClient, GitHubApiClient } from "#backend/integrations/github/api_client.js";
import {
  CHECK_RUN_NAME,
  GitHubApiCheckRunClient,
  type CheckRunStatus,
  type GhCheckRunClient,
} from "#backend/integrations/github/check_run_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";

import { WallClock } from "#platform/clock.js";

import type { PostCheckRunInputV1, PostedCheckRunV1 } from "#contracts/posted_check_run.v1.js";

/**
 * The `_do_post_check_run` orchestration, ported EXACTLY:
 *
 *   if not summary:  throw  "summary must be non-empty"
 *   if not headSha:  throw  "head_sha must be set"
 *   existing = findExistingCheckRun(owner, repo=repoName, head_sha=headSha, name=CHECK_RUN_NAME)
 *   if existing != null:
 *     updateCheckRun(owner, repo=repoName, check_run_id=existing, status, conclusion="neutral", summary)
 *     return { check_run_id: existing, was_update: true }
 *   newId = createCheckRun(owner, repo=repoName, head_sha=headSha, name=CHECK_RUN_NAME, status,
 *                          conclusion="neutral", summary)
 *   return { check_run_id: newId, was_update: false }
 *
 * The {@link GhCheckRunClient} is INJECTED so the parity oracle drives the same orchestration the activity
 * runs (mirrors the frozen Python exporting `_do_post_check_run` from the activity module). `status`
 * defaults to "completed" (1:1 with the Python default); `conclusion` is ALWAYS "neutral".
 */
export async function doPostCheckRun({
  prMeta,
  headSha,
  summary,
  owner,
  repoName,
  ghClient,
  status = "completed",
}: {
  prMeta: PostCheckRunInputV1["pr_meta"];
  headSha: string;
  summary: string;
  owner: string;
  repoName: string;
  ghClient: GhCheckRunClient;
  status?: CheckRunStatus;
}): Promise<PostedCheckRunV1> {
  // `prMeta` is carried in the signature to mirror the frozen Python `_do_post_check_run(pr_meta, ...)`
  // (and the workflow-body dispatch shape), but the byte-significant logic does NOT read it — the
  // check-run targets owner/repo/head_sha directly. Mark it intentionally-unread (1:1 with the Python,
  // which threads `pr_meta` through unchanged) rather than dropping it from the contract-shaped args.
  void prMeta;
  // The empty-string checks live HERE (not in the contract) so they raise as the Python ValueError does,
  // and so the parity oracle's "empty summary / empty head_sha → raises" cases byte-match.
  if (summary === "") {
    throw new Error("summary must be non-empty");
  }
  if (headSha === "") {
    throw new Error("head_sha must be set");
  }

  const existing = await ghClient.findExistingCheckRun({
    owner,
    repo: repoName,
    headSha,
    name: CHECK_RUN_NAME,
  });
  if (existing !== null) {
    await ghClient.updateCheckRun({
      owner,
      repo: repoName,
      checkRunId: existing,
      status,
      conclusion: "neutral",
      summary,
    });
    return { schema_version: 1, check_run_id: existing, was_update: true };
  }

  const newId = await ghClient.createCheckRun({
    owner,
    repo: repoName,
    headSha,
    name: CHECK_RUN_NAME,
    status,
    conclusion: "neutral",
    summary,
  });
  return { schema_version: 1, check_run_id: newId, was_update: false };
}

/**
 * The registered activity. Takes the single typed {@link PostCheckRunInputV1} envelope (invariant 11),
 * constructs the REAL {@link GitHubApiCheckRunClient} over a {@link GitHubApiClient} (Vault token provider
 * + the per-review numeric installation id from the input), and delegates to {@link doPostCheckRun}.
 * Per-review routing (replaces the removed `CODEMASTER_GITHUB_INSTALLATION_ID` env pin): ONE token provider
 * → ONE GitHubApiClient → wrapped in the check-run client at the input's installation id.
 */
export async function postCheckRun(input: PostCheckRunInputV1): Promise<PostedCheckRunV1> {
  // Per-review routing: the numeric installation id comes from the input. Defensive null guard — the
  // check-run posts only after a successful clone (which fail-closes on null), so this should never fire.
  const installationId = input.github_installation_id;
  if (installationId === null) {
    throw new Error(
      "github_installation_id is null in the post_check_run input — cannot post without a per-review " +
        "installation id (per-review routing).",
    );
  }
  const clock = new WallClock();
  // One GitHub HTTP transport shared by the token-provider's JWT→installation-token mint AND the
  // GitHubApiClient's check-run calls (mirrors the frozen-Python worker passing one `_http_client` to
  // both). Vault is read via its own env-built transport (VaultHttpPort.fromEnv constructs the inner
  // FetchVaultHttpClient itself).
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({
    vault,
    http: githubHttp,
    clock,
  });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  const ghClient = new GitHubApiCheckRunClient({ api, installationId });

  return doPostCheckRun({
    prMeta: input.pr_meta,
    headSha: input.head_sha,
    summary: input.summary,
    owner: input.owner,
    repoName: input.repo_name,
    ghClient,
  });
}
