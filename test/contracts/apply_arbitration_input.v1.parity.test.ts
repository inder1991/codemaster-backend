import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyApplyArbitrationInput, shutdownArbitrateRef } from "../parity/arbitrate_oracle.js";
import { ApplyArbitrationInputV1 } from "#contracts/apply_arbitration_input.v1.js";

afterAll(() => shutdownArbitrateRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (`ApplyArbitrationInput(**payload)
// .model_dump(mode="json")`, via the arbitrate ref's `apply_arbitration_input` op) and through Zod
// (`ApplyArbitrationInputV1.parse(payload)`), then diff canonical JSON. Accept/reject must agree on both sides.
//
// The Python class is defined inline in the activity module (not a `contracts/` module); the oracle imports
// it from there. Key wire-shape coverage:
//   - tier2_findings — the LIST-OF-PAIRS [uuid, ReviewFindingV1] JSON-safe shape.
//   - tier2_review_finding_id_by_arbitration_id — the JSON-safe dict[str, uuid.UUID] (string keys → uuid values).
//   - now — a Pydantic datetime → RFC3339 ("Z") on dump; canonicalize normalizes both sides.

const INSTALL = "11111111-1111-1111-1111-111111111111";
const PR = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";
const REVIEW = "44444444-4444-4444-4444-444444444444";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "bbbbbbbb-0000-4000-8000-000000000002";
const RFID = "cccccccc-0000-4000-8000-000000000003";

function analysisFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finding_id: T1,
    tool: "ruff",
    rule_id: "F401",
    file: "x.py",
    start_line: 1,
    end_line: 1,
    severity_raw: "warning",
    message: "unused import",
    ...overrides,
  };
}

function reviewFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "y.py",
    start_line: 2,
    end_line: 2,
    severity: "issue",
    category: "bug",
    title: "t",
    body: "b",
    confidence: 0.5,
    ...overrides,
  };
}

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { target_finding_id: T1, confidence: "0.95", reason: "fp", ...overrides };
}

/**
 * Deep-clone with every `confidence` key removed. The nested ReviewFindingV1's `confidence` is a bare
 * Python float (Pydantic dumps 0.5 as `0.5`; JS as `0.5` too, but the shared canonicalize() REJECTS bare
 * floats by convention — review item g). Stripping it from BOTH sides keeps the canonical diff focused on
 * the envelope shape (the finding's confidence float is asserted byte-equal by the ReviewFindingV1 contract
 * tests; here we care only that the envelope threads the pair through identically). Mirrors
 * dedup.parity.test.ts::stripConfidence.
 */
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

describe("ApplyArbitrationInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      installation_id: INSTALL,
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [analysisFinding()],
      tier2_findings: [[T2, reviewFinding()]],
      tier2_review_finding_id_by_arbitration_id: { [T2]: RFID },
      intents: [intent()],
      model: "claude-test",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(payload);
    expect(r.ok, r.err).toBe(true);
    // strip the nested ReviewFindingV1.confidence bare float (asserted by its own contract test).
    expect(canonicalize(stripConfidence(ApplyArbitrationInputV1.parse(payload)))).toBe(
      canonicalize(stripConfidence(r.out)),
    );
  }, 30_000);

  it("applies the schema_version default (1) + empty collections when omitted", async () => {
    const payload = {
      installation_id: INSTALL,
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [],
      tier2_findings: [],
      tier2_review_finding_id_by_arbitration_id: {},
      intents: [],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(payload);
    expect(r.ok, r.err).toBe(true);
    const parsed = ApplyArbitrationInputV1.parse(payload);
    expect(parsed.schema_version).toBe(1);
    expect(canonicalize(parsed)).toBe(canonicalize(r.out));
  }, 30_000);

  it("lowercases UUIDs identically (uppercase input → lowercase dump), incl. the dict VALUES", async () => {
    const payload = {
      installation_id: INSTALL.toUpperCase(),
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [],
      tier2_findings: [[T2.toUpperCase(), reviewFinding()]],
      // The dict KEY is passed through verbatim by both sides (Pydantic does NOT normalize string keys);
      // the VALUE UUID is lowercased on dump. Use a lowercase key so the key form matches byte-for-byte.
      tier2_review_finding_id_by_arbitration_id: { [T2]: RFID.toUpperCase() },
      intents: [],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(payload);
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(stripConfidence(ApplyArbitrationInputV1.parse(payload)))).toBe(
      canonicalize(stripConfidence(r.out)),
    );
  }, 30_000);

  it("both REJECT a malformed UUID (run_id not a UUID)", async () => {
    const bad = {
      installation_id: INSTALL,
      pr_id: PR,
      run_id: "not-a-uuid",
      review_id: REVIEW,
      tier1_findings: [],
      tier2_findings: [],
      tier2_review_finding_id_by_arbitration_id: {},
      intents: [],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(bad);
    expect(r.ok).toBe(false);
    expect(() => ApplyArbitrationInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a tier-1 finding violating its contract (end_line < start_line, nested superRefine)", async () => {
    const bad = {
      installation_id: INSTALL,
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [analysisFinding({ start_line: 5, end_line: 1 })],
      tier2_findings: [],
      tier2_review_finding_id_by_arbitration_id: {},
      intents: [],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(bad);
    expect(r.ok).toBe(false);
    expect(() => ApplyArbitrationInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an arbitration intent with out-of-range confidence (> 1)", async () => {
    const bad = {
      installation_id: INSTALL,
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [],
      tier2_findings: [],
      tier2_review_finding_id_by_arbitration_id: {},
      intents: [intent({ confidence: "1.5" })],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(bad);
    expect(r.ok).toBe(false);
    expect(() => ApplyArbitrationInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: INSTALL,
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [],
      tier2_findings: [],
      tier2_review_finding_id_by_arbitration_id: {},
      intents: [],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
      bogus: 1,
    };
    const r = await pyApplyArbitrationInput(bad);
    expect(r.ok).toBe(false);
    expect(() => ApplyArbitrationInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a tier-2 pair that is not a 2-element [uuid, ReviewFindingV1] tuple", async () => {
    const bad = {
      installation_id: INSTALL,
      pr_id: PR,
      run_id: RUN,
      review_id: REVIEW,
      tier1_findings: [],
      // Three elements instead of two — Python tuple[uuid, RF] / Zod z.tuple([...]) both reject.
      tier2_findings: [[T2, reviewFinding(), "extra"]],
      tier2_review_finding_id_by_arbitration_id: {},
      intents: [],
      model: "m",
      prompt_version: "v1",
      now: "2099-03-04T05:06:07+00:00",
    };
    const r = await pyApplyArbitrationInput(bad);
    expect(r.ok).toBe(false);
    expect(() => ApplyArbitrationInputV1.parse(bad)).toThrow();
  }, 30_000);
});
