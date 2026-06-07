// Unit tests for retrieval/pr_context_builder.ts — 1:1 with the frozen Python
// vendor/codemaster-py/tests/unit/review/test_pr_context_builder.py.
//
// Both helpers are pure data folds — no clock, no I/O, no random. The default classifier IS the real
// detection-pipeline `classify_files` (1:1 with Python's build_pr_context_full); the classification-flag
// parity itself is asserted in the Tier-1 parity suite (retrieval_hybrid_tier1.parity.test.ts). Here the
// classifier seam is covered by (a) a stub classifier proving injection threads through, and (b) the
// real default leaving a normal source file all-false. All fields are full Tier-1 parity vs frozen Python.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildPrContextFull,
  buildPrContextMvp,
  type PrContextClassifier,
  pickPrContext,
} from "#backend/retrieval/pr_context_builder.js";

import { type ChangedFile, type ManifestSnapshot, PRContext } from "#contracts/pr_context.v1.js";
import type { PrFileV1 } from "#contracts/pr_file.v1.js";
import type { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";

const NOW = "2026-05-27T12:00:00.000Z";

function prFile(args: { filePath: string; additions?: number; deletions?: number }): PrFileV1 {
  return {
    schema_version: 1,
    pr_file_id: randomUUID(),
    pr_id: randomUUID(),
    installation_id: randomUUID(),
    repository_id: randomUUID(),
    file_path: args.filePath,
    status: "modified",
    additions: args.additions ?? 0,
    deletions: args.deletions ?? 0,
    previous_path: null,
    language: null,
    created_at: NOW,
  };
}

function enrichment(files: ReadonlyArray<PrFileV1>): PrFilesEnrichmentResultV1 {
  return { schema_version: 1, files: [...files], changed_line_ranges: {}, truncated_at: null };
}

describe("buildPrContextFull", () => {
  it("returns null when enrichment is null (fail-open → caller uses MVP)", () => {
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: null,
    });
    expect(result).toBeNull();
  });

  it("empty enrichment yields an empty changed_files list", () => {
    const prId = randomUUID();
    const result = buildPrContextFull({
      prId,
      headSha: "b".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([]),
    });
    expect(result).not.toBeNull();
    expect(result!.pr_id).toBe(prId);
    expect(result!.head_sha).toBe("b".repeat(40));
    expect(result!.repo_default_branch).toBe("main");
    expect(result!.changed_files).toEqual([]);
    expect(result!.manifests).toEqual([]);
  });

  it("single file → one ChangedFile preserving path + additions + deletions", () => {
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "c".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py", additions: 10, deletions: 3 })]),
    });
    expect(result).not.toBeNull();
    expect(result!.changed_files.length).toBe(1);
    expect(result!.changed_files[0]!.path).toBe("src/main.py");
    expect(result!.changed_files[0]!.additions).toBe(10);
    expect(result!.changed_files[0]!.deletions).toBe(3);
  });

  it("multi file → preserves order + counts (detectors rely on first-touched semantics)", () => {
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "d".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([
        prFile({ filePath: "src/a.py", additions: 1, deletions: 2 }),
        prFile({ filePath: "src/b.py", additions: 3, deletions: 0 }),
        prFile({ filePath: "tests/test_a.py", additions: 5, deletions: 1 }),
        prFile({ filePath: "docs/README.md", additions: 0, deletions: 10 }),
      ]),
    });
    expect(result).not.toBeNull();
    expect(result!.changed_files.map((cf) => cf.path)).toEqual([
      "src/a.py",
      "src/b.py",
      "tests/test_a.py",
      "docs/README.md",
    ]);
    expect(result!.changed_files.map((cf) => [cf.additions, cf.deletions])).toEqual([
      [1, 2],
      [3, 0],
      [5, 1],
      [0, 10],
    ]);
  });

  it("default classifier (real classify_files) leaves a normal source file all-false + reason null", () => {
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "0".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py", additions: 10 })]),
    });
    expect(result).not.toBeNull();
    const cls = result!.changed_files[0]!.classification;
    expect(cls.is_generated).toBe(false);
    expect(cls.is_vendored).toBe(false);
    expect(cls.is_test).toBe(false);
    expect(cls.reason).toBeNull();
  });

  it("threads an injected classifier (Python's classify_files seam)", () => {
    // Stub classifier: flips is_test on any path under tests/, proving the injection seam threads
    // through even though the DEFAULT is now the real detection-pipeline classify_files.
    const markTests: PrContextClassifier = (ctx) =>
      PRContext.parse({
        ...ctx,
        changed_files: ctx.changed_files.map((cf): ChangedFile => {
          if (cf.path.startsWith("tests/")) {
            return { ...cf, classification: { ...cf.classification, is_test: true } };
          }
          return cf;
        }),
      });
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "0".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([
        prFile({ filePath: "tests/test_foo.py", additions: 10 }),
        prFile({ filePath: "src/main.py", additions: 5 }),
      ]),
      classify: markTests,
    });
    expect(result).not.toBeNull();
    expect(result!.changed_files[0]!.classification.is_test).toBe(true);
    expect(result!.changed_files[1]!.classification.is_test).toBe(false);
  });
});

describe("buildPrContextMvp", () => {
  it("single file for the chunk path with placeholder additions/deletions", () => {
    const prId = randomUUID();
    const result = buildPrContextMvp({
      prId,
      headSha: "9".repeat(40),
      repoDefaultBranch: "main",
      chunkPath: "src/some/file.py",
    });
    expect(result.pr_id).toBe(prId);
    expect(result.head_sha).toBe("9".repeat(40));
    expect(result.changed_files.length).toBe(1);
    expect(result.changed_files[0]!.path).toBe("src/some/file.py");
    expect(result.changed_files[0]!.additions).toBe(0);
    expect(result.changed_files[0]!.deletions).toBe(0);
  });

  it("manifests are empty in the MVP", () => {
    const result = buildPrContextMvp({
      prId: randomUUID(),
      headSha: "0".repeat(40),
      repoDefaultBranch: "main",
      chunkPath: "anywhere.py",
    });
    expect(result.manifests).toEqual([]);
  });

  it("does not infer classification (all flags false)", () => {
    const result = buildPrContextMvp({
      prId: randomUUID(),
      headSha: "0".repeat(40),
      repoDefaultBranch: "main",
      chunkPath: "tests/test_x.py",
    });
    expect(result.changed_files[0]!.classification.is_test).toBe(false);
  });
});

describe("parity between helpers", () => {
  it("both pass the 40-char head_sha through verbatim", () => {
    const sha = "a".repeat(40);
    const full = buildPrContextFull({
      prId: randomUUID(),
      headSha: sha,
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "x.py" })]),
    });
    const mvp = buildPrContextMvp({
      prId: randomUUID(),
      headSha: sha,
      repoDefaultBranch: "main",
      chunkPath: "x.py",
    });
    expect(full).not.toBeNull();
    expect(full!.head_sha).toBe(sha);
    expect(mvp.head_sha).toBe(sha);
  });

  it("both pass through non-main default branches", () => {
    const full = buildPrContextFull({
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "develop",
      enrichment: enrichment([prFile({ filePath: "x.py" })]),
    });
    const mvp = buildPrContextMvp({
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "master",
      chunkPath: "x.py",
    });
    expect(full).not.toBeNull();
    expect(full!.repo_default_branch).toBe("develop");
    expect(mvp.repo_default_branch).toBe("master");
  });
});

describe("manifest-snapshot threading", () => {
  function snap(args: { path: string; rawBody?: string; ecosystem?: string | null }): ManifestSnapshot {
    return {
      path: args.path,
      raw_body: args.rawBody ?? "",
      parsed_dependencies: [],
      parsed_dependency_records: [],
      fetch_status: "success",
      content_type: "text",
      byte_length: 0,
      sha256: "",
      truncated: false,
      detected_ecosystem: args.ecosystem ?? null,
      dependency_parsing_state: "not_attempted",
    };
  }

  it("full builder default → manifests empty", () => {
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py" })]),
    });
    expect(result).not.toBeNull();
    expect(result!.manifests).toEqual([]);
  });

  it("full builder threads manifest_snapshots verbatim", () => {
    const snaps = [
      snap({ path: "pyproject.toml", rawBody: "[project]", ecosystem: "python" }),
      snap({ path: "package.json", rawBody: '{"name": "x"}', ecosystem: "node" }),
    ];
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py" })]),
      manifestSnapshots: snaps,
    });
    expect(result).not.toBeNull();
    expect(result!.manifests).toEqual(snaps);
    expect(result!.manifests[0]!.path).toBe("pyproject.toml");
    expect(result!.manifests[1]!.detected_ecosystem).toBe("node");
  });

  it("full builder threads a failure-status snapshot unchanged", () => {
    const snaps = [{ ...snap({ path: "pyproject.toml" }), fetch_status: "not_found" as const }];
    const result = buildPrContextFull({
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py" })]),
      manifestSnapshots: snaps,
    });
    expect(result).not.toBeNull();
    expect(result!.manifests[0]!.fetch_status).toBe("not_found");
  });
});

describe("pickPrContext", () => {
  function snap(path: string): ManifestSnapshot {
    return {
      path,
      raw_body: "[project]",
      parsed_dependencies: [],
      parsed_dependency_records: [],
      fetch_status: "success",
      content_type: "text",
      byte_length: 0,
      sha256: "",
      truncated: false,
      detected_ecosystem: null,
      dependency_parsing_state: "not_attempted",
    };
  }

  it("useFull=true threads manifests into the full branch", () => {
    const snaps = [snap("pyproject.toml")];
    const result = pickPrContext({
      useFull: true,
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py" })]),
      chunkPath: "src/main.py",
      manifestSnapshots: snaps,
    });
    expect(result.manifests).toEqual(snaps);
  });

  it("useFull=false (in-flight replay) uses MVP + ignores manifests", () => {
    const result = pickPrContext({
      useFull: false,
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: null,
      chunkPath: "src/main.py",
      manifestSnapshots: [snap("pyproject.toml")],
    });
    expect(result.manifests).toEqual([]);
  });

  it("useFull=true but enrichment null → falls back to MVP single-file", () => {
    const result = pickPrContext({
      useFull: true,
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: null,
      chunkPath: "src/only.py",
    });
    expect(result.changed_files.length).toBe(1);
    expect(result.changed_files[0]!.path).toBe("src/only.py");
    expect(result.manifests).toEqual([]);
  });

  it("useFull=true default → manifests empty", () => {
    const result = pickPrContext({
      useFull: true,
      prId: randomUUID(),
      headSha: "a".repeat(40),
      repoDefaultBranch: "main",
      enrichment: enrichment([prFile({ filePath: "src/main.py" })]),
      chunkPath: "src/main.py",
    });
    expect(result.manifests).toEqual([]);
  });
});
