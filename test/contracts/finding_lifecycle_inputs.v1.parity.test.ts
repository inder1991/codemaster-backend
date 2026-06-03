import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  DEGRADED_OUTCOMES,
  DegradedInputV1,
  FinalizedInputV1,
  LIFECYCLE_RFIDS_MAX_LENGTH,
  SkippedInputV1,
} from "../../libs/contracts/src/finding_lifecycle_inputs.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `ModelV1(**payload).model_dump(mode="json")`) and through Zod
// (`ModelV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// UUIDs are lowercased on Pydantic dump, so payloads use lowercase UUIDs (gotcha-6).
const PY = "contracts.finding_lifecycle_inputs.v1";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const REVIEW_ID = "22222222-2222-2222-2222-222222222222";
const PR_ID = "33333333-3333-3333-3333-333333333333";
const RFID_A = "44444444-4444-4444-4444-444444444444";
const RFID_B = "55555555-5555-5555-5555-555555555555";

describe("FinalizedInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A, RFID_B],
      comment_ids: [1001, 1002],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FinalizedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted, and empty tuples", async () => {
    const payload = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [],
      comment_ids: [],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FinalizedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("lowercases UUIDs identically (uppercase input → lowercase dump)", async () => {
    const payload = {
      installation_id: "inst-123",
      run_id: RUN_ID.toUpperCase(),
      review_id: REVIEW_ID,
      rfids: [RFID_A.toUpperCase()],
      comment_ids: [7],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FinalizedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a future schema_version (int default, NOT a literal)", async () => {
    const payload = {
      schema_version: 2,
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      comment_ids: [9],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FinalizedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a parity violation (len(rfids) != len(comment_ids))", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A, RFID_B],
      comment_ids: [1],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => FinalizedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty installation_id (min_length=1)", async () => {
    const bad = {
      installation_id: "",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      comment_ids: [1],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FinalizedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed UUID (run_id not a UUID)", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: "not-a-uuid",
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      comment_ids: [1],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FinalizedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT more rfids than the cap (max_length)", async () => {
    const over = LIFECYCLE_RFIDS_MAX_LENGTH + 1;
    const rfids = Array.from({ length: over }, () => RFID_A);
    const comment_ids = Array.from({ length: over }, (_unused, i) => i);
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids,
      comment_ids,
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FinalizedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      comment_ids: [1],
      posted_review_pr_id: PR_ID,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FinalizedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FinalizedInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("SkippedInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A, RFID_B],
      reasons: ["not in diff", "binary file"],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SkippedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SkippedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) and empty tuples when omitted", async () => {
    const payload = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [],
      reasons: [],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SkippedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(SkippedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a parity violation (len(rfids) != len(reasons))", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A, RFID_B],
      reasons: ["only one"],
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SkippedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SkippedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      reasons: ["r"],
      posted_review_pr_id: PR_ID,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "SkippedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => SkippedInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("DegradedInputV1 parity (Pydantic ↔ Zod)", () => {
  it("round-trips every degraded outcome identically", async () => {
    for (const outcome of DEGRADED_OUTCOMES) {
      const payload = {
        installation_id: "inst-123",
        run_id: RUN_ID,
        review_id: REVIEW_ID,
        rfids: [RFID_A, RFID_B],
        outcome,
        posted_review_pr_id: PR_ID,
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "DegradedInputV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(DegradedInputV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      outcome: "failed",
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DegradedInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DegradedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an outcome owned by the finalize/skip setters (inline_delivered)", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      outcome: "inline_delivered",
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DegradedInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError (pattern mismatch)
    expect(() => DegradedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an outcome not in the degraded vocabulary (pattern violation)", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      outcome: "bogus_outcome",
      posted_review_pr_id: PR_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DegradedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DegradedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: "inst-123",
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      rfids: [RFID_A],
      outcome: "failed",
      posted_review_pr_id: PR_ID,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DegradedInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DegradedInputV1.parse(bad)).toThrow();
  }, 30_000);
});
