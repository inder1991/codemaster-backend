import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  FinalizeReviewRunInput,
  RecordReviewLifecycleEventInput,
  RecordRunCancelledInput,
  RecordRunFailedInput,
} from "#contracts/record_review_lifecycle_inputs.v1.js";

afterAll(() => shutdownRef());

// Parity oracle for the four run-state lifecycle activity inputs (frozen Python
// `codemaster.activities._record_review_lifecycle_inputs`). Each Pydantic model is
// `model_config = ConfigDict(extra="ignore")` → the Zod port `.strip()`s unknown keys (NOT `.strict()`).
//
// Byte-parity is asserted against the long-lived frozen-Python ref process: we construct the model in
// both layers with the same kwargs and compare the canonical-JSON `model_dump(mode="json")`.
const PY_MOD = "codemaster.activities._record_review_lifecycle_inputs";

// Canonical-LOWERCASE UUIDs (Pydantic lowercases UUID fields on dump).
const INSTALLATION_ID = "0123abcd-4567-89ab-cdef-0123456789ab";
const RUN_ID = "0123abcd-4567-89ab-cdef-0123456789ac";
const REVIEW_ID = "0123abcd-4567-89ab-cdef-0123456789ad";

describe("RecordReviewLifecycleEventInput", () => {
  it("applies the schema_version=2 + provider + payload defaults", () => {
    const parsed = RecordReviewLifecycleEventInput.parse({
      installation_id: INSTALLATION_ID,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      event_type: "ANALYZED",
    });
    expect(parsed.schema_version).toBe(2);
    expect(parsed.provider).toBe("github");
    expect(parsed.payload).toEqual({});
    expect(parsed.installation_id).toBe(INSTALLATION_ID);
    expect(parsed.event_type).toBe("ANALYZED");
  });

  it("lowercases UUID fields (Pydantic dumps lowercase canonical form)", () => {
    const parsed = RecordReviewLifecycleEventInput.parse({
      installation_id: INSTALLATION_ID.toUpperCase(),
      run_id: RUN_ID.toUpperCase(),
      review_id: REVIEW_ID.toUpperCase(),
      event_type: "ANALYSIS_STARTED",
    });
    expect(parsed.installation_id).toBe(INSTALLATION_ID);
    expect(parsed.run_id).toBe(RUN_ID);
    expect(parsed.review_id).toBe(REVIEW_ID);
  });

  it("strips an unknown top-level key (.strip() ↔ Pydantic extra=ignore)", () => {
    const parsed = RecordReviewLifecycleEventInput.parse({
      installation_id: INSTALLATION_ID,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      event_type: "ANALYZED",
      bogus: true,
    }) as Record<string, unknown>;
    expect(parsed["bogus"]).toBeUndefined();
  });

  it("rejects a non-UUID installation_id", () => {
    expect(() =>
      RecordReviewLifecycleEventInput.parse({
        installation_id: "not-a-uuid",
        run_id: RUN_ID,
        review_id: REVIEW_ID,
        event_type: "ANALYZED",
      }),
    ).toThrow();
  });

  it("rejects a missing required event_type", () => {
    expect(() =>
      RecordReviewLifecycleEventInput.parse({
        installation_id: INSTALLATION_ID,
        run_id: RUN_ID,
        review_id: REVIEW_ID,
      }),
    ).toThrow();
  });

  it("rejects an empty provider (min_length=1)", () => {
    expect(() =>
      RecordReviewLifecycleEventInput.parse({
        installation_id: INSTALLATION_ID,
        run_id: RUN_ID,
        review_id: REVIEW_ID,
        event_type: "ANALYZED",
        provider: "",
      }),
    ).toThrow();
  });

  it("is byte-identical to the frozen Python dump (defaults applied)", async () => {
    const r = await pyRef({
      pyModule: PY_MOD,
      pyCallable: "RecordReviewLifecycleEventInput",
      kwargs: {
        installation_id: INSTALLATION_ID,
        run_id: RUN_ID,
        review_id: REVIEW_ID,
        event_type: "ANALYZED",
      },
    });
    expect(r.ok, r.err).toBe(true);
    const parsed = RecordReviewLifecycleEventInput.parse({
      installation_id: INSTALLATION_ID,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      event_type: "ANALYZED",
    });
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);

  it("is byte-identical to the frozen Python dump (populated payload)", async () => {
    const kwargs = {
      installation_id: INSTALLATION_ID,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      provider: "github",
      event_type: "ANALYSIS_STARTED",
      payload: { findings_count: 3, note: "started" },
    };
    const r = await pyRef({
      pyModule: PY_MOD,
      pyCallable: "RecordReviewLifecycleEventInput",
      kwargs,
    });
    expect(r.ok, r.err).toBe(true);
    const parsed = RecordReviewLifecycleEventInput.parse(kwargs);
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);
});

describe("FinalizeReviewRunInput", () => {
  it("applies the attempt=1 + null duration_ms/worker_id defaults", () => {
    const parsed = FinalizeReviewRunInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID });
    expect(parsed.attempt).toBe(1);
    expect(parsed.duration_ms).toBeNull();
    expect(parsed.worker_id).toBeNull();
  });

  it("rejects attempt < 1 (ge=1)", () => {
    expect(() =>
      FinalizeReviewRunInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID, attempt: 0 }),
    ).toThrow();
  });

  it("rejects a negative duration_ms (ge=0)", () => {
    expect(() =>
      FinalizeReviewRunInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID, duration_ms: -1 }),
    ).toThrow();
  });

  it("is byte-identical to the frozen Python dump (defaults applied)", async () => {
    const r = await pyRef({
      pyModule: PY_MOD,
      pyCallable: "FinalizeReviewRunInput",
      kwargs: { run_id: RUN_ID, review_id: REVIEW_ID },
    });
    expect(r.ok, r.err).toBe(true);
    const parsed = FinalizeReviewRunInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID });
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);

  it("is byte-identical to the frozen Python dump (fully populated)", async () => {
    const kwargs = {
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      attempt: 2,
      duration_ms: 1234,
      worker_id: "worker-7",
    };
    const r = await pyRef({ pyModule: PY_MOD, pyCallable: "FinalizeReviewRunInput", kwargs });
    expect(r.ok, r.err).toBe(true);
    const parsed = FinalizeReviewRunInput.parse(kwargs);
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);
});

describe("RecordRunFailedInput", () => {
  it("applies the attempt=1 default", () => {
    const parsed = RecordRunFailedInput.parse({
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      reason: "boom",
    });
    expect(parsed.attempt).toBe(1);
    expect(parsed.reason).toBe("boom");
  });

  it("rejects an empty reason (min_length=1)", () => {
    expect(() =>
      RecordRunFailedInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID, reason: "" }),
    ).toThrow();
  });

  it("rejects a reason over 500 chars (max_length=500)", () => {
    expect(() =>
      RecordRunFailedInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID, reason: "x".repeat(501) }),
    ).toThrow();
  });

  it("is byte-identical to the frozen Python dump", async () => {
    const kwargs = { run_id: RUN_ID, review_id: REVIEW_ID, reason: "ValueError: boom", attempt: 3 };
    const r = await pyRef({ pyModule: PY_MOD, pyCallable: "RecordRunFailedInput", kwargs });
    expect(r.ok, r.err).toBe(true);
    const parsed = RecordRunFailedInput.parse(kwargs);
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);
});

describe("RecordRunCancelledInput", () => {
  it("applies the attempt=1 default", () => {
    const parsed = RecordRunCancelledInput.parse({
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      reason: "temporal_cancellation",
    });
    expect(parsed.attempt).toBe(1);
    expect(parsed.reason).toBe("temporal_cancellation");
  });

  it("rejects an empty reason (min_length=1)", () => {
    expect(() =>
      RecordRunCancelledInput.parse({ run_id: RUN_ID, review_id: REVIEW_ID, reason: "" }),
    ).toThrow();
  });

  it("is byte-identical to the frozen Python dump", async () => {
    const kwargs = {
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      reason: "temporal_cancellation",
      attempt: 1,
    };
    const r = await pyRef({ pyModule: PY_MOD, pyCallable: "RecordRunCancelledInput", kwargs });
    expect(r.ok, r.err).toBe(true);
    const parsed = RecordRunCancelledInput.parse(kwargs);
    expect(canonicalize(parsed)).toBe(r.out);
  }, 30_000);
});
