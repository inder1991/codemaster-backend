import { z } from "zod";

// Zod port of contracts/markdown_chunks/v1.py::MarkdownChunkV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in markdown_chunk.v1.parity.test.ts.
export const MAX_CHUNK_CHARS = 6000;

export const MarkdownChunkV1 = z
  .object({
    relative_path: z.string().min(1).max(500),
    chunk_index: z.number().int().gte(0),
    heading_path: z.array(z.string()).max(3).default([]),
    body: z.string().min(1).max(MAX_CHUNK_CHARS),
    start_line: z.number().int().gte(1),
    end_line: z.number().int().gte(1),
  })
  .strict();

export type MarkdownChunkV1 = z.infer<typeof MarkdownChunkV1>;
