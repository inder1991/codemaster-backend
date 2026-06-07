import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyArbitrate,
  shutdownArbitrateRef,
  type WireDict,
} from "./arbitrate_oracle.js";

import { arbitrate } from "#backend/review/arbitration/arbitrate.js";
import { loadBundledPolicy } from "#backend/review/arbitration/suppression_policy.js";

import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";
import { Tier2Pair } from "#contracts/apply_arbitration_input.v1.js";

afterAll(() => {
  shutdownArbitrateRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS pure `arbitrate` core is byte-equal to the frozen Python
// `arbitrate` (vendor/codemaster-py/codemaster/review/arbitration_layer.py), driven over the dedicated
// ref (tools/parity/run_arbitrate_ref.py) with the BUNDLED suppression policy on both sides.
//
// The result has NO bare floats (suppression_confidence + intent_confidence are canonical-decimal STRINGS;
// the tier-2 ReviewFindingV1's confidence float never appears — tier-2 decisions output only finding_id),
// so canonicalize() compares cleanly. ApplyArbitrationInput envelope parity lives in the contract test.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const NOW = "2099-03-04T05:06:07+00:00";
const T1A = "aaaaaaaa-0000-4000-8000-000000000001";
const T1B = "bbbbbbbb-0000-4000-8000-000000000002";
const T2A = "cccccccc-0000-4000-8000-000000000003";
const GHOST = "dddddddd-0000-4000-8000-000000000004";

/** One AnalysisFindingV1 wire dict (the shape `AnalysisFindingV1(**dict)` / `.parse` accept). */
function t1(overrides: Partial<WireDict> = {}): WireDict {
  return {
    finding_id: T1A,
    tool: "ruff",
    rule_id: "F401",
    file: "x.py",
    start_line: 1,
    end_line: 1,
    severity_raw: "warning",
    message: "m",
    ...overrides,
  };
}

/** One ArbitrationIntentV1 wire dict. confidence is the canonical-decimal STRING form. */
function intent(overrides: Partial<WireDict> = {}): WireDict {
  return {
    target_finding_id: T1A,
    confidence: "0.95",
    reason: "false positive in context",
    ...overrides,
  };
}

/** One ReviewFindingV1 wire dict (only used as the Tier-2 pair payload). */
function rf(overrides: Partial<WireDict> = {}): WireDict {
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

/**
 * Parse each wire dict through the ported contract (applying defaults), run the TS `arbitrate`, and diff
 * the canonical result against the frozen Python `arbitrate`. Returns the parsed TS result for extra
 * structural assertions.
 */
async function assertParity(args: {
  tier1Findings: ReadonlyArray<WireDict>;
  tier2Findings: ReadonlyArray<readonly [string, WireDict]>;
  intents: ReadonlyArray<WireDict>;
  model?: string;
  promptVersion?: string;
}): Promise<ArbitrationResultV1> {
  const model = args.model ?? "claude-test";
  const promptVersion = args.promptVersion ?? "v1";

  const tsTier1 = args.tier1Findings.map((d) => AnalysisFindingV1.parse(d));
  const tsTier2 = args.tier2Findings.map(([id, d]) => Tier2Pair.parse([id, d]));
  const tsIntents = args.intents.map((d) => ArbitrationIntentV1.parse(d));

  const tsResult = arbitrate({
    tier1Findings: tsTier1,
    tier2Findings: tsTier2,
    intents: tsIntents,
    policy: loadBundledPolicy(),
    model,
    promptVersion,
    now: NOW,
  });

  const py = await pyArbitrate({
    tier1Findings: args.tier1Findings,
    tier2Findings: args.tier2Findings,
    intents: args.intents,
    model,
    promptVersion,
    now: NOW,
  });

  expect(canonicalize(tsResult)).toBe(canonicalize(py));
  // The result also round-trips through the ported ArbitrationResultV1 contract.
  expect(ArbitrationResultV1.parse(tsResult)).toBeTruthy();
  return tsResult;
}

describe("arbitrate parity (Pydantic ↔ TS)", () => {
  it("empty inputs → empty decisions + empty rejected_intents", async () => {
    const r = await assertParity({ tier1Findings: [], tier2Findings: [], intents: [] });
    expect(r.decisions).toHaveLength(0);
    expect(r.rejected_intents).toHaveLength(0);
  }, 30_000);

  it("tier-1 finding with NO intent → single NONE decision, no rejection", async () => {
    const r = await assertParity({ tier1Findings: [t1()], tier2Findings: [], intents: [] });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]!.suppression_state).toBe("NONE");
    expect(r.rejected_intents).toHaveLength(0);
  }, 30_000);

  it("SUPPRESS honored — ruff F401 at conf 0.95 ≥ min 0.90 → SUPPRESSED_BY_LLM with provenance", async () => {
    const r = await assertParity({
      tier1Findings: [t1({ tool: "ruff", rule_id: "F401" })],
      tier2Findings: [],
      intents: [intent({ confidence: "0.95" })],
    });
    expect(r.decisions[0]!.suppression_state).toBe("SUPPRESSED_BY_LLM");
    expect(r.decisions[0]!.suppression_confidence).toBe("0.95");
    expect(r.decisions[0]!.suppression_model).toBe("claude-test");
    expect(r.decisions[0]!.suppression_prompt_version).toBe("v1");
    expect(r.decisions[0]!.suppressed_at).not.toBeNull();
    expect(r.rejected_intents).toHaveLength(0);
  }, 30_000);

  it("below_min_confidence — ruff F401 at conf 0.80 < min 0.90 → NONE + rejected(below_min_confidence)", async () => {
    const r = await assertParity({
      tier1Findings: [t1({ tool: "ruff", rule_id: "F401" })],
      tier2Findings: [],
      intents: [intent({ confidence: "0.80" })],
    });
    expect(r.decisions[0]!.suppression_state).toBe("NONE");
    expect(r.rejected_intents).toHaveLength(1);
    expect(r.rejected_intents[0]!.reason_rejected).toBe("below_min_confidence");
    expect(r.rejected_intents[0]!.intent_confidence).toBe("0.80");
    expect(r.rejected_intents[0]!.intent_reason).toBe("false positive in context");
  }, 30_000);

  it("policy_forbids — gitleaks is non-suppressible at ANY confidence → NONE + rejected(policy_forbids)", async () => {
    const r = await assertParity({
      tier1Findings: [t1({ tool: "gitleaks", rule_id: "aws-access-token", severity_raw: "error" })],
      tier2Findings: [],
      intents: [intent({ confidence: "1.0", reason: "swears it is a test fixture" })],
    });
    expect(r.decisions[0]!.suppression_state).toBe("NONE");
    expect(r.rejected_intents[0]!.reason_rejected).toBe("policy_forbids");
  }, 30_000);

  it("policy_forbids — trivy CVE is non-suppressible → NONE + rejected(policy_forbids)", async () => {
    const r = await assertParity({
      tier1Findings: [t1({ tool: "trivy", rule_id: "CVE-2024-0001", severity_raw: "critical" })],
      tier2Findings: [],
      intents: [intent({ confidence: "1.0" })],
    });
    expect(r.decisions[0]!.suppression_state).toBe("NONE");
    expect(r.rejected_intents[0]!.reason_rejected).toBe("policy_forbids");
  }, 30_000);

  it("target_not_found — intent targets a UUID matching no Tier-1 finding (LLM hallucination)", async () => {
    const r = await assertParity({
      tier1Findings: [t1()],
      tier2Findings: [],
      intents: [intent({ target_finding_id: GHOST, confidence: "0.99" })],
    });
    // The real T1A finding stands as NONE; the ghost intent is rejected target_not_found.
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]!.suppression_state).toBe("NONE");
    expect(r.rejected_intents).toHaveLength(1);
    expect(r.rejected_intents[0]!.reason_rejected).toBe("target_not_found");
    expect(r.rejected_intents[0]!.target_finding_id).toBe(GHOST);
  }, 30_000);

  it("duplicate_intent_loser — two intents on the same target; highest-confidence wins, loser rejected", async () => {
    const r = await assertParity({
      tier1Findings: [t1({ tool: "ruff", rule_id: "F401" })],
      tier2Findings: [],
      intents: [
        intent({ confidence: "0.91", reason: "winner — higher confidence" }),
        intent({ confidence: "0.95", reason: "real winner" }),
        intent({ confidence: "0.90", reason: "loser" }),
      ],
    });
    // The 0.95 intent wins (≥ min 0.90) → SUPPRESSED_BY_LLM with reason "real winner".
    expect(r.decisions[0]!.suppression_state).toBe("SUPPRESSED_BY_LLM");
    expect(r.decisions[0]!.suppression_reason).toBe("real winner");
    // Two losers surfaced as duplicate_intent_loser.
    const dupLosers = r.rejected_intents.filter((x) => x.reason_rejected === "duplicate_intent_loser");
    expect(dupLosers).toHaveLength(2);
  }, 30_000);

  it("Tier-1 ↔ Tier-2 overlap — tier-2 pass-through as NONE; tier-1 still arbitrated independently", async () => {
    const r = await assertParity({
      tier1Findings: [t1({ finding_id: T1A, tool: "ruff", rule_id: "E501" })],
      tier2Findings: [[T2A, rf()]],
      intents: [intent({ target_finding_id: T1A, confidence: "0.85" })], // E501 min is 0.80 → suppress
    });
    // 2 decisions: T1A suppressed, T2A passthrough NONE. Sorted by (state, finding_id).
    expect(r.decisions).toHaveLength(2);
    const byId = new Map(r.decisions.map((d) => [d.finding_id, d]));
    expect(byId.get(T1A)!.suppression_state).toBe("SUPPRESSED_BY_LLM");
    expect(byId.get(T2A)!.suppression_state).toBe("NONE");
  }, 30_000);

  it("deterministic ordering — many tier-1 findings + mixed intents sort identically on both sides", async () => {
    // Distinct finding ids out of sort order; the byte-equal canonical compare proves the sort matches.
    const r = await assertParity({
      tier1Findings: [
        t1({ finding_id: T1B, tool: "eslint", rule_id: "no-unused-vars" }),
        t1({ finding_id: T1A, tool: "ruff", rule_id: "F401" }),
      ],
      tier2Findings: [[T2A, rf()]],
      intents: [
        intent({ target_finding_id: T1A, confidence: "0.95" }), // suppress (ruff F401)
        intent({ target_finding_id: T1B, confidence: "0.92" }), // suppress (eslint no-unused-vars min 0.90)
        intent({ target_finding_id: GHOST, confidence: "0.50" }), // target_not_found
      ],
    });
    expect(r.decisions).toHaveLength(3);
    expect(r.rejected_intents.some((x) => x.reason_rejected === "target_not_found")).toBe(true);
  }, 30_000);
});
