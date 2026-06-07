/**
 * Unit test for the custom Temporal payload converter (`apps/backend/src/worker/data_converter.ts`).
 *
 * Proves the converter preserves the wire contract end-to-end: a representative
 * `PersistReviewFindingsInputV1` value round-trips through `payloadConverter.toPayload(x)` →
 * `payloadConverter.fromPayload(payload)` and comes back DEEP-EQUAL to the original. Also asserts a real
 * Temporal {@link Payload} is produced (the `metadata.encoding` field is set to the `json/plain` encoding),
 * so we are genuinely exercising the Temporal marshalling path, not a JSON.stringify no-op.
 *
 * No Temporal server, no Postgres — pure in-process converter round-trip.
 */

import { TextDecoder } from "node:util";

import { describe, expect, it } from "vitest";

import { payloadConverter } from "#backend/worker/data_converter.js";

import { PersistReviewFindingsInputV1 } from "#contracts/persist_review_findings.v1.js";

// A representative fully-populated PersistReviewFindingsInputV1 (mirrors the parity-test fixture). All
// fields are wire-clean: UUID strings, ISO-free plain JSON. We `.parse()` through the contract first so
// the fixture under test is exactly the canonical Zod value the activity/workflow would marshal.
const FINDING = {
  file: "src/app.py",
  start_line: 10,
  end_line: 20,
  severity: "issue",
  category: "bug",
  title: "Null deref",
  body: "Dereferences a possibly-null pointer.",
  suggestion: "Add a guard.",
  confidence: 1,
  sources: [{ kind: "repo_path", locator: "src/app.py", excerpt: "def f():" }],
  scope: "cross_chunk",
  evidence_refs: ["ev_0123456789abcdef"],
} as const;

const AGGREGATED = {
  schema_version: 1,
  findings: [FINDING],
  dedupe_stats: {
    input_count: 5,
    exact_dropped: 1,
    semantic_merged: 1,
    capped: 0,
    semantic_skipped: false,
  },
  policy_revision: 7,
} as const;

const PRECOMPUTED_METADATA = [
  { schema_version: 1, invariant_violation_attempted: false, invariants_fired: ["evidence_required"] },
] as const;

const RAW_INPUT = {
  schema_version: 1,
  pr_id: "550e8400-e29b-41d4-a716-446655440000",
  installation_id: "123e4567-e89b-12d3-a456-426614174000",
  aggregated: AGGREGATED,
  run_id: "00000000-0000-4000-8000-000000000000",
  review_id: "11111111-1111-4111-8111-111111111111",
  policy_bundle: null,
  precomputed_metadata: PRECOMPUTED_METADATA,
} as const;

describe("payloadConverter (review-spine custom data converter)", () => {
  it("round-trips a PersistReviewFindingsInputV1 deep-equal (toPayload → fromPayload)", () => {
    const original = PersistReviewFindingsInputV1.parse(RAW_INPUT);

    const payload = payloadConverter.toPayload(original);
    const restored = payloadConverter.fromPayload<PersistReviewFindingsInputV1>(payload);

    expect(restored).toEqual(original);
  });

  it("produces a real Temporal Payload tagged with the json/plain encoding", () => {
    const original = PersistReviewFindingsInputV1.parse(RAW_INPUT);

    const payload = payloadConverter.toPayload(original);

    // A Temporal Payload carries its encoding in metadata.encoding (UTF-8 bytes). The default JSON
    // converter tags it `json/plain`.
    expect(payload.metadata).toBeDefined();
    const encodingBytes = payload.metadata?.encoding;
    expect(encodingBytes).toBeDefined();
    const encoding = new TextDecoder().decode(encodingBytes ?? new Uint8Array());
    expect(encoding).toBe("json/plain");

    // The data is the JSON-serialized value (sanity-check it decodes back to an object carrying our ids).
    const decoded = JSON.parse(new TextDecoder().decode(payload.data ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    expect(decoded.pr_id).toBe(RAW_INPUT.pr_id);
    expect(decoded.review_id).toBe(RAW_INPUT.review_id);
  });

  // Stage 1 — void activity results (persistReviewWalkthrough / releaseWorkspace return `Promise<void>`)
  // marshal as `undefined`. A `json/plain`-only converter cannot encode `undefined`, which caused the
  // spine's void activities to spuriously RETRY (the composition proof surfaced this). The composite now
  // prepends the UndefinedPayloadConverter (encoding `binary/null`) so `undefined` round-trips losslessly.
  it("round-trips a void activity result (undefined) via the binary/null encoding", () => {
    const payload = payloadConverter.toPayload(undefined);

    // `undefined` is tagged with the SDK's `binary/null` encoding, NOT `json/plain`.
    const encoding = new TextDecoder().decode(payload.metadata?.encoding ?? new Uint8Array());
    expect(encoding).toBe("binary/null");

    const restored = payloadConverter.fromPayload<undefined>(payload);
    expect(restored).toBeUndefined();
  });
});
