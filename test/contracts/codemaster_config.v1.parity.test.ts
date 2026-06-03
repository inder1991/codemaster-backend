import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  canonicalizeLabel,
  CodemasterConfigV1,
  ConfluenceKnowledgeBlockV1,
  KnowledgeConfigV1,
  ModelOverridesV1,
  PathInstructionV1,
} from "../../libs/contracts/src/codemaster_config.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Every field in this contract is bool/int/str/nested
// model — no bare float — so the canonicalizer never strips a column.
const PY = "contracts.codemaster_config.v1";

describe("ModelOverridesV1 parity (Pydantic ↔ Zod)", () => {
  it("dumps a fully-populated payload identically", async () => {
    const payload = {
      review_finding: "anthropic.claude-opus",
      walkthrough: "anthropic.claude-sonnet",
      curate_finding: "anthropic.claude-haiku",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ModelOverridesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ModelOverridesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same null defaults when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ModelOverridesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ModelOverridesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an over-long model id (max_length=80)", async () => {
    const bad = { review_finding: "x".repeat(81) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ModelOverridesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ModelOverridesV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ModelOverridesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ModelOverridesV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ConfluenceKnowledgeBlockV1 parity (label canonicalization)", () => {
  it("canonicalizes a representative label mix identically", async () => {
    const payload = {
      include_labels: ["Python", "K8S", "MyWeirdLabel", "pythonv2", "default", "topic:security"],
      exclude_labels: ["  ", "ts", "Foo Bar!", "123abc"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceKnowledgeBlockV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluenceKnowledgeBlockV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same empty defaults when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceKnowledgeBlockV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluenceKnowledgeBlockV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an over-cap label list (max_length=50)", async () => {
    const bad = { include_labels: Array.from({ length: 51 }, (_v, i) => `topic:t${i}`) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceKnowledgeBlockV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluenceKnowledgeBlockV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field", async () => {
    const bad = { include_labels: [], bogus: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceKnowledgeBlockV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluenceKnowledgeBlockV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("canonicalizeLabel value-parity (label_taxonomy.canonicalize)", () => {
  it("matches the frozen Python canonicalize on every recognition branch", async () => {
    // Each entry hits a distinct lookup branch: passthrough, recognition-map, version-heuristic,
    // sanitized-unrecognized, leading-non-alpha (x_ prefix), and empty.
    const samples = [
      "lang:python",
      "default",
      "Foo Bar!",
      "123abc",
      "___",
      "!!!",
      "k8s_v1",
      "SecurityPolicy",
      "UPPER",
      "foo.bar/baz",
      "v2",
      "xv1",
      "",
      "   ",
    ];
    for (const s of samples) {
      const r = await pyRef({
        pyModule: "codemaster.retrieval.label_taxonomy",
        pyCallable: "canonicalize",
        kwargs: { raw_label: s },
      });
      expect(r.ok, r.err).toBe(true);
      // canonicalize() returns a bare str → oracle emits it as JSON-quoted; compare to ours.
      expect(canonicalize(canonicalizeLabel(s))).toBe(r.out);
    }
  }, 60_000);
});

describe("KnowledgeConfigV1 parity", () => {
  it("dumps a populated payload (with nested confluence) identically", async () => {
    const payload = {
      enabled: false,
      file_patterns: ["docs/**/*.md", "policies/*.yaml"],
      confluence: { include_labels: ["python"], exclude_labels: ["js"] },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeConfigV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(KnowledgeConfigV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when omitted (enabled=true, empty patterns, empty confluence)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeConfigV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(KnowledgeConfigV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an absolute file_pattern", async () => {
    const bad = { file_patterns: ["/etc/passwd"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a '..'-segment file_pattern (path escape)", async () => {
    const bad = { file_patterns: ["a/../b"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an over-long pattern (200-char limit)", async () => {
    const bad = { file_patterns: ["x".repeat(201)] };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "KnowledgeConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => KnowledgeConfigV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("PathInstructionV1 parity", () => {
  it("dumps a valid payload identically", async () => {
    const payload = { path: "src/**/*.ts", instructions: "Prefer named exports." };
    const r = await pyRef({ pyModule: PY, pyCallable: "PathInstructionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PathInstructionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty path (min_length=1)", async () => {
    const bad = { path: "", instructions: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "PathInstructionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PathInstructionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field", async () => {
    const bad = { path: "a", instructions: "b", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PathInstructionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PathInstructionV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("CodemasterConfigV1 parity", () => {
  it("applies ALL defaults identically when constructed empty", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CodemasterConfigV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("dumps a fully-populated payload (nested models + tools + policy) identically", async () => {
    const payload = {
      schema_version: 1,
      enabled: true,
      severity_min: "issue",
      ignore_paths: ["legacy/**"],
      path_filters: ["src/**", "!dist/**"],
      max_findings_per_file: 25,
      max_findings_per_review: 200,
      model_overrides: { review_finding: "anthropic.claude-opus", walkthrough: null, curate_finding: null },
      enabled_tools: ["eslint", "ruff", "semgrep"],
      path_instructions: [{ path: "src/**", instructions: "No `any`." }],
      knowledge: {
        enabled: true,
        file_patterns: ["policies/*.md"],
        confluence: { include_labels: ["python", "k8s"], exclude_labels: ["js"] },
      },
      policy: { a: [1, 2], z: 1 },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CodemasterConfigV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves a non-1 schema_version (plain int field, NOT Literal[1])", async () => {
    const payload = { schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CodemasterConfigV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an unknown severity_min value", async () => {
    const bad = { severity_min: "critical" };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodemasterConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown tool name (locked roster)", async () => {
    const bad = { enabled_tools: ["eslint", "not-a-tool"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodemasterConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT max_findings_per_file above its cap (le=100)", async () => {
    const bad = { max_findings_per_file: 101 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodemasterConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a '..'-segment path_filter (also through the '!' exclude prefix)", async () => {
    const bad = { path_filters: ["!a/../b"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodemasterConfigV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra top-level field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodemasterConfigV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodemasterConfigV1.parse(bad)).toThrow();
  }, 30_000);
});
