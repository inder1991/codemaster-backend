import { z } from "zod";

import { DefaultApprovalV1 } from "./page_approval.v1.js";
import { SanitizedPageV1 } from "./sanitized_page.v1.js";

// Zod port of contracts/confluence_sync/v1.py (frozen Python — Sub-spec A T11 + T12). Parity-validated
// in confluence_sync.v1.parity.test.ts. Every model carries the dunder marker
// `__contract_internal__ = True` (a class attribute, NOT a model field) so it never appears in
// model_dump(mode="json") — nothing to port on the wire.
//
// Every model is ConfigDict(extra="forbid", frozen=True) → .strict(). `schema_version` is a PLAIN
// Python `int` (default 1, or 2 for the embedded ConfluencePage) — NOT a Literal — so a future
// schema_version bump is not false-rejected: z.number().int().default(N).
//
// CROSS-CONTRACT IMPORTS (sibling Zod schemas — never redefined):
//   - SanitizedPageV1  ← ./sanitized_page.v1.js   (Python: contracts.confluence.sanitized_page.v1)
//   - DefaultApprovalV1 ← ./page_approval.v1.js    (Python: contracts.confluence.page_approval.v1) —
//       imported (and re-exported) by the Python module under `# noqa: F401`; it is NOT referenced by
//       any field, so it is a pure re-export here (kept for import-surface parity).
//
// INLINED DEPENDENCY (ConfluencePage):
//   The Python module embeds `ConfluencePage` from `contracts.integrations.confluence.v1` in two fields
//   (FetchPageBodyOutputV1.page, SanitizePageInputV1.page) and re-exports nothing of it. That nested
//   package is NOT ported to libs/contracts/src/ (it is a distinct package from contracts.integrations.v1,
//   which IS ported as integrations.v1.ts but contains only IntegrationKindV1 / IntegrationProbeResultV1 /
//   IntegrationMetadataV1 — no ConfluencePage). There is therefore no sibling Zod schema to import. To keep
//   the cross-contract refs honest while remaining inside the two-file edit budget, ConfluencePageV1 is
//   defined inline below as a faithful port of contracts/integrations/confluence/v1.py::ConfluencePage
//   (schema_version default 2; _validate_status AfterValidator → .refine() over ACCEPTED_PAGE_STATUSES).
//
// FLOAT NOTE (EmbeddedChunkV1.embedding): Python types it as tuple[float, ...] (length 1024). Pydantic
// model_dump(mode="json") emits the float form (`0.0`), which the repo canonicalizer REJECTS as a bare
// float (it must be Decimal-as-string or int). The parity test therefore STRIPS `embedding` from the
// byte-equal canonical compare and asserts it structurally (length + numeric range) instead — same
// strategy review_findings.v1.ts uses for its bare-float `confidence`.
//
// UUID NOTE (EmbeddedChunkV1.chunk_id, ConfluenceSpaceRef.integration_id): uuid.UUID → z.string().uuid();
// Pydantic lowercases on dump, so parity payloads use lowercase UUIDs.
//
// FROZENSET NOTE (UpsertChunksInputV1.injection_flags): Python frozenset[str] (default_factory=frozenset);
// model_dump(mode="json") emits a list in nondeterministic hash order, so the parity test uses ≤1-element
// values (order-invariant) for the byte-equal compare. Modeled as z.array(z.string()).default([]).

// Mirrors contracts/integrations/confluence/v1.py::ACCEPTED_PAGE_STATUSES (the frozenset the
// _validate_status AfterValidator checks ConfluencePage.status against). Order-invariant set membership.
export const ACCEPTED_PAGE_STATUSES: ReadonlyArray<string> = [
  "active",
  "archived",
  "current",
  "draft",
  "historical",
  "trashed",
] as const;

const ACCEPTED_PAGE_STATUS_SET: ReadonlySet<string> = new Set(ACCEPTED_PAGE_STATUSES);

// Inlined port of contracts/integrations/confluence/v1.py::ConfluencePage (see header). ConfigDict(
// extra="forbid", frozen=True) → .strict(); schema_version default 2; body_html INTENTIONALLY uncapped;
// last_modified_at is a PLAIN datetime (no _require_tz) → naive accepted ({ offset:true, local:true }).
export const ConfluencePageV1 = z
  .object({
    schema_version: z.number().int().default(2),
    page_id: z.string().min(1).max(64),
    space_key: z.string().min(1).max(64),
    title: z.string().min(1).max(1024),
    version: z.number().int().gte(1),
    // body_html: str — uncapped (Confluence design docs round-trip without truncation).
    body_html: z.string(),
    last_modified_at: z.string().datetime({ offset: true, local: true }),
    // labels: tuple[str, ...] = Field(default=(), max_length=100).
    labels: z.array(z.string()).max(100).default([]),
    // status: Annotated[str, AfterValidator(_validate_status)] = "active".
    status: z
      .string()
      .default("active")
      .refine((s) => ACCEPTED_PAGE_STATUS_SET.has(s), {
        message: `unknown status; expected one of ${JSON.stringify([...ACCEPTED_PAGE_STATUSES])}`,
      }),
  })
  .strict();
export type ConfluencePageV1 = z.infer<typeof ConfluencePageV1>;

// Re-export the sibling-ported approval shape the Python module imports under `# noqa: F401` (pure
// import-surface parity; not referenced by any field below).
export { DefaultApprovalV1 };

// FetchSpacePagesInputV1 — input for fetch_space_pages_activity.
export const FetchSpacePagesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string().min(1).max(64),
  })
  .strict();
export type FetchSpacePagesInputV1 = z.infer<typeof FetchSpacePagesInputV1>;

// PageRef — a minimal page reference from a list response.
export const PageRef = z
  .object({
    schema_version: z.number().int().default(1),
    page_id: z.string(),
    space_key: z.string(),
    version: z.number().int().gte(1),
  })
  .strict();
export type PageRef = z.infer<typeof PageRef>;

// FetchSpacePagesOutputV1 — output of fetch_space_pages_activity. pages: tuple[PageRef, ...] (required).
export const FetchSpacePagesOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    pages: z.array(PageRef),
  })
  .strict();
export type FetchSpacePagesOutputV1 = z.infer<typeof FetchSpacePagesOutputV1>;

// FetchPageBodyInputV1 — input for fetch_page_body_activity.
export const FetchPageBodyInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    page_id: z.string(),
    space_key: z.string(),
  })
  .strict();
export type FetchPageBodyInputV1 = z.infer<typeof FetchPageBodyInputV1>;

// FetchPageBodyOutputV1 — output of fetch_page_body_activity. page: ConfluencePage (inlined above).
export const FetchPageBodyOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    page: ConfluencePageV1,
  })
  .strict();
export type FetchPageBodyOutputV1 = z.infer<typeof FetchPageBodyOutputV1>;

// SanitizePageInputV1 — input for sanitize_page_activity. last_modified_at carries _require_tz (tz-aware
// only) → z.string().datetime({ offset: true }) (a naive value is rejected by BOTH Pydantic and Zod).
export const SanitizePageInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    page: ConfluencePageV1,
    last_modified_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type SanitizePageInputV1 = z.infer<typeof SanitizePageInputV1>;

// SanitizePageOutputV1 — output of sanitize_page_activity. sanitized: SanitizedPageV1 (sibling).
export const SanitizePageOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    sanitized: SanitizedPageV1,
  })
  .strict();
export type SanitizePageOutputV1 = z.infer<typeof SanitizePageOutputV1>;

// ChunkAndEmbedInputV1 — input for chunk_and_embed_activity. sanitized: SanitizedPageV1 (sibling).
export const ChunkAndEmbedInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    sanitized: SanitizedPageV1,
  })
  .strict();
export type ChunkAndEmbedInputV1 = z.infer<typeof ChunkAndEmbedInputV1>;

// EmbeddedChunkV1 — one embedded chunk produced by chunk_and_embed_activity. `embedding` is a bare-float
// vector of EXACTLY 1024 elements (min_length=1024, max_length=1024) — see FLOAT NOTE in the header.
export const EmbeddedChunkV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // chunk_id: uuid.UUID → canonical lowercase string.
    chunk_id: z.string().uuid(),
    chunk_index: z.number().int().gte(0),
    body: z.string(),
    // content_sha256: str = Field(min_length=64, max_length=64).
    content_sha256: z.string().min(64).max(64),
    // heading_path: tuple[str, ...] = Field(default=(), max_length=10).
    heading_path: z.array(z.string()).max(10).default([]),
    token_count: z.number().int().gte(0),
    // embedding: tuple[float, ...] = Field(min_length=1024, max_length=1024).
    embedding: z.array(z.number()).min(1024).max(1024),
    // bedrock_reused_from_cache: bool = False (Audit P0-4).
    bedrock_reused_from_cache: z.boolean().default(false),
  })
  .strict();
export type EmbeddedChunkV1 = z.infer<typeof EmbeddedChunkV1>;

// ChunkAndEmbedOutputV1 — output of chunk_and_embed_activity. chunks: tuple[EmbeddedChunkV1, ...].
export const ChunkAndEmbedOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunks: z.array(EmbeddedChunkV1),
  })
  .strict();
export type ChunkAndEmbedOutputV1 = z.infer<typeof ChunkAndEmbedOutputV1>;

// UpsertChunksInputV1 — input for upsert_chunks_activity. last_modified_at carries _require_tz (tz-aware
// only). injection_flags is a frozenset[str] (default_factory=frozenset) → z.array (see FROZENSET NOTE).
export const UpsertChunksInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string(),
    page_id: z.string(),
    page_title: z.string(),
    page_status: z.string(),
    page_version: z.number().int().gte(1).default(1),
    last_modified_at: z.string().datetime({ offset: true }),
    raw_labels: z.array(z.string()).max(100).default([]),
    injection_flags: z.array(z.string()).default([]),
    chunks: z.array(EmbeddedChunkV1),
  })
  .strict();
export type UpsertChunksInputV1 = z.infer<typeof UpsertChunksInputV1>;

// UpsertChunksOutputV1 — output of upsert_chunks_activity.
export const UpsertChunksOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    upserted: z.number().int().gte(0),
    rejected_default_cap: z.number().int().gte(0).default(0),
    rejected_no_approval: z.number().int().gte(0).default(0),
    quarantined: z.boolean().default(false),
  })
  .strict();
export type UpsertChunksOutputV1 = z.infer<typeof UpsertChunksOutputV1>;

// ReconcileDeletionsInputV1 — input for reconcile_deletions_activity.
export const ReconcileDeletionsInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    space_key: z.string(),
    // live_page_ids: pages observed during this sync; absent pages get soft-deleted.
    live_page_ids: z.array(z.string()),
  })
  .strict();
export type ReconcileDeletionsInputV1 = z.infer<typeof ReconcileDeletionsInputV1>;

// ReconcileDeletionsOutputV1 — output of reconcile_deletions_activity.
export const ReconcileDeletionsOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    soft_deleted: z.number().int().gte(0),
  })
  .strict();
export type ReconcileDeletionsOutputV1 = z.infer<typeof ReconcileDeletionsOutputV1>;

// RefreshConfluenceInputV1 — workflow-level input for ConfluenceIngestWorkflow (T12). No tunables.
export const RefreshConfluenceInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
  })
  .strict();
export type RefreshConfluenceInputV1 = z.infer<typeof RefreshConfluenceInputV1>;

// RefreshConfluenceOutputV1 — workflow-level output for ConfluenceIngestWorkflow (T12). failed_spaces:
// tuple[str, ...] = () (default empty).
export const RefreshConfluenceOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    pages_processed: z.number().int().gte(0),
    chunks_upserted: z.number().int().gte(0),
    chunks_rejected_no_approval: z.number().int().gte(0),
    chunks_rejected_default_cap: z.number().int().gte(0),
    chunks_quarantined: z.number().int().gte(0),
    pages_soft_deleted: z.number().int().gte(0),
    failed_spaces: z.array(z.string()).default([]),
  })
  .strict();
export type RefreshConfluenceOutputV1 = z.infer<typeof RefreshConfluenceOutputV1>;

// ConfluenceSpaceRef — minimal reference to one active confluence_space integration row.
export const ConfluenceSpaceRef = z
  .object({
    schema_version: z.number().int().default(1),
    // integration_id: uuid.UUID → canonical lowercase string.
    integration_id: z.string().uuid(),
    space_key: z.string().min(1).max(64),
  })
  .strict();
export type ConfluenceSpaceRef = z.infer<typeof ConfluenceSpaceRef>;

// ListActiveSpacesInputV1 — input for list_active_confluence_spaces_activity (T12).
export const ListActiveSpacesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
  })
  .strict();
export type ListActiveSpacesInputV1 = z.infer<typeof ListActiveSpacesInputV1>;

// ListActiveSpacesOutputV1 — output of list_active_confluence_spaces_activity (T12).
export const ListActiveSpacesOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    spaces: z.array(ConfluenceSpaceRef),
  })
  .strict();
export type ListActiveSpacesOutputV1 = z.infer<typeof ListActiveSpacesOutputV1>;
