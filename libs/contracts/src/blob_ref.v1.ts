import { z } from "zod";

// Minimal Zod port of the BlobRef portion of
// vendor/codemaster-py/codemaster/adapters/blobstore_port.py::BlobRef (frozen Python).
//
// BlobRef is an opaque handle to a stored blob — "pass these around; never bytes". It is the
// `payload_blob_ref` field of LlmInvokeResultV1, so the LLM-invoke contract needs it ported. Only the
// contract (not the BlobStorePort Protocol or any concrete adapter) is in scope for this slice; the
// production object-store adapter is a deferred follow-up.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// The Python field validator `_no_whitespace_only` rejects whitespace-only installation_id / key /
// content_type; the `min_length=1` + a `.refine` trimming check reproduce that. `created_at` is a plain
// `datetime` (timezone-aware in practice; the in-memory adapter mints `datetime.now(timezone.utc)`), so
// the wire form is an RFC3339 string the canonicalizer normalizes to `.ffffff+00:00`.
export const BlobRef = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, { message: "must be non-empty / non-whitespace" }),
    key: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, { message: "must be non-empty / non-whitespace" }),
    byte_size: z.number().int().gte(0),
    content_type: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, { message: "must be non-empty / non-whitespace" }),
    created_at: z.string().datetime({ offset: true, local: true }),
  })
  .strict();

export type BlobRef = z.infer<typeof BlobRef>;
