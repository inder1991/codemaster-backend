/**
 * Cassette round-trip for `enrich_pr_files_activity_v2`: drive the REAL ported {@link GitHubApiClient}
 * (paginated `GET /repos/{owner}/{repo}/pulls/{n}/files` over the deterministic {@link
 * CassetteHttpClient} replay double — NO live GitHub) adapted onto the {@link GitHubPrFilesPort}, with
 * an in-memory repo double, through the pure {@link doEnrichPrFiles}. This exercises the full
 * files-fetch (multi-page pagination via the `Link: rel="next"` header) + the real unified-diff hunk
 * parse end-to-end against recorded GitHub response shapes across every status the activity handles:
 * added / modified(multi-hunk) / renamed(with content edit) / removed / binary(null patch) /
 * changed(→ coerced to modified) / unchanged(→ skipped).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { CassetteHttpClient } from "#backend/infra/cassettes.js";

import {
  GitHubApiClient,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";
import {
  type GitHubPrFilesPort,
  doEnrichPrFiles,
} from "#backend/activities/enrich_pr_files.activity.js";
import { type PrFilesRepoPort } from "#backend/domain/repos/pr_files_repo.js";

import { type EnrichPrFilesInputV1 } from "#contracts/enrich_pr_files_input.v1.js";
import { type PrFileV1 } from "#contracts/pr_file.v1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/integration/activities -> test/cassettes/github
const GH_CASSETTES = resolve(HERE, "..", "..", "cassettes", "github");

const FIXED_NOW = new Date("2026-06-06T12:00:00.000Z");
const INSTALLATION_UUID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "22222222-2222-4222-8222-222222222222";
const PR_ID = "33333333-3333-4333-8333-333333333333";

const constantTokenProvider: TokenProvider = async () => {
  await Promise.resolve();
  return "ghs-test-token";
};

/** Adapt the production GitHubApiClient onto the port the activity consumes (same as the activity's). */
function adapter(api: GitHubApiClient): GitHubPrFilesPort {
  return {
    getPullRequestFiles: async ({ installationId, owner, repo, prNumber }) =>
      api.getPullRequestFiles({ installationId, owner, repo, prNumber }),
  };
}

/** An in-memory repo double that records the rows handed to `upsertFiles`. */
function recordingRepo(): {
  repo: PrFilesRepoPort;
  persisted: () => ReadonlyArray<PrFileV1>;
  upsertCalls: () => number;
} {
  let rows: ReadonlyArray<PrFileV1> = [];
  let calls = 0;
  const repo: PrFilesRepoPort = {
    upsertFiles: async ({ files }) => {
      await Promise.resolve();
      calls += 1;
      rows = [...files];
      return files.length;
    },
    listFilePathsForPr: async () => {
      await Promise.resolve();
      return [];
    },
  };
  return { repo, persisted: () => rows, upsertCalls: () => calls };
}

function input(): EnrichPrFilesInputV1 {
  return {
    schema_version: 1,
    installation_id: INSTALLATION_UUID,
    github_installation_id: 4242,
    repository_id: REPOSITORY_ID,
    pr_id: PR_ID,
    gh_owner: "acme",
    gh_repo_name: "widgets",
    pr_number: 7,
  };
}

describe("enrich_pr_files_activity_v2 — cassette round-trip (files-fetch + hunk parse)", () => {
  it("paginates, normalises statuses, parses hunks, persists, and returns the typed result", async () => {
    const http = CassetteHttpClient.fromPath(resolve(GH_CASSETTES, "enrich_pr_files_round_trip.yaml"));
    const clock = new FakeClock({ now: FIXED_NOW });
    const api = new GitHubApiClient({ tokenProvider: constantTokenProvider, http, clock });
    const { repo, persisted, upsertCalls } = recordingRepo();

    const result = await doEnrichPrFiles(input(), { github: adapter(api), repo, clock });

    // Both cassette pages were consumed (pagination via rel="next").
    http.assertFullyConsumed();

    // `unchanged` (whitespace_only.py) was skipped; the other 6 files are persisted.
    const paths = result.files.map((f) => f.file_path).sort();
    expect(paths).toEqual([
      "assets/logo.png",
      "src/added_file.py",
      "src/modified_multi_hunk.py",
      "src/removed_file.py",
      "src/renamed_with_edit.py",
      "src/touched.py",
    ]);

    const byPath = new Map<string, PrFileV1>(result.files.map((f) => [f.file_path, f]));
    // `changed` was coerced to `modified`; `removed`/`renamed`/`added` retained verbatim.
    expect(byPath.get("src/touched.py")!.status).toBe("modified");
    expect(byPath.get("src/removed_file.py")!.status).toBe("removed");
    expect(byPath.get("src/renamed_with_edit.py")!.status).toBe("renamed");
    expect(byPath.get("src/added_file.py")!.status).toBe("added");
    // created_at came from the injected clock (Clock-and-Random Protocol).
    expect(byPath.get("src/added_file.py")!.created_at).toBe(FIXED_NOW.toISOString());

    // Per-file post-image hunk ranges parsed from the real patches.
    expect(result.changed_line_ranges["src/added_file.py"]).toEqual([[1, 4]]);
    // Multi-hunk: two ranges, sorted ascending.
    expect(result.changed_line_ranges["src/modified_multi_hunk.py"]).toEqual([
      [5, 7],
      [30, 30],
    ]);
    expect(result.changed_line_ranges["src/renamed_with_edit.py"]).toEqual([[1, 3]]);
    expect(result.changed_line_ranges["src/touched.py"]).toEqual([[10, 10]]);
    // Pure-deletion file contributes NO post-image range (and so is absent from the ranges record).
    expect("src/removed_file.py" in result.changed_line_ranges).toBe(false);
    // Binary file (null patch) is persisted but has no ranges.
    expect("assets/logo.png" in result.changed_line_ranges).toBe(false);

    expect(result.truncated_at).toBeNull();

    // The repo was handed exactly the persisted (post-skip) file set, once.
    expect(upsertCalls()).toBe(1);
    expect(persisted().map((f) => f.file_path).sort()).toEqual(paths);
  });
});
