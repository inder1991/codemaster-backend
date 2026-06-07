import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";

afterAll(() => shutdownRef());

// StaticAnalysisInputV1 is the NEW typed envelope introduced DURING the port (CLAUDE.md invariant 11 /
// ADR-0047). The frozen Python `static_analysis_activity` dispatches with FOUR positional arguments —
// `(workspace_path: str, files: tuple[str, ...], changed_line_ranges: dict[str, tuple[tuple[int, int],
// ...]], pr_meta_dict: dict[str, Any])` (review_pull_request.py:1431-1448) — which violates the
// one-positional-typed-input rule. The TS port CLOSES that violation by collapsing the four positionals
// into this single envelope (consistent with chunk_and_redact.v1 / classify_files.v1 /
// aggregate_findings.v1).
//
// There is NO Python Pydantic counterpart for the ENVELOPE itself, so envelope-level coverage is
// round-trip + validation only (accepts a valid payload; `.strict()` rejects unknown keys). The NESTED
// `pr_meta` field IS a real ported contract (PrMetaV1), so the nested-shape parity is proven against the
// frozen Python PrMetaV1 via the oracle below.
const PY_PR_META = "contracts.walkthrough.pr_meta_v1";

// A valid PrMetaV1 payload (per contracts/walkthrough/pr_meta_v1.py). pr_id / installation_id are
// canonical-LOWERCASE UUIDs (Pydantic lowercases on dump).
const PR_META = {
  pr_id: "0123abcd-4567-89ab-cdef-0123456789ab",
  installation_id: "0123abcd-4567-89ab-cdef-0123456789ac",
  repo: "octo/widgets",
  pr_title: "Add the thing",
  pr_description: "A change that adds the thing.",
};

describe("StaticAnalysisInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a fully-populated payload and applies the schema_version default", () => {
    const parsed = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws",
      sandbox_files: ["a.py", "b.ts"],
      changed_line_ranges: { "a.py": [[1, 2]], "b.ts": [[10, 20]] },
      pr_meta: PR_META,
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.workspace_path).toBe("/tmp/ws");
    expect(parsed.sandbox_files).toEqual(["a.py", "b.ts"]);
    expect(parsed.changed_line_ranges).toEqual({ "a.py": [[1, 2]], "b.ts": [[10, 20]] });
    expect(parsed.pr_meta.repo).toBe("octo/widgets");
  });

  it("applies the changed_line_ranges + sandbox_files defaults when omitted", () => {
    const parsed = StaticAnalysisInputV1.parse({ workspace_path: "/tmp/ws", pr_meta: PR_META });
    expect(parsed.sandbox_files).toEqual([]);
    expect(parsed.changed_line_ranges).toEqual({});
  });

  it("rejects an unknown top-level key (.strict() ↔ Pydantic extra=forbid)", () => {
    expect(() =>
      StaticAnalysisInputV1.parse({ workspace_path: "/tmp/ws", pr_meta: PR_META, bogus: true }),
    ).toThrow();
  });

  it("rejects a non-string sandbox_files entry", () => {
    expect(() =>
      StaticAnalysisInputV1.parse({ workspace_path: "/tmp/ws", sandbox_files: [42], pr_meta: PR_META }),
    ).toThrow();
  });

  it("rejects a missing pr_meta (required, no default)", () => {
    expect(() => StaticAnalysisInputV1.parse({ workspace_path: "/tmp/ws" })).toThrow();
  });

  it("rejects a pr_meta missing a required field (nested PrMetaV1 validation)", () => {
    const badPrMeta = { ...PR_META } as Record<string, unknown>;
    delete badPrMeta["repo"];
    expect(() =>
      StaticAnalysisInputV1.parse({ workspace_path: "/tmp/ws", pr_meta: badPrMeta }),
    ).toThrow();
  });

  it("the nested pr_meta is byte-identical to the frozen Python PrMetaV1 dump", async () => {
    const r = await pyRef({ pyModule: PY_PR_META, pyCallable: "PrMetaV1", kwargs: PR_META });
    expect(r.ok, r.err).toBe(true);
    const parsed = StaticAnalysisInputV1.parse({
      workspace_path: "/tmp/ws",
      sandbox_files: [],
      changed_line_ranges: {},
      pr_meta: PR_META,
    });
    // The envelope's nested pr_meta must serialize identically to the standalone Python PrMetaV1 dump
    // (the orchestrator hands the activity `pr_meta_arg.model_dump(mode="json")`).
    expect(canonicalize(parsed.pr_meta)).toBe(r.out);
  }, 30_000);
});
