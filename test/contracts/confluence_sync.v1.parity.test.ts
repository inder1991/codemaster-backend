import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ChunkAndEmbedInputV1,
  ChunkAndEmbedOutputV1,
  ConfluencePageV1,
  ConfluenceSpaceRef,
  EmbeddedChunkV1,
  FetchPageBodyInputV1,
  FetchPageBodyOutputV1,
  FetchSpacePagesInputV1,
  FetchSpacePagesOutputV1,
  ListActiveSpacesInputV1,
  ListActiveSpacesOutputV1,
  PageRef,
  ReconcileDeletionsInputV1,
  ReconcileDeletionsOutputV1,
  RefreshConfluenceInputV1,
  RefreshConfluenceOutputV1,
  SanitizePageInputV1,
  SanitizePageOutputV1,
  UpsertChunksInputV1,
  UpsertChunksOutputV1,
} from "../../libs/contracts/src/confluence_sync.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1
// templates. The frozen Python module resolves ConfluencePage / SanitizedPageV1 internally, so the
// oracle reflects the true embedded shapes.
const PY = "contracts.confluence_sync.v1";

// A valid embedded ConfluencePage payload (inlined dependency — distinct from contracts.confluence.*).
function confluencePage(): Record<string, unknown> {
  return {
    page_id: "123456",
    space_key: "ENG",
    title: "Service Design",
    version: 3,
    body_html: "<p>hello</p>",
    last_modified_at: "2026-06-03T10:00:00+00:00",
    labels: ["arch", "design"],
    status: "active",
  };
}

// A valid embedded SanitizedPageV1 payload (sibling-ported shape). injection_flags kept ≤1 element so
// the frozenset dump is order-invariant for the byte-equal compare.
function sanitizedPage(): Record<string, unknown> {
  return {
    page_id: "123456",
    space_key: "ENG",
    version: 3,
    title: "Service Design",
    body: "clean body text",
    labels: ["arch"],
    injection_flags: ["role_override"],
    status: "active",
    last_modified_at: "2026-06-03T10:00:00+00:00",
    pattern_set_version: 1,
  };
}

// A valid EmbeddedChunkV1 payload. embedding is EXACTLY 1024 floats (the bare-float vector). The parity
// compare STRIPS `embedding` and asserts it structurally — Pydantic dumps `0.0` (canonicalizer rejects
// bare floats), so a byte-equal compare on the vector is impossible (same as review_findings confidence).
function embeddedChunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunk_id: "0f9b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
    chunk_index: 0,
    body: "chunk text",
    content_sha256: "a".repeat(64),
    heading_path: ["Overview"],
    token_count: 12,
    embedding: Array.from({ length: 1024 }, () => 0),
    bedrock_reused_from_cache: false,
    ...overrides,
  };
}

// Strip the bare-float `embedding` from a canonical string so every OTHER field is still proven
// byte-equal. Walks `chunks[*].embedding` (and a top-level `embedding` for the EmbeddedChunkV1 case),
// re-canonicalizing so key-sort + scalar rules stay identical to the oracle path.
function dropEmbeddings(canon: string): string {
  const o = JSON.parse(canon) as Record<string, unknown>;
  if ("embedding" in o) delete o.embedding;
  const chunks = o.chunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      if (c && typeof c === "object") delete (c as Record<string, unknown>).embedding;
    }
  }
  return canonicalize(o);
}

describe("ConfluencePageV1 parity (Pydantic ↔ Zod, inlined dependency)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = confluencePage();
    const r = await pyRef({
      pyModule: "contracts.integrations.confluence.v1",
      pyCallable: "ConfluencePage",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluencePageV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version=2, labels=[], status=active) when omitted", async () => {
    const payload = {
      page_id: "1",
      space_key: "ENG",
      title: "t",
      version: 1,
      body_html: "<p>x</p>",
      last_modified_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({
      pyModule: "contracts.integrations.confluence.v1",
      pyCallable: "ConfluencePage",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    const z = ConfluencePageV1.parse(payload);
    expect(canonicalize(z)).toBe(r.out);
    expect(z.schema_version).toBe(2);
    expect(z.labels).toEqual([]);
    expect(z.status).toBe("active");
  }, 30_000);

  it("both REJECT an unknown status (_validate_status ↔ .refine())", async () => {
    const bad = { ...confluencePage(), status: "bogus_status" };
    const r = await pyRef({
      pyModule: "contracts.integrations.confluence.v1",
      pyCallable: "ConfluencePage",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...confluencePage(), bogus: 1 };
    const r = await pyRef({
      pyModule: "contracts.integrations.confluence.v1",
      pyCallable: "ConfluencePage",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => ConfluencePageV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("FetchSpacePagesInputV1 parity", () => {
  it("validates + dumps identically (schema_version default 1)", async () => {
    const payload = { space_key: "ENG" };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchSpacePagesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchSpacePagesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT space_key length 0 (min_length=1)", async () => {
    const bad = { space_key: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchSpacePagesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchSpacePagesInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid)", async () => {
    const bad = { space_key: "ENG", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchSpacePagesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchSpacePagesInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("PageRef parity", () => {
  it("validates + dumps identically", async () => {
    const payload = { page_id: "1", space_key: "ENG", version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PageRef", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(PageRef.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT version < 1 (ge=1)", async () => {
    const bad = { page_id: "1", space_key: "ENG", version: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "PageRef", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => PageRef.parse(bad)).toThrow();
  }, 30_000);
});

describe("FetchSpacePagesOutputV1 parity", () => {
  it("validates + dumps a nested tuple of PageRef identically", async () => {
    const payload = {
      pages: [
        { page_id: "1", space_key: "ENG", version: 1 },
        { page_id: "2", space_key: "ENG", version: 4 },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchSpacePagesOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchSpacePagesOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);
});

describe("FetchPageBodyInputV1 parity", () => {
  it("validates + dumps identically", async () => {
    const payload = { page_id: "1", space_key: "ENG" };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchPageBodyInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchPageBodyInputV1.parse(payload))).toBe(r.out);
  }, 30_000);
});

describe("FetchPageBodyOutputV1 parity (embeds ConfluencePage)", () => {
  it("validates + dumps a nested ConfluencePage identically", async () => {
    const payload = { page: confluencePage() };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchPageBodyOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchPageBodyOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a nested ConfluencePage with an unknown status", async () => {
    const bad = { page: { ...confluencePage(), status: "nope" } };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchPageBodyOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchPageBodyOutputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("SanitizePageInputV1 parity (embeds ConfluencePage + _require_tz)", () => {
  it("validates + dumps identically", async () => {
    const payload = { page: confluencePage(), last_modified_at: "2026-06-03T10:00:00+00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizePageInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SanitizePageInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a naive (offset-less) last_modified_at (_require_tz)", async () => {
    const bad = { page: confluencePage(), last_modified_at: "2026-06-03T10:00:00" };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizePageInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizePageInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("SanitizePageOutputV1 parity (embeds SanitizedPageV1)", () => {
  it("validates + dumps a nested SanitizedPageV1 identically", async () => {
    const payload = { sanitized: sanitizedPage() };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizePageOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SanitizePageOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a nested SanitizedPageV1 with an unknown injection_flag", async () => {
    const bad = { sanitized: { ...sanitizedPage(), injection_flags: ["not_a_pattern"] } };
    const r = await pyRef({ pyModule: PY, pyCallable: "SanitizePageOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SanitizePageOutputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ChunkAndEmbedInputV1 parity (embeds SanitizedPageV1)", () => {
  it("validates + dumps identically", async () => {
    const payload = { sanitized: sanitizedPage() };
    const r = await pyRef({ pyModule: PY, pyCallable: "ChunkAndEmbedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ChunkAndEmbedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);
});

describe("EmbeddedChunkV1 parity (bare-float embedding stripped from compare)", () => {
  it("validates + dumps identically (embedding asserted structurally)", async () => {
    const payload = embeddedChunk();
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbeddedChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(EmbeddedChunkV1.parse(payload));
    // Every field except the bare-float `embedding` is byte-equal between Pydantic and Zod.
    expect(dropEmbeddings(zodCanon)).toBe(dropEmbeddings(r.out!));
    // embedding round-trips structurally: 1024 numeric elements on both sides.
    const zEmb = (JSON.parse(zodCanon) as { embedding: ReadonlyArray<number> }).embedding;
    const pEmb = (JSON.parse(r.out!) as { embedding: ReadonlyArray<number> }).embedding;
    expect(zEmb).toHaveLength(1024);
    expect(pEmb).toHaveLength(1024);
    expect(zEmb.every((n) => typeof n === "number")).toBe(true);
  }, 30_000);

  it("applies the same defaults (heading_path=[], bedrock_reused_from_cache=false) when omitted", async () => {
    const payload = {
      chunk_id: "0f9b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
      chunk_index: 0,
      body: "x",
      content_sha256: "b".repeat(64),
      token_count: 0,
      embedding: Array.from({ length: 1024 }, () => 0),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbeddedChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const z = EmbeddedChunkV1.parse(payload);
    expect(dropEmbeddings(canonicalize(z))).toBe(dropEmbeddings(r.out!));
    expect(z.heading_path).toEqual([]);
    expect(z.bedrock_reused_from_cache).toBe(false);
  }, 30_000);

  it("both REJECT content_sha256 of the wrong length (min/max=64)", async () => {
    const bad = embeddedChunk({ content_sha256: "abc" });
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbeddedChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbeddedChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an embedding of the wrong dimensionality (len != 1024)", async () => {
    const bad = embeddedChunk({ embedding: Array.from({ length: 512 }, () => 0) });
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbeddedChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbeddedChunkV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ChunkAndEmbedOutputV1 parity (tuple of EmbeddedChunkV1, embeddings stripped)", () => {
  it("validates + dumps identically", async () => {
    const payload = { chunks: [embeddedChunk(), embeddedChunk({ chunk_index: 1 })] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ChunkAndEmbedOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ChunkAndEmbedOutputV1.parse(payload));
    expect(dropEmbeddings(zodCanon)).toBe(dropEmbeddings(r.out!));
  }, 30_000);
});

describe("UpsertChunksInputV1 parity (frozenset injection_flags + _require_tz)", () => {
  it("validates + dumps identically (embeddings stripped)", async () => {
    const payload = {
      space_key: "ENG",
      page_id: "1",
      page_title: "t",
      page_status: "active",
      page_version: 3,
      last_modified_at: "2026-06-03T10:00:00+00:00",
      raw_labels: ["arch", "design"],
      injection_flags: ["role_override"], // ≤1 element → order-invariant frozenset dump
      chunks: [embeddedChunk()],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "UpsertChunksInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(UpsertChunksInputV1.parse(payload));
    expect(dropEmbeddings(zodCanon)).toBe(dropEmbeddings(r.out!));
  }, 30_000);

  it("applies the same defaults (page_version=1, raw_labels=[], injection_flags=[])", async () => {
    const payload = {
      space_key: "ENG",
      page_id: "1",
      page_title: "t",
      page_status: "active",
      last_modified_at: "2026-06-03T10:00:00+00:00",
      chunks: [embeddedChunk()],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "UpsertChunksInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const z = UpsertChunksInputV1.parse(payload);
    expect(dropEmbeddings(canonicalize(z))).toBe(dropEmbeddings(r.out!));
    expect(z.page_version).toBe(1);
    expect(z.raw_labels).toEqual([]);
    expect(z.injection_flags).toEqual([]);
  }, 30_000);

  it("both REJECT a naive (offset-less) last_modified_at (_require_tz)", async () => {
    const bad = {
      space_key: "ENG",
      page_id: "1",
      page_title: "t",
      page_status: "active",
      last_modified_at: "2026-06-03T10:00:00",
      chunks: [embeddedChunk()],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "UpsertChunksInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => UpsertChunksInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("UpsertChunksOutputV1 parity", () => {
  it("validates + dumps identically with defaults applied", async () => {
    const payload = { upserted: 7 };
    const r = await pyRef({ pyModule: PY, pyCallable: "UpsertChunksOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const z = UpsertChunksOutputV1.parse(payload);
    expect(canonicalize(z)).toBe(r.out);
    expect(z.rejected_default_cap).toBe(0);
    expect(z.rejected_no_approval).toBe(0);
    expect(z.quarantined).toBe(false);
  }, 30_000);

  it("both REJECT a negative count (ge=0)", async () => {
    const bad = { upserted: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "UpsertChunksOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => UpsertChunksOutputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ReconcileDeletionsInputV1 / OutputV1 parity", () => {
  it("input validates + dumps identically", async () => {
    const payload = { space_key: "ENG", live_page_ids: ["1", "2", "3"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReconcileDeletionsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReconcileDeletionsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("output validates + dumps identically", async () => {
    const payload = { soft_deleted: 4 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReconcileDeletionsOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReconcileDeletionsOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);
});

describe("RefreshConfluenceInputV1 / OutputV1 parity", () => {
  it("input (empty) validates + dumps identically (schema_version default 1)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshConfluenceInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshConfluenceInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("output validates + dumps identically (failed_spaces default [])", async () => {
    const payload = {
      pages_processed: 10,
      chunks_upserted: 40,
      chunks_rejected_no_approval: 2,
      chunks_rejected_default_cap: 1,
      chunks_quarantined: 3,
      pages_soft_deleted: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshConfluenceOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const z = RefreshConfluenceOutputV1.parse(payload);
    expect(canonicalize(z)).toBe(r.out);
    expect(z.failed_spaces).toEqual([]);
  }, 30_000);

  it("output carries failed_spaces through identically", async () => {
    const payload = {
      pages_processed: 1,
      chunks_upserted: 1,
      chunks_rejected_no_approval: 0,
      chunks_rejected_default_cap: 0,
      chunks_quarantined: 0,
      pages_soft_deleted: 0,
      failed_spaces: ["ENG", "OPS"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RefreshConfluenceOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RefreshConfluenceOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);
});

describe("ConfluenceSpaceRef parity (UUID integration_id)", () => {
  it("validates + dumps identically (lowercase UUID)", async () => {
    const payload = { integration_id: "0f9b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d", space_key: "ENG" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceSpaceRef", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ConfluenceSpaceRef.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a non-UUID integration_id", async () => {
    const bad = { integration_id: "not-a-uuid", space_key: "ENG" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ConfluenceSpaceRef", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ConfluenceSpaceRef.parse(bad)).toThrow();
  }, 30_000);
});

describe("ListActiveSpacesInputV1 / OutputV1 parity", () => {
  it("input (empty) validates + dumps identically", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ListActiveSpacesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ListActiveSpacesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("output validates + dumps a nested tuple of ConfluenceSpaceRef identically", async () => {
    const payload = {
      spaces: [
        { integration_id: "0f9b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d", space_key: "ENG" },
        { integration_id: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", space_key: "OPS" },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ListActiveSpacesOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ListActiveSpacesOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);
});
