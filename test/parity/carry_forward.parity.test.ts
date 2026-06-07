import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyDoSelect,
  shutdownCarryForwardRef,
  type ChangedLineRanges,
  type ChunkInput,
  type FindingInput,
} from "./carry_forward_oracle.js";
import { doSelectCarryForward } from "#backend/activities/select_carry_forward.activity.js";
import {
  SelectCarryForwardInputV1 as SelectCarryForwardInputSchema,
  type SelectCarryForwardInputV1,
} from "#contracts/select_carry_forward_input.v1.js";

afterAll(() => {
  shutdownCarryForwardRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `doSelectCarryForward` selector (pure line-range-overlap partition of
// parent findings + current chunks into carried-vs-to_review) is byte-equal to the frozen Python
// `_do_select` (vendor/codemaster-py/codemaster/review/carry_forward.py), driven over the dedicated ref
// (tools/parity/run_carry_forward_ref.py).
//
// The selector is PURE deterministic: a finding carries forward iff its [start, end] range does NOT
// intersect any change in changed_line_ranges[file]; a chunk goes to to_review iff its range DOES
// intersect a change OR its path is absent from the change map (renamed/new-path → fully changed);
// a file present with an EMPTY range tuple is no-change. Adversarial overlap cases below pin every
// branch: exact-boundary touch, no-overlap, empty parent, chunk fully inside a changed range, off-by-one.
//
// `confidence` is a bare Python float that cannot byte-round-trip through the canonicalizer (1.0 vs "1");
// it is STRIPPED from the canonical compare (`stripConfidence`) and asserted STRUCTURALLY — the
// established bare-float handling (see aggregate.parity.test.ts / carry_forward.v1.parity.test.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const CHUNK_NS = "0e2a9f1c-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
let chunkSeq = 0;

/** A distinct lowercase UUID per chunk so chunk identity is stable + ordered in the partition. */
function chunkId(): string {
  const n = (chunkSeq++).toString(16).padStart(2, "0");
  return `${CHUNK_NS.slice(0, -2)}${n}`;
}

/** Build one ReviewFindingV1 wire dict (the shape both `ReviewFindingV1(**dict)` and `.parse` accept). */
function finding(file: string, startLine: number, endLine: number): FindingInput {
  return {
    file,
    start_line: startLine,
    end_line: endLine,
    severity: "issue",
    category: "bug",
    title: `finding ${file}:${startLine}-${endLine}`,
    body: "carried-forward-candidate finding body",
    confidence: 0.5,
  };
}

/** Build one DiffChunkV1 wire dict (chunk_id is a distinct lowercase UUID; required since R-5). */
function chunk(path: string, startLine: number, endLine: number): ChunkInput {
  return {
    chunk_id: chunkId(),
    path,
    language: "python",
    start_line: startLine,
    end_line: endLine,
    body: "def f():\n    return None\n",
    chunk_kind: "function",
    token_estimate: 12,
  };
}

/** Deep-clone a value with every `confidence` key removed (Python emits 1.0, JS emits 1). */
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

/** The confidence floats of the carried findings, in order — the structural assertion the strip omits. */
function carriedConfidences(envelope: Record<string, unknown>): Array<number> {
  const carried = envelope["carried"] as Array<Record<string, unknown>>;
  return carried.map((x) => x["confidence"] as number);
}

/**
 * Run the SAME inputs through the TS selector and the frozen Python, and assert byte-equality of the
 * whole `CarryForwardSelectionV1` envelope (carried list + ORDER + to_review list + ORDER +
 * parent_review_id), with `confidence` stripped from the canonical diff and asserted structurally.
 */
async function assertParity(args: {
  readonly parentFindings: ReadonlyArray<FindingInput>;
  readonly currentChunks: ReadonlyArray<ChunkInput>;
  readonly changedLineRanges: ChangedLineRanges;
  readonly parentReviewId: string | null;
}): Promise<SelectCarryForwardInputV1> {
  const py = await pyDoSelect(args);

  // Parse the wire payload through the REAL envelope schema so the activity is driven exactly as the
  // worker would drive it (the worker decodes the typed input before invoking the activity body).
  const input: SelectCarryForwardInputV1 = SelectCarryForwardInputSchema.parse({
    parent_findings: args.parentFindings,
    current_chunks: args.currentChunks,
    changed_line_ranges: args.changedLineRanges,
    parent_review_id: args.parentReviewId,
  });

  const ts = doSelectCarryForward(input);

  // Byte-equal on every field except the nested float confidence columns.
  expect(canonicalize(stripConfidence(ts))).toBe(canonicalize(stripConfidence(py)));
  // confidence still round-trips structurally (Zod keeps the value; Python serializes float).
  expect(carriedConfidences(ts as unknown as Record<string, unknown>)).toEqual(carriedConfidences(py));

  return input;
}

describe("select_carry_forward Tier-1 parity (TS doSelectCarryForward ↔ Python _do_select)", () => {
  it("EXACT-BOUNDARY touch counts as overlap (a_start == b_end) — finding dropped, chunk reviewed", async () => {
    // Change touches lines [20, 30]. Finding [10, 20] shares exactly line 20 → overlaps → NOT carried.
    // Chunk [30, 40] shares exactly line 30 → overlaps → to_review.
    await assertParity({
      parentFindings: [finding("a.py", 10, 20), finding("a.py", 1, 19)],
      currentChunks: [chunk("a.py", 30, 40), chunk("a.py", 1, 19)],
      changedLineRanges: { "a.py": [[20, 30]] },
      parentReviewId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
  }, 30_000);

  it("NO-OVERLAP — finding fully below change is carried; chunk fully above change is NOT reviewed", async () => {
    // Change [50, 60]. Finding [10, 20] no overlap → carried. Chunk [10, 20] no overlap → skipped.
    await assertParity({
      parentFindings: [finding("a.py", 10, 20)],
      currentChunks: [chunk("a.py", 10, 20)],
      changedLineRanges: { "a.py": [[50, 60]] },
      parentReviewId: null,
    });
  }, 30_000);

  it("EMPTY parent findings + empty chunks → empty partition", async () => {
    await assertParity({
      parentFindings: [],
      currentChunks: [],
      changedLineRanges: { "a.py": [[1, 100]] },
      parentReviewId: null,
    });
  }, 30_000);

  it("CHUNK FULLY INSIDE a changed range is reviewed; finding fully inside is dropped", async () => {
    // Change [1, 100]. Chunk [40, 60] fully inside → to_review. Finding [40, 60] fully inside → dropped.
    await assertParity({
      parentFindings: [finding("a.py", 40, 60)],
      currentChunks: [chunk("a.py", 40, 60)],
      changedLineRanges: { "a.py": [[1, 100]] },
      parentReviewId: "11111111-2222-3333-4444-555555555555",
    });
  }, 30_000);

  it("OFF-BY-ONE — finding ends one line before the change carries; chunk starts one line after carries-skip", async () => {
    // Change [21, 30]. Finding [10, 20] ends at 20 (one before 21) → no overlap → carried.
    // Chunk [31, 40] starts at 31 (one after 30) → no overlap → NOT reviewed.
    // Finding [10, 21] ends at 21 → touches → dropped. Chunk [30, 40] starts at 30 → touches → reviewed.
    await assertParity({
      parentFindings: [finding("a.py", 10, 20), finding("a.py", 10, 21)],
      currentChunks: [chunk("a.py", 31, 40), chunk("a.py", 30, 40)],
      changedLineRanges: { "a.py": [[21, 30]] },
      parentReviewId: null,
    });
  }, 30_000);

  it("FILE ABSENT from change map — chunk treated as fully changed (renamed/new path) → reviewed", async () => {
    // b.py absent from the change map → EVERY b.py chunk goes to to_review (renamed-file case).
    // a.py finding [10, 20] vs no a.py change → carried (file not in map → no overlap → carried).
    await assertParity({
      parentFindings: [finding("a.py", 10, 20)],
      currentChunks: [chunk("b.py", 1, 5), chunk("b.py", 200, 300)],
      changedLineRanges: { "a.py": [[1, 1]] },
      parentReviewId: "99999999-8888-7777-6666-555555555555",
    });
  }, 30_000);

  it("FILE PRESENT with EMPTY range tuple → no-change for that file (chunks skipped, findings carried)", async () => {
    // a.py present but with [] → no change → chunk skipped, finding carried.
    await assertParity({
      parentFindings: [finding("a.py", 10, 20)],
      currentChunks: [chunk("a.py", 10, 20)],
      changedLineRanges: { "a.py": [] },
      parentReviewId: null,
    });
  }, 30_000);

  it("MULTIPLE change ranges — overlap with ANY range counts; partition + ORDER preserved", async () => {
    // a.py changes [5, 10] and [50, 55]. Finding [8, 9] overlaps first → dropped; [20, 30] overlaps
    // neither → carried; [52, 60] overlaps second → dropped. Chunk order in to_review mirrors input.
    await assertParity({
      parentFindings: [finding("a.py", 8, 9), finding("a.py", 20, 30), finding("a.py", 52, 60)],
      currentChunks: [chunk("a.py", 1, 4), chunk("a.py", 5, 10), chunk("a.py", 50, 55)],
      changedLineRanges: { "a.py": [[5, 10], [50, 55]] },
      parentReviewId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
  }, 30_000);

  it("PER-FILE isolation — a change in a.py does not affect b.py findings/chunks", async () => {
    // Only a.py changes. b.py finding carries; b.py chunk is absent-from-map → reviewed (renamed case).
    await assertParity({
      parentFindings: [finding("a.py", 1, 100), finding("b.py", 1, 100)],
      currentChunks: [chunk("a.py", 1, 100), chunk("b.py", 1, 100)],
      changedLineRanges: { "a.py": [[40, 60]] },
      parentReviewId: null,
    });
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SelectCarryForwardInputV1 — the NEW typed envelope introduced DURING the port (CLAUDE.md invariant 11 /
// ADR-0047). The frozen Python `CarryForwardActivity.select_carry_forward` dispatches with FOUR
// positional args (parent_findings, current_chunks, changed_line_ranges, parent_review_id); this single
// envelope is the port's invariant-11 closure. There is NO Python Pydantic counterpart to byte-diff
// against, so this block covers round-trip + validation only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("SelectCarryForwardInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a valid payload + applies the schema_version default and nested contract defaults", () => {
    const parsed = SelectCarryForwardInputSchema.parse({
      parent_findings: [finding("a.py", 10, 20)],
      current_chunks: [chunk("a.py", 10, 20)],
      changed_line_ranges: { "a.py": [[50, 60]] },
      parent_review_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.parent_findings).toHaveLength(1);
    expect(parsed.current_chunks).toHaveLength(1);
    // Nested ReviewFindingV1 / DiffChunkV1 defaults were applied via the imported sibling schemas.
    expect(parsed.parent_findings[0]!.scope).toBe("chunk_observed");
    expect(parsed.parent_findings[0]!.evidence_refs).toEqual([]);
    expect(parsed.current_chunks[0]!.language).toBe("python");
    expect(parsed.changed_line_ranges["a.py"]).toEqual([[50, 60]]);
    expect(parsed.parent_review_id).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("applies all defaults when optional fields omitted (empty collections, null parent)", () => {
    const parsed = SelectCarryForwardInputSchema.parse({});
    expect(parsed.schema_version).toBe(1);
    expect(parsed.parent_findings).toEqual([]);
    expect(parsed.current_chunks).toEqual([]);
    expect(parsed.changed_line_ranges).toEqual({});
    expect(parsed.parent_review_id).toBeNull();
  });

  it("accepts an empty range tuple for a present file (the no-change branch)", () => {
    const parsed = SelectCarryForwardInputSchema.parse({ changed_line_ranges: { "a.py": [] } });
    expect(parsed.changed_line_ranges["a.py"]).toEqual([]);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() => SelectCarryForwardInputSchema.parse({ bogus: true })).toThrow();
  });

  it("rejects a non-UUID parent_review_id", () => {
    expect(() =>
      SelectCarryForwardInputSchema.parse({ parent_review_id: "not-a-uuid" }),
    ).toThrow();
  });

  it("rejects a non-integer line bound in changed_line_ranges", () => {
    expect(() =>
      SelectCarryForwardInputSchema.parse({ changed_line_ranges: { "a.py": [[1.5, 10]] } }),
    ).toThrow();
  });

  it("rejects a malformed change range that is not a 2-tuple", () => {
    expect(() =>
      SelectCarryForwardInputSchema.parse({ changed_line_ranges: { "a.py": [[1, 2, 3]] } }),
    ).toThrow();
  });

  it("rejects a nested finding that violates ReviewFindingV1 (end_line < start_line)", () => {
    expect(() =>
      SelectCarryForwardInputSchema.parse({
        parent_findings: [finding("a.py", 20, 1)],
      }),
    ).toThrow();
  });

  it("rejects a nested chunk that violates DiffChunkV1 (missing chunk_id)", () => {
    const bad = chunk("a.py", 1, 10);
    delete (bad as Record<string, unknown>)["chunk_id"];
    expect(() => SelectCarryForwardInputSchema.parse({ current_chunks: [bad] })).toThrow();
  });
});
