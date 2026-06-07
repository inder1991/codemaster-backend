/**
 * Unit tests for the `enrich_pr_files_activity_v2` port — `doEnrichPrFiles` (the pure state machine
 * with injected GitHub-client + repo + clock seams). 1:1 in intent with the frozen Python
 * `tests/unit/activities/test_enrich_pr_files_v2.py`, RE-TARGETED onto the collapse-on (v2-only,
 * no-flag) source per the GATE COLLAPSE rule: the frozen `enrich_pr_files_v2.py` dropped the
 * `is_enabled` short-circuit (2026-05-24 drop-rollout-flags commit 3), so the "flag off" test is
 * intentionally NOT ported — the activity ALWAYS attempts the fetch.
 *
 * Coverage (every byte-significant branch of `enrich_pr_files_v2`):
 *   - happy path: fetch → persist → typed result with per-file post-image ranges.
 *   - `unchanged` status row skipped (no file, no upsert).
 *   - null `patch` skipped for ranges but the file IS persisted.
 *   - malformed patch degrades to "no ranges for THAT file only" (other files survive).
 *   - file-count cap: > MAX_FILES_PER_ENRICHMENT envelopes → first N processed, truncated_at=N.
 *   - empty GitHub result → empty typed result, no upsert.
 *   - `changed` coerced to `modified`; `removed` retained.
 */

import { describe, it, expect, vi } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  type GitHubPrFilesPort,
  MAX_FILES_PER_ENRICHMENT,
  doEnrichPrFiles,
} from "#backend/activities/enrich_pr_files.activity.js";
import { type PrFilesRepoPort } from "#backend/domain/repos/pr_files_repo.js";

import { type PullRequestFileEnvelopeV1 } from "#backend/integrations/github/api_client.js";
import { type EnrichPrFilesInputV1 } from "#contracts/enrich_pr_files_input.v1.js";
import { type PrFileV1 } from "#contracts/pr_file.v1.js";

const FIXED_NOW = new Date("2026-05-15T12:00:00.000Z");

const INSTALLATION_UUID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "22222222-2222-4222-8222-222222222222";
const PR_ID = "33333333-3333-4333-8333-333333333333";

function input(): EnrichPrFilesInputV1 {
  return {
    schema_version: 1,
    installation_id: INSTALLATION_UUID,
    github_installation_id: 1,
    repository_id: REPOSITORY_ID,
    pr_id: PR_ID,
    gh_owner: "o",
    gh_repo_name: "r",
    pr_number: 1,
  };
}

/** A GitHub-client test-double returning a scripted envelope list (mirrors the frozen `_FakeGitHub`). */
function fakeGitHub(envelopes: ReadonlyArray<PullRequestFileEnvelopeV1>): {
  github: GitHubPrFilesPort;
  calls: () => number;
} {
  let n = 0;
  const github: GitHubPrFilesPort = {
    getPullRequestFiles: async () => {
      await Promise.resolve();
      n += 1;
      return [...envelopes];
    },
  };
  return { github, calls: () => n };
}

/** A repo test-double recording the upsert (mirrors the frozen `_FakeRepo`'s AsyncMock). */
function fakeRepo(): {
  repo: PrFilesRepoPort;
  upsert: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => {
    await Promise.resolve();
    return 0;
  });
  const repo: PrFilesRepoPort = {
    upsertFiles: upsert as unknown as PrFilesRepoPort["upsertFiles"],
    listFilePathsForPr: async () => {
      await Promise.resolve();
      return [];
    },
  };
  return { repo, upsert };
}

function envelope(
  filename: string,
  patch: string | null,
  opts: { status?: PullRequestFileEnvelopeV1["status"]; additions?: number; deletions?: number } = {},
): PullRequestFileEnvelopeV1 {
  const additions = opts.additions ?? 1;
  const deletions = opts.deletions ?? 0;
  return {
    filename,
    status: opts.status ?? "modified",
    additions,
    deletions,
    changes: additions + deletions,
    patch,
  };
}

describe("doEnrichPrFiles — happy path", () => {
  it("fetches, persists, and returns per-file post-image ranges", async () => {
    const { github } = fakeGitHub([
      envelope("foo.py", "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", { status: "added", additions: 3 }),
    ]);
    const { repo, upsert } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.file_path).toBe("foo.py");
    expect(result.files[0]!.status).toBe("added");
    expect(result.files[0]!.additions).toBe(3);
    expect(result.changed_line_ranges).toEqual({ "foo.py": [[1, 3]] });
    expect(result.truncated_at).toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("doEnrichPrFiles — status normalisation", () => {
  it("skips an `unchanged` status row (no file, no upsert)", async () => {
    const { github } = fakeGitHub([
      envelope("noop.py", null, { status: "unchanged", additions: 0 }),
    ]);
    const { repo, upsert } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    expect(result.files).toEqual([]);
    expect(result.changed_line_ranges).toEqual({});
    expect(upsert).not.toHaveBeenCalled();
  });

  it("coerces `changed` → `modified` and retains `removed`", async () => {
    const { github } = fakeGitHub([
      envelope("a.py", null, { status: "changed" }),
      envelope("b.py", null, { status: "removed" }),
    ]);
    const { repo } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    const byPath = new Map<string, PrFileV1>(result.files.map((f) => [f.file_path, f]));
    expect(byPath.get("a.py")!.status).toBe("modified");
    expect(byPath.get("b.py")!.status).toBe("removed");
  });
});

describe("doEnrichPrFiles — patch handling", () => {
  it("persists a file with a null patch but emits no ranges for it", async () => {
    const { github } = fakeGitHub([envelope("moved.py", null, { status: "renamed" })]);
    const { repo } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    expect(result.files).toHaveLength(1);
    expect("moved.py" in result.changed_line_ranges).toBe(false);
  });

  it("drops to empty ranges for a malformed-patch file ONLY (others survive)", async () => {
    const { github } = fakeGitHub([
      envelope("bad.py", "@@ malformed @@\n+x\n"),
      envelope("good.py", "@@ -0,0 +1,2 @@\n+a\n+b\n", { additions: 2 }),
    ]);
    const { repo } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    expect("bad.py" in result.changed_line_ranges).toBe(false);
    expect(result.changed_line_ranges["good.py"]).toEqual([[1, 2]]);
    // Both files are still persisted (the parse failure only drops ranges, not the row).
    expect(result.files.map((f) => f.file_path).sort()).toEqual(["bad.py", "good.py"]);
  });
});

describe("doEnrichPrFiles — empty + cap", () => {
  it("returns an empty typed result and does NOT upsert when GitHub returns no files", async () => {
    const { github } = fakeGitHub([]);
    const { repo, upsert } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    expect(result.files).toEqual([]);
    expect(result.changed_line_ranges).toEqual({});
    expect(result.truncated_at).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("caps at MAX_FILES_PER_ENRICHMENT and records truncated_at", async () => {
    const envelopes: Array<PullRequestFileEnvelopeV1> = [];
    for (let i = 0; i < MAX_FILES_PER_ENRICHMENT + 50; i += 1) {
      envelopes.push(envelope(`f${i}.py`, `@@ -0,0 +${i + 1},1 @@\n+x\n`));
    }
    const { github } = fakeGitHub(envelopes);
    const { repo } = fakeRepo();
    const result = await doEnrichPrFiles(input(), {
      github,
      repo,
      clock: new FakeClock({ now: FIXED_NOW }),
    });

    expect(result.files).toHaveLength(MAX_FILES_PER_ENRICHMENT);
    expect(result.truncated_at).toBe(MAX_FILES_PER_ENRICHMENT);
  });
});
