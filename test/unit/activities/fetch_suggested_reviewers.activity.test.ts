/**
 * Unit tests for the `fetchSuggestedReviewers` activity — the 1:1 port of the frozen Python
 * `codemaster/activities/fetch_suggested_reviewers.py::FetchSuggestedReviewersActivity.fetch_suggested_reviewers`
 * (S23.AR.3 / B5 producer).
 *
 * The activity reads the PR's changed file paths from `core.pr_files`, the CODEOWNERS rules from
 * `core.code_owners`, and ranks the top-N reviewer logins via `rankSuggestedReviewers`. Gated on an
 * injected `isEnabled` callable (the `code_owners_v1` flag in production). The empty-output cases all
 * return `[]` cleanly:
 *   - flag off,
 *   - no PR files,
 *   - no CODEOWNERS rules,
 *   - no rule matches any file.
 *
 * Ports are in-memory fakes. No GitHub call (the activity is pure DB + ranking).
 */

import { describe, it, expect } from "vitest";

import { FetchSuggestedReviewersActivity } from "#backend/activities/fetch_suggested_reviewers.activity.js";
import type { CodeOwnerRule } from "#backend/domain/repos/code_owners_repo.js";
import type { PrFilesRepoPort } from "#backend/domain/repos/pr_files_repo.js";
import type { CodeOwnersListPort } from "#backend/activities/fetch_suggested_reviewers.activity.js";

import { FakeClock } from "#platform/clock.js";

import type { FetchSuggestedReviewersInputV1 } from "#contracts/fetch_suggested_reviewers_input.v1.js";

const IID = "11111111-1111-1111-1111-111111111111";
const REPO = "22222222-2222-2222-2222-222222222222";
const PR = "33333333-3333-3333-3333-333333333333";

function input(): FetchSuggestedReviewersInputV1 {
  return { schema_version: 1, installation_id: IID, repository_id: REPO, pr_id: PR };
}

function rule(path_pattern: string, ...owner_logins: Array<string>): CodeOwnerRule {
  return { path_pattern, owner_logins, line_number: 0 };
}

/** In-memory pr_files repo (only `listFilePathsForPr` is exercised). */
function fakePrFiles(paths: ReadonlyArray<string>): PrFilesRepoPort {
  return {
    async upsertFiles() {
      await Promise.resolve();
      return 0;
    },
    async listFilePathsForPr() {
      await Promise.resolve();
      return paths;
    },
  };
}

/** In-memory code_owners repo (only `listRulesForRepository` is exercised). */
function fakeCodeOwners(rules: ReadonlyArray<CodeOwnerRule>): CodeOwnersListPort {
  return {
    async listRulesForRepository() {
      await Promise.resolve();
      return rules;
    },
  };
}

function activity(args: {
  paths: ReadonlyArray<string>;
  rules: ReadonlyArray<CodeOwnerRule>;
  enabled?: boolean;
  topN?: number;
}): FetchSuggestedReviewersActivity {
  return new FetchSuggestedReviewersActivity({
    prFilesRepo: fakePrFiles(args.paths),
    codeOwnersRepo: fakeCodeOwners(args.rules),
    isEnabled: async () => {
      await Promise.resolve();
      return args.enabled ?? true;
    },
    clock: new FakeClock(),
    ...(args.topN !== undefined ? { topN: args.topN } : {}),
  });
}

describe("FetchSuggestedReviewersActivity", () => {
  it("returns [] without I/O when the feature flag is disabled", async () => {
    let prFilesRead = false;
    const a = new FetchSuggestedReviewersActivity({
      prFilesRepo: {
        async upsertFiles() {
          await Promise.resolve();
          return 0;
        },
        async listFilePathsForPr() {
          await Promise.resolve();
          prFilesRead = true;
          return ["a.py"];
        },
      },
      codeOwnersRepo: fakeCodeOwners([rule("*.py", "@a")]),
      isEnabled: async () => {
        await Promise.resolve();
        return false;
      },
      clock: new FakeClock(),
    });
    expect(await a.fetchSuggestedReviewers(input())).toEqual([]);
    // Flag-off short-circuits BEFORE any DB read.
    expect(prFilesRead).toBe(false);
  });

  it("returns [] when the PR has no changed files", async () => {
    const a = activity({ paths: [], rules: [rule("*.py", "@a")] });
    expect(await a.fetchSuggestedReviewers(input())).toEqual([]);
  });

  it("returns [] when the repo has no CODEOWNERS rules", async () => {
    const a = activity({ paths: ["a.py"], rules: [] });
    expect(await a.fetchSuggestedReviewers(input())).toEqual([]);
  });

  it("returns [] when no rule matches any changed file", async () => {
    const a = activity({ paths: ["a.py"], rules: [rule("*.ts", "@a")] });
    expect(await a.fetchSuggestedReviewers(input())).toEqual([]);
  });

  it("ranks matched CODEOWNERS reviewers top-N (count DESC, alpha tie-break, @ stripped)", async () => {
    const a = activity({
      paths: ["a.py", "b.ts"],
      rules: [rule("*", "@bob"), rule("*.py", "@alice")],
    });
    // @bob matches both files (2), @alice matches one (.py). bob first.
    expect(await a.fetchSuggestedReviewers(input())).toEqual(["bob", "alice"]);
  });

  it("honours an explicit topN override", async () => {
    const a = activity({
      paths: ["a.py"],
      rules: [rule("*.py", "@a", "@b", "@c")],
      topN: 2,
    });
    expect(await a.fetchSuggestedReviewers(input())).toEqual(["a", "b"]);
  });
});
