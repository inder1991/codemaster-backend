// confluence_source — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/confluence_source.py
//   (Sprint 13 / S13.3.1c; updated S21.LLM-DUAL.1-PLATFORM PR 3 Task 9).
//
// Pure-function helpers the hybrid retriever consumes to fan out queries against the
// `core.confluence_chunks` table alongside the repo + knowledge sources. Kept in its own module so the
// hybrid_retriever stays touch-free — the retriever just composes these helpers.
//
// ── PLATFORM-SHARED CORPUS ───────────────────────────────────────────────────────────────────────
// After migration 0063 the `confluence_chunks` table is a platform-wide knowledge corpus shared across
// all 60+ installations. `ConfluenceRetrievedChunk` does NOT carry `installation_id`;
// `ConfluenceRetrievalPort.search()` does NOT accept `installation_id`. mergeSources is unaffected (it
// never read `installation_id`). The cross-tenant access posture is enforced at the production adapter
// (`PostgresConfluenceRetrieval`) — see `apps/backend/src/adapters/postgres_confluence_retrieval.ts`.
//
// This module exposes:
//   - `ConfluenceRetrievalPort` — the narrow type the production wires against pgvector; tests inject
//     in-memory fakes.
//   - `ConfluenceRetrievedChunk` — typed result row carrying the locked `source="confluence"` tag,
//     space_key + page_id + version metadata for the citation renderer, and the chunk text (already
//     wrapped in `<doc trust="untrusted">…</doc>` by the ingest worker).
//   - `mergeSources(...)` — dedupes near-duplicate (Confluence vs repo / knowledge) candidates by
//     content-hash similarity ≥ 0.92 before passing to the reranker.
//   - `sourceBreakdown(...)` — counter the `retrieval.hybrid_retrieve` OTel span attribute consumes.
//
// Trust-tier rule: each chunk's text is preserved verbatim from the ingest worker — the reviewer is
// responsible for the LLM prompt's `<doc trust="untrusted">…</doc>` wrapping (already applied at ingest
// time per S13.3.1b's redactor).

import { createHash } from "node:crypto";

/** Python `SourceLabel = Literal["repo", "knowledge", "confluence"]`. */
export type SourceLabel = "repo" | "knowledge" | "confluence";

/**
 * Near-duplicate threshold: anything ≥ 0.92 simhash overlap is treated as a duplicate of an earlier
 * chunk and dropped (locked AC #1 edge case from S13.3.1c). Python `NEAR_DUPLICATE_THRESHOLD`.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.92;

/**
 * One chunk surfaced from the `confluence_chunks` ANN index (Python `ConfluenceRetrievedChunk`
 * dataclass). The corpus is platform-shared (migration 0063 dropped `installation_id`); this type does
 * not carry it. `score` is the cosine-similarity score from pgvector; the rerank stage replaces this
 * with a deterministic rank later.
 *
 * Sub-spec B T10 additive fields (defaulted at construction for back-compat):
 *   - `labels`: canonical labels persisted on the chunk row (Stage 1.5 match_specificity scoring).
 *   - `age_days`: days since `last_modified_at` (computed at retrieval time; Stage-3 freshness signal).
 *   - `token_count`: cached token count (default-pool budget reservation, T11 floors).
 *   - `match_specificity_score`: filled in by the HybridRetriever after retrieval; the adapter does NOT
 *     compute it (the formula needs effective_labels from the caller's KnowledgeQueryV1). Default 0.
 */
export type ConfluenceRetrievedChunk = {
  chunk_id: string;
  space_key: string;
  page_id: string;
  page_title: string;
  version: number;
  chunk_text: string;
  score: number;
  redaction_applied: boolean;
  source: SourceLabel;
  labels: ReadonlyArray<string>;
  age_days: number;
  token_count: number;
  match_specificity_score: number;
};

/**
 * The narrow surface the retrieval layer depends on (Python `ConfluenceRetrievalPort` Protocol).
 *
 * The corpus is platform-shared (migration 0063); no `installation_id` filter is applied. Production
 * wraps a pgvector ANN query against `confluence_chunks`; tests inject an in-memory list.
 */
export type ConfluenceRetrievalPort = {
  search(args: {
    queryEmbedding: ReadonlyArray<number>;
    topK: number;
    effectiveLabels?: ReadonlySet<string>;
  }): Promise<ReadonlyArray<ConfluenceRetrievedChunk>>;
};

// ─── Pure helpers ────────────────────────────────────────────────────────────────────────────────

/**
 * Build the dict the `retrieval.hybrid_retrieve` OTel span attribute carries (Python
 * `source_breakdown`). Locked field names — telemetry consumers parse these by string.
 */
export function sourceBreakdown(args: {
  repoCount: number;
  knowledgeCount: number;
  confluenceCount: number;
}): Record<string, number> {
  return {
    repo: args.repoCount,
    knowledge: args.knowledgeCount,
    confluence: args.confluenceCount,
  };
}

/** Counters mergeSources returns (Python `counters` dict). */
export type MergeCounters = {
  repo: number;
  knowledge: number;
  confluence: number;
  deduped: number;
};

export type MergeSourcesArgs = {
  repoChunks: Iterable<unknown>;
  knowledgeChunks: Iterable<unknown>;
  confluenceChunks: Iterable<ConfluenceRetrievedChunk>;
  /** Default {@link NEAR_DUPLICATE_THRESHOLD}. */
  nearDuplicateThreshold?: number;
  /** Attr name carrying the chunk text. Default `"chunk_text"`. */
  textAttr?: string;
};

/**
 * Deduplicate cross-source near-duplicates while preserving the original ordering (1:1 with the Python
 * `merge_sources`). Returns the merged list + a counter dict for telemetry.
 *
 * Strategy: a deterministic sim-hash (cheap, no third-party dep) is a fast proxy for content overlap.
 * Anything ≥ `nearDuplicateThreshold` against an already-kept chunk is dropped. The drop-set is biased
 * toward Confluence (repo / knowledge wins on tie) because reviewers prefer code citations when
 * available — dedup just prevents the walkthrough from showing two near-identical paragraphs.
 */
export function mergeSources(
  args: MergeSourcesArgs,
): readonly [Array<unknown>, MergeCounters] {
  const threshold = args.nearDuplicateThreshold ?? NEAR_DUPLICATE_THRESHOLD;
  const textAttr = args.textAttr ?? "chunk_text";

  const kept: Array<unknown> = [];
  const keptHashes: Array<Set<number>> = [];
  const counters: MergeCounters = { repo: 0, knowledge: 0, confluence: 0, deduped: 0 };

  const consider = (chunk: unknown, source: SourceLabel): void => {
    const text = getText(chunk, textAttr);
    const sig = simhash(text);
    for (const prior of keptHashes) {
      const sim = jaccardSimilarity(sig, prior);
      if (sim >= threshold) {
        counters.deduped += 1;
        return;
      }
    }
    kept.push(chunk);
    keptHashes.push(sig);
    // eslint-disable-next-line security/detect-object-injection -- `source` is the typed SourceLabel union (closed set: "repo"|"knowledge"|"confluence"), indexing a fixed-shape counters record, not user input
    counters[source] += 1;
  };

  // Repo + knowledge first so their hashes seed the dedup set.
  for (const c of args.repoChunks) {
    consider(c, "repo");
  }
  for (const c of args.knowledgeChunks) {
    consider(c, "knowledge");
  }
  for (const c of args.confluenceChunks) {
    consider(c, "confluence");
  }
  return [kept, counters] as const;
}

/**
 * Read the chunk's text, falling back to "" when absent.
 *
 * Reads `chunk[attr]` (default `chunk_text`) for RAW rows. DIVERGENCE from the frozen Python `_get_text`
 * (which only read `chunk_text`): the HybridRetriever feeds WRAPPED `ScoredKnowledgeChunkV1` envelopes —
 * whose text lives at `.chunk.body`, NOT `.chunk_text` — into mergeSources for EVERY source (repo,
 * knowledge, and wrapped confluence). With only the `chunk_text` read, getText returned "" for every
 * wrapped envelope, so the near-duplicate protection was entirely INERT on the hybrid path (a latent gap
 * faithfully reproduced from Python). The `.chunk.body` fallback activates dedup on the shapes the
 * retriever actually passes, honoring the documented near-duplicate-protection intent.
 */
function getText(chunk: unknown, attr: string): string {
  if (chunk === null || typeof chunk !== "object") {
    return "";
  }
  // `Reflect.get` reads the named property without a computed-member-access object-injection sink.
  const value: unknown = Reflect.get(chunk, attr);
  if (typeof value === "string") {
    return value;
  }
  // Wrapped ScoredKnowledgeChunkV1 — the text is on the inner `.chunk.body`.
  const inner: unknown = Reflect.get(chunk, "chunk");
  if (inner !== null && typeof inner === "object") {
    const body: unknown = Reflect.get(inner, "body");
    if (typeof body === "string") {
      return body;
    }
  }
  return "";
}

// ─── Lightweight simhash (stdlib only) ─────────────────────────────────────────────────────────────

/**
 * Cheap content-fingerprint: the set of MD5-hashed n-gram shingles (1:1 with the Python `_simhash`).
 * Compared via Jaccard similarity by {@link jaccardSimilarity}. The shingle key is produced by
 * {@link gramKey} (see its doc for the 48-bit JS-safe equivalence to Python's 64-bit digest read).
 */
export function simhash(text: string, opts: { nGrams?: number } = {}): Set<number> {
  const nGrams = opts.nGrams ?? 5;
  if (text === "") {
    return new Set<number>();
  }
  // Normalise: lowercase + strip the trust-tier wrapper so a Confluence chunk and a repo doc-comment
  // with similar paragraph text actually match (1:1 with the Python normalisation).
  const normalised = text
    .toLowerCase()
    .replaceAll('<doc trust="untrusted">', "")
    .replaceAll("</doc>", "");
  const shingles = new Set<number>();
  for (let i = 0; i <= normalised.length - nGrams; i += 1) {
    const gram = normalised.slice(i, i + nGrams);
    shingles.add(gramKey(gram));
  }
  return shingles;
}

/**
 * Deterministic 53-bit-safe shingle key derived from the MD5 of the n-gram.
 *
 * Python keys the shingle set on `int.from_bytes(md5(gram).digest()[:8], "big")` — a 64-bit integer.
 * The ONLY operation performed on the set is membership / Jaccard overlap, so the key need only be a
 * collision-resistant function of the gram bytes, NOT the exact 64-bit value. We read the first 6 bytes
 * (48 bits) of the same MD5 digest as a JS-safe integer; 48 bits gives a ~2.8e14 keyspace — far above
 * the n-gram cardinality of any single chunk — so the parity-relevant property (two identical grams →
 * identical key; two distinct grams → distinct keys with overwhelming probability) holds, and Jaccard
 * overlap between two chunks matches the Python set-overlap byte-for-byte on the observed corpus. The
 * empty / identical / near-dup parity vectors in the unit test confirm the equivalence.
 */
function gramKey(gram: string): number {
  const digest = createHash("md5").update(gram, "utf8").digest();
  // First 6 bytes, big-endian → a 48-bit integer (safe in a JS double, which holds 53-bit integers).
  return (
    digest[0]! * 2 ** 40 +
    digest[1]! * 2 ** 32 +
    digest[2]! * 2 ** 24 +
    digest[3]! * 2 ** 16 +
    digest[4]! * 2 ** 8 +
    digest[5]!
  );
}

/** Jaccard similarity; returns 0.0 when either set is empty (1:1 with the Python `_hamming_similarity`). */
export function jaccardSimilarity(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}
