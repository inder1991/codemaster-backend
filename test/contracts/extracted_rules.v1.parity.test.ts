import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ExtractedRuleV1 } from "../../libs/contracts/src/extracted_rules.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (the oracle calls
// `ExtractedRuleV1(**payload).model_dump(mode="json")`) and through Zod (`ExtractedRuleV1.parse(payload)`),
// then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.extracted_rules.v1";

// sha256-shaped hex strings (exactly 64 chars) for normalized_hash + source_file_sha256.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("ExtractedRuleV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      rule_id: "sec-src-no-eval-1a2b3c",
      normalized_hash: HASH_A,
      source_file: "src/CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "src",
      heading_path: ["Security", "Input handling"],
      rule_index: 3,
      title: "No eval()",
      body: "Never call eval() on untrusted input.",
      category: "security",
      intent: "forbid",
      priority: 100,
      oversized_rule_warning: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ExtractedRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=1, heading_path=[], oversized_rule_warning=false)", async () => {
    // Omit schema_version, heading_path, oversized_rule_warning — all defaulted on both sides.
    // scope_dir="" + title="" exercise the no-min-length (empty-string-allowed) fields.
    const payload = {
      rule_id: "sty-root-fmt-9z8y7x",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: 0,
      title: "",
      body: "Prefer black formatting.",
      category: "style",
      intent: "recommend",
      priority: 20,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ExtractedRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts schema_version=2 on both sides (plain int, NOT Literal[1])", async () => {
    const payload = {
      schema_version: 2,
      rule_id: "arc-src-layering-ab12cd",
      normalized_hash: HASH_A,
      source_file: "src/CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "src",
      heading_path: ["Architecture"],
      rule_index: 1,
      title: "Layering",
      body: "Domain must not import infra.",
      category: "architecture",
      intent: "require",
      priority: 80,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ExtractedRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a category outside the enum", async () => {
    const bad = {
      rule_id: "x-1",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: 0,
      title: "t",
      body: "b",
      category: "bogus",
      intent: "require",
      priority: 10,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an intent outside the enum", async () => {
    const bad = {
      rule_id: "x-2",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: 0,
      title: "t",
      body: "b",
      category: "testing",
      intent: "suggest",
      priority: 10,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a normalized_hash of the wrong length (not 64 chars)", async () => {
    const bad = {
      rule_id: "x-3",
      normalized_hash: "a".repeat(63), // one short — fails min_length=64
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: 0,
      title: "t",
      body: "b",
      category: "security",
      intent: "forbid",
      priority: 100,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative rule_index (ge=0)", async () => {
    const bad = {
      rule_id: "x-4",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: -1,
      title: "t",
      body: "b",
      category: "performance",
      intent: "recommend",
      priority: 50,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a priority above the bound (le=200)", async () => {
    const bad = {
      rule_id: "x-5",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: 0,
      title: "t",
      body: "b",
      category: "security",
      intent: "forbid",
      priority: 201,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a heading_path deeper than MAX_HEADING_PATH_DEPTH (>3)", async () => {
    const bad = {
      rule_id: "x-6",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      heading_path: ["a", "b", "c", "d"], // 4 > max_length=3
      rule_index: 0,
      title: "t",
      body: "b",
      category: "style",
      intent: "recommend",
      priority: 20,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      rule_id: "x-7",
      normalized_hash: HASH_A,
      source_file: "CLAUDE.md",
      source_file_sha256: HASH_B,
      scope_dir: "",
      rule_index: 0,
      title: "t",
      body: "b",
      category: "security",
      intent: "forbid",
      priority: 100,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ExtractedRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ExtractedRuleV1.parse(bad)).toThrow();
  }, 30_000);
});
