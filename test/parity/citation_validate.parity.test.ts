import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyValidateCitations,
  shutdownCitationValidateRef,
  type FindingInput,
} from "./citation_validate_oracle.js";
import { citationValidate } from "#backend/activities/citation_validate.activity.js";
import { CitationValidator } from "#backend/review/citation_validator.js";
import { CitationValidateInputV1 } from "#contracts/citation_validate_input.v1.js";
import { PolicyCitationContextV1 } from "#contracts/policy_citation.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

afterAll(() => {
  shutdownCitationValidateRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `CitationValidator.validate` core (repo_path fs existence checks +
// knowledge_chunk/policy_rule membership, surviving/dropped partition) is byte-equal to the frozen
// Python `CitationValidator.validate`
// (vendor/codemaster-py/codemaster/review/citation_validator.py), driven over the dedicated ref
// (tools/parity/run_citation_validate_ref.py) against a REAL on-disk workspace BOTH sides see.
//
// The whole reason citation-validate is an ACTIVITY is the fs syscalls (Path.resolve/.exists/.is_file),
// so the parity must exercise a real directory tree — not a mock. Each test materializes a temp
// workspace, seeds existing vs missing files, and asserts the SAME surviving/dropped partition from the
// frozen Python and the TS port.
//
// `confidence` is a bare Python float that cannot byte-round-trip through the canonicalizer (1.0 vs "1");
// it is STRIPPED from the canonical compare on both sides (`stripConfidence`) and asserted STRUCTURALLY
// (`confidences`) — the established bare-float handling (mirrors dedup.parity.test.ts / aggregate).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one finding wire dict (the shape `ReviewFindingV1(**dict)` / `ReviewFindingV1.parse` accept). */
function f(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    file: "src/foo.py",
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: "T",
    body: "B",
    confidence: 0.5,
    ...overrides,
  };
}

/** A repo_path source wire dict. */
function repoPath(locator: string): Record<string, unknown> {
  return { kind: "repo_path", locator };
}

/** Deep-clone with every `confidence` key removed (Python serializes 1.0; JS serializes 1). */
function stripConfidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripConfidence);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "confidence") continue;
      out[k] = stripConfidence(v);
    }
    return out;
  }
  return value;
}

/** The confidence floats of each finding (surviving + dropped.finding), in order. */
function confidencesOf(result: {
  readonly surviving: ReadonlyArray<Record<string, unknown>>;
  readonly dropped: ReadonlyArray<Record<string, unknown>>;
}): { surviving: Array<number>; dropped: Array<number> } {
  return {
    surviving: result.surviving.map((x) => x["confidence"] as number),
    dropped: result.dropped.map((d) => (d["finding"] as Record<string, unknown>)["confidence"] as number),
  };
}

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "citation-validate-parity-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/**
 * Run the SAME findings through the TS core and the frozen Python over the SAME on-disk workspace, and
 * assert byte-equality of BOTH the surviving and dropped lists (+ ORDER), with `confidence` stripped from
 * the canonical diff and asserted structurally. Returns the TS result so a caller can make extra
 * structural assertions on it.
 */
async function assertParity(args: {
  readonly findings: ReadonlyArray<FindingInput>;
  readonly knowledgeChunkIds: ReadonlyArray<string> | null;
  readonly policyCitation: Record<string, unknown> | null;
}): Promise<CitationValidationResultDict> {
  // Parse each finding through the ported contract first — mirrors the Python ref's `ReviewFindingV1(**dict)`,
  // applying the contract defaults (sources / scope / evidence_refs) before the core consumes them.
  const parsedFindings = args.findings.map((d) => ReviewFindingV1.parse(d));

  const validator = new CitationValidator({
    workspace: ws,
    knowledgeChunkIds: args.knowledgeChunkIds === null ? null : new Set(args.knowledgeChunkIds),
    policyCitation: args.policyCitation === null ? null : PolicyCitationContextV1.parse(args.policyCitation),
  });
  const tsResult = validator.validate(parsedFindings);
  const tsDict: CitationValidationResultDict = {
    surviving: tsResult.surviving as unknown as Array<Record<string, unknown>>,
    dropped: tsResult.dropped as unknown as Array<Record<string, unknown>>,
  };

  const py = await pyValidateCitations({
    workspacePath: ws,
    findings: args.findings,
    knowledgeChunkIds: args.knowledgeChunkIds,
    policyCitation: args.policyCitation,
  });

  // Byte-equal surviving + dropped lists (confidence stripped). canonicalize key-sorts recursively.
  expect(canonicalize(stripConfidence(tsDict.surviving))).toBe(canonicalize(stripConfidence(py.surviving)));
  expect(canonicalize(stripConfidence(tsDict.dropped))).toBe(canonicalize(stripConfidence(py.dropped)));
  // Confidence floats match structurally, in order, on both partitions.
  expect(confidencesOf(tsDict)).toEqual(confidencesOf(py));
  return tsDict;
}

type CitationValidationResultDict = {
  surviving: Array<Record<string, unknown>>;
  dropped: Array<Record<string, unknown>>;
};

describe("CitationValidator.validate parity (Pydantic ↔ TS)", () => {
  it("empty findings → empty surviving + empty dropped (short-circuit, no fs touch)", async () => {
    const r = await assertParity({ findings: [], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);
  }, 30_000);

  it("finding with NO sources → survives untouched (no fs read)", async () => {
    const r = await assertParity({ findings: [f()], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  }, 30_000);

  it("repo_path EXISTING file → survives; MISSING file → dropped (the existing/missing partition)", async () => {
    // Seed an existing file and a nested existing file.
    writeFileSync(join(ws, "a.py"), "x");
    mkdirSync(join(ws, "pkg"));
    writeFileSync(join(ws, "pkg", "b.py"), "y");

    const exists1 = f({ title: "exists-top", sources: [repoPath("a.py")] });
    const exists2 = f({ title: "exists-nested", sources: [repoPath("pkg/b.py")] });
    const missing = f({ title: "missing", sources: [repoPath("nope.py")] });

    const r = await assertParity({
      findings: [exists1, missing, exists2],
      knowledgeChunkIds: null,
      policyCitation: null,
    });
    // Two survive (in input order, missing filtered out), one dropped.
    expect(r.surviving.map((x) => x["title"])).toEqual(["exists-top", "exists-nested"]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!["reason"]).toContain("nope.py");
  }, 30_000);

  it("repo_path to a DIRECTORY (not a file) → dropped (is_file check)", async () => {
    mkdirSync(join(ws, "pkg"));
    const dirCite = f({ title: "dir", sources: [repoPath("pkg")] });
    const r = await assertParity({ findings: [dirCite], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
  }, 30_000);

  it("absolute-path locator + parent-escape (no shared prefix) → both dropped", async () => {
    writeFileSync(join(ws, "a.py"), "x");
    const abs = f({ title: "abs", sources: [repoPath("/etc/passwd")] });
    const escape = f({ title: "escape", sources: [repoPath("../outside.py")] });
    const r = await assertParity({
      findings: [abs, escape],
      knowledgeChunkIds: null,
      policyCitation: null,
    });
    expect(r.surviving).toHaveLength(0);
    expect(r.dropped).toHaveLength(2);
  }, 30_000);

  it("ANY unresolvable source poisons the finding (mixed sources, one bad → dropped)", async () => {
    writeFileSync(join(ws, "a.py"), "x");
    const mixed = f({
      title: "mixed",
      sources: [repoPath("a.py"), { kind: "linter_rule", locator: "no-unused-vars" }, repoPath("bad.py")],
    });
    const r = await assertParity({ findings: [mixed], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    // First unresolvable reason is the bad repo_path (the linter_rule has no check).
    expect(r.dropped[0]!["reason"]).toContain("bad.py");
  }, 30_000);

  it("linter_rule source → always survives (no resolution check)", async () => {
    const lint = f({ title: "lint", sources: [{ kind: "linter_rule", locator: "RUF100" }] });
    const r = await assertParity({ findings: [lint], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  }, 30_000);

  it("knowledge_chunk skip-mode (ids=null) → accepted as-is", async () => {
    const kc = f({ title: "kc", sources: [{ kind: "knowledge_chunk", locator: "chunk-xyz" }] });
    const r = await assertParity({ findings: [kc], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  }, 30_000);

  it("knowledge_chunk strict membership: in-set survives, out-of-set dropped; empty set drops all", async () => {
    const inSet = f({ title: "in", sources: [{ kind: "knowledge_chunk", locator: "chunk-A" }] });
    const outSet = f({ title: "out", sources: [{ kind: "knowledge_chunk", locator: "chunk-Z" }] });
    const r = await assertParity({
      findings: [inSet, outSet],
      knowledgeChunkIds: ["chunk-A", "chunk-B"],
      policyCitation: null,
    });
    expect(r.surviving.map((x) => x["title"])).toEqual(["in"]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!["reason"]).toContain("chunk-Z");

    // Empty (but non-null) set → strict mode forbids ALL knowledge_chunk citations.
    const r2 = await assertParity({
      findings: [inSet],
      knowledgeChunkIds: [],
      policyCitation: null,
    });
    expect(r2.surviving).toHaveLength(0);
    expect(r2.dropped).toHaveLength(1);
  }, 30_000);

  it("policy_rule skip-mode (no context) → accepted as-is", async () => {
    const pr = f({ title: "pr", sources: [{ kind: "policy_rule", locator: "ANY-rule" }] });
    const r = await assertParity({ findings: [pr], knowledgeChunkIds: null, policyCitation: null });
    expect(r.surviving).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  }, 30_000);

  it("policy_rule observe-mode → fabricated locator KEPT (log + accept)", async () => {
    const pr = f({ title: "pr", sources: [{ kind: "policy_rule", locator: "FABRICATED-rule" }] });
    const r = await assertParity({
      findings: [pr],
      knowledgeChunkIds: null,
      policyCitation: { valid_rule_ids: ["REAL-rule-aaaaaaaa"], enforcement: "observe" },
    });
    expect(r.surviving).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  }, 30_000);

  it("policy_rule enforce-mode → fabricated dropped, valid survives", async () => {
    const bad = f({ title: "bad", sources: [{ kind: "policy_rule", locator: "FABRICATED-rule" }] });
    const good = f({ title: "good", sources: [{ kind: "policy_rule", locator: "REAL-rule-aaaaaaaa" }] });
    const r = await assertParity({
      findings: [bad, good],
      knowledgeChunkIds: null,
      policyCitation: { valid_rule_ids: ["REAL-rule-aaaaaaaa"], enforcement: "enforce" },
    });
    expect(r.surviving.map((x) => x["title"])).toEqual(["good"]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!["reason"]).toContain("FABRICATED-rule");
  }, 30_000);

  it("FIDELITY: sibling dir sharing the workspace prefix (ws vs ws-evil) resolves TRUE (Python startswith quirk)", async () => {
    // The frozen Python guard is a RAW `str(target).startswith(str(workspace_resolved))`, so a sibling
    // directory whose resolved path shares the `ws` prefix (e.g. `<root>/ws` vs `<root>/ws-evil`) passes
    // the containment check. We reproduce that on disk and assert BOTH impls agree (1:1 fidelity, not a
    // "fix"). `ws` here is the mkdtemp dir; we create a sibling by suffixing its name.
    const sibling = `${ws}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "c.py"), "z");
    // The locator `../<basename(ws)>-evil/c.py` resolves to the sibling; its resolved path startswith
    // the workspace's resolved path (shared `ws` prefix) → Python accepts it.
    const base = ws.split("/").pop()!;
    const cite = f({ title: "sibling", sources: [repoPath(`../${base}-evil/c.py`)] });
    try {
      const r = await assertParity({ findings: [cite], knowledgeChunkIds: null, policyCitation: null });
      // Both impls agree the finding SURVIVES (the prefix-match quirk). The byte-equal partition assert
      // inside assertParity is the real guarantee; this just documents the surprising outcome.
      expect(r.surviving).toHaveLength(1);
      expect(r.dropped).toHaveLength(0);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 30_000);

  it("symlink ESCAPING the workspace → dropped (realpath resolves out, prefix check fails)", async () => {
    // Real file outside the workspace, NOT sharing its prefix.
    const outsideDir = mkdtempSync(join(tmpdir(), "citation-validate-outside-"));
    const outside = join(outsideDir, "real.py");
    writeFileSync(outside, "o");
    symlinkSync(outside, join(ws, "ln.py"));
    const cite = f({ title: "symlink-escape", sources: [repoPath("ln.py")] });
    try {
      const r = await assertParity({ findings: [cite], knowledgeChunkIds: null, policyCitation: null });
      expect(r.surviving).toHaveLength(0);
      expect(r.dropped).toHaveLength(1);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("ACTIVITY round-trip: citationValidate over the typed envelope matches the validator core", async () => {
    writeFileSync(join(ws, "a.py"), "x");
    const exists = f({ title: "exists", sources: [repoPath("a.py")] });
    const missing = f({ title: "missing", sources: [repoPath("gone.py")] });

    const input = CitationValidateInputV1.parse({
      workspace_path: ws,
      findings: [exists, missing],
      knowledge_chunk_ids: null,
      policy_citation: null,
    });
    const out = await citationValidate(input);

    // Same partition as the frozen Python over the same workspace.
    const py = await pyValidateCitations({
      workspacePath: ws,
      findings: [exists, missing],
      knowledgeChunkIds: null,
      policyCitation: null,
    });
    expect(canonicalize(stripConfidence(out.surviving))).toBe(canonicalize(stripConfidence(py.surviving)));
    expect(canonicalize(stripConfidence(out.dropped))).toBe(canonicalize(stripConfidence(py.dropped)));
    expect(out.surviving.map((x) => x.title)).toEqual(["exists"]);
    expect(out.dropped).toHaveLength(1);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CitationValidateInputV1 — NEW typed envelope introduced during the port (CLAUDE.md invariant 11 /
// ADR-0047). No Python counterpart to byte-diff → round-trip + validation only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("CitationValidateInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a minimal {workspace_path} and applies all defaults", () => {
    const parsed = CitationValidateInputV1.parse({ workspace_path: "/ws" });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.findings).toEqual([]);
    // null is the load-bearing skip-mode default — NOT collapsed to [].
    expect(parsed.knowledge_chunk_ids).toBeNull();
    expect(parsed.policy_citation).toBeNull();
  });

  it("preserves the null/[] distinction on knowledge_chunk_ids (skip-mode vs strict-empty)", () => {
    expect(CitationValidateInputV1.parse({ workspace_path: "/ws", knowledge_chunk_ids: null }).knowledge_chunk_ids).toBeNull();
    expect(
      CitationValidateInputV1.parse({ workspace_path: "/ws", knowledge_chunk_ids: [] }).knowledge_chunk_ids,
    ).toEqual([]);
    expect(
      CitationValidateInputV1.parse({ workspace_path: "/ws", knowledge_chunk_ids: ["c1"] }).knowledge_chunk_ids,
    ).toEqual(["c1"]);
  });

  it("parses a nested policy_citation context with its defaults", () => {
    const parsed = CitationValidateInputV1.parse({
      workspace_path: "/ws",
      policy_citation: { valid_rule_ids: ["R1"] },
    });
    expect(parsed.policy_citation).not.toBeNull();
    expect(parsed.policy_citation!.enforcement).toBe("observe");
    expect(parsed.policy_citation!.valid_rule_ids).toEqual(["R1"]);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() => CitationValidateInputV1.parse({ workspace_path: "/ws", bogus: true })).toThrow();
  });

  it("rejects a missing workspace_path (required)", () => {
    expect(() => CitationValidateInputV1.parse({ findings: [] })).toThrow();
  });

  it("rejects a finding that violates the ReviewFindingV1 contract (end_line < start_line)", () => {
    expect(() =>
      CitationValidateInputV1.parse({ workspace_path: "/ws", findings: [f({ start_line: 9, end_line: 1 })] }),
    ).toThrow();
  });
});
