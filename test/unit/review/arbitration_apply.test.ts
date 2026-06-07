import { describe, expect, it } from "vitest";

import {
  applyArbitration,
  type ApplyLogger,
  type ReviewFindingsArbitrationPort,
} from "#backend/review/arbitration/arbitration_apply.js";
import type { InsertRejectionInput, ArbitrationRejectionsRepoPort } from "#backend/domain/repos/arbitration_rejections_repo.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Unit coverage for the persistence glue applyArbitration (1:1 port of arbitration_apply.py). Fake repos
// capture the per-decision routing (tier1 INSERT / tier2 UPDATE / unmapped skip) + the rejection writes,
// so the routing logic is asserted WITHOUT a DB. The DB-backed round-trip lives in the integration test.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Tier1Call = Parameters<ReviewFindingsArbitrationPort["insertTier1Finding"]>[0];
type Tier2Call = Parameters<ReviewFindingsArbitrationPort["updateTier2Arbitration"]>[0];

class FakeFindingsRepo implements ReviewFindingsArbitrationPort {
  public readonly tier1: Array<Tier1Call> = [];
  public readonly tier2: Array<Tier2Call> = [];
  async insertTier1Finding(args: Tier1Call): Promise<void> {
    this.tier1.push(args);
  }
  async updateTier2Arbitration(args: Tier2Call): Promise<void> {
    this.tier2.push(args);
  }
}

class FakeRejectionsRepo implements ArbitrationRejectionsRepoPort {
  public readonly rows: Array<InsertRejectionInput> = [];
  async insertRejection(input: InsertRejectionInput): Promise<void> {
    this.rows.push(input);
  }
}

const INSTALL = "11111111-1111-1111-1111-111111111111";
const PR = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";
const REVIEW = "44444444-4444-4444-4444-444444444444";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "bbbbbbbb-0000-4000-8000-000000000002";
const RFID = "cccccccc-0000-4000-8000-000000000003";
const GHOST = "dddddddd-0000-4000-8000-000000000004";
const NOW_ISO = "2099-03-04T05:06:07.000Z";

function tier1Finding(): AnalysisFindingV1 {
  return {
    schema_version: 1,
    finding_id: T1,
    tool: "ruff",
    rule_id: "F401",
    file: "x.py",
    start_line: 4,
    end_line: 6,
    severity_raw: "warning",
    message: "unused import",
    fix_suggestion: null,
  };
}

describe("applyArbitration glue (fake repos)", () => {
  it("Tier-1 SUPPRESSED_BY_LLM decision → insertTier1Finding with the suppression metadata", async () => {
    const findingsRepo = new FakeFindingsRepo();
    const rejectionsRepo = new FakeRejectionsRepo();
    const result: ArbitrationResultV1 = {
      decisions: [
        {
          schema_version: 1,
          finding_id: T1,
          suppression_state: "SUPPRESSED_BY_LLM",
          suppression_reason: "false positive",
          suppression_confidence: "0.95",
          suppression_model: "claude-test",
          suppression_prompt_version: "v1",
          suppressed_at: NOW_ISO,
          suppressed_by_finding_id: null,
        },
      ],
      rejected_intents: [],
    };
    await applyArbitration({
      findingsRepo,
      rejectionsRepo,
      installationId: INSTALL,
      prId: PR,
      runId: RUN,
      reviewId: REVIEW,
      result,
      tier1Findings: [tier1Finding()],
      tier2ReviewFindingIdByArbitrationId: {},
      suppressionModel: "claude-test",
      suppressionPromptVersion: "v1",
    });

    expect(findingsRepo.tier1).toHaveLength(1);
    const call = findingsRepo.tier1[0]!;
    expect(call.reviewFindingId).toBe(T1);
    expect(call.tool).toBe("ruff");
    expect(call.ruleId).toBe("F401");
    expect(call.file).toBe("x.py");
    expect(call.startLine).toBe(4);
    expect(call.endLine).toBe(6);
    expect(call.suppressionState).toBe("SUPPRESSED_BY_LLM");
    // confidence string → number for the numeric column; suppressed_at string → Date.
    expect(call.suppressionConfidence).toBe(0.95);
    expect(call.suppressedAt).toEqual(new Date(NOW_ISO));
    expect(call.installationId).toBe(INSTALL);
    expect(findingsRepo.tier2).toHaveLength(0);
  });

  it("Tier-1 NONE decision → insertTier1Finding with null suppression metadata (suppressedAt null)", async () => {
    const findingsRepo = new FakeFindingsRepo();
    const rejectionsRepo = new FakeRejectionsRepo();
    const result: ArbitrationResultV1 = {
      decisions: [
        {
          schema_version: 1,
          finding_id: T1,
          suppression_state: "NONE",
          suppression_reason: null,
          suppression_confidence: null,
          suppression_model: null,
          suppression_prompt_version: null,
          suppressed_at: null,
          suppressed_by_finding_id: null,
        },
      ],
      rejected_intents: [],
    };
    await applyArbitration({
      findingsRepo,
      rejectionsRepo,
      installationId: INSTALL,
      prId: PR,
      runId: RUN,
      reviewId: REVIEW,
      result,
      tier1Findings: [tier1Finding()],
      tier2ReviewFindingIdByArbitrationId: {},
      suppressionModel: null,
      suppressionPromptVersion: null,
    });
    const call = findingsRepo.tier1[0]!;
    expect(call.suppressionState).toBe("NONE");
    expect(call.suppressionConfidence).toBeNull();
    expect(call.suppressedAt).toBeNull();
  });

  it("Tier-2 decision (finding_id is an arbitration_id KEY) → updateTier2Arbitration on the mapped rfid", async () => {
    const findingsRepo = new FakeFindingsRepo();
    const rejectionsRepo = new FakeRejectionsRepo();
    const result: ArbitrationResultV1 = {
      decisions: [
        {
          schema_version: 1,
          finding_id: T2, // an arbitration id, NOT a tier-1 finding id
          suppression_state: "NONE",
          suppression_reason: null,
          suppression_confidence: null,
          suppression_model: null,
          suppression_prompt_version: null,
          suppressed_at: null,
          suppressed_by_finding_id: null,
        },
      ],
      rejected_intents: [],
    };
    await applyArbitration({
      findingsRepo,
      rejectionsRepo,
      installationId: INSTALL,
      prId: PR,
      runId: RUN,
      reviewId: REVIEW,
      result,
      tier1Findings: [], // T2 is NOT a tier-1 id → routes to tier-2
      tier2ReviewFindingIdByArbitrationId: { [T2]: RFID },
      suppressionModel: null,
      suppressionPromptVersion: null,
    });
    expect(findingsRepo.tier1).toHaveLength(0);
    expect(findingsRepo.tier2).toHaveLength(1);
    expect(findingsRepo.tier2[0]!.reviewFindingId).toBe(RFID);
    expect(findingsRepo.tier2[0]!.installationId).toBe(INSTALL);
  });

  it("unmapped finding_id → DEFENSIVE skip with a WARN; no repo write", async () => {
    const findingsRepo = new FakeFindingsRepo();
    const rejectionsRepo = new FakeRejectionsRepo();
    const warns: Array<string> = [];
    const logger: ApplyLogger = { warning: (m) => warns.push(m) };
    const result: ArbitrationResultV1 = {
      decisions: [
        {
          schema_version: 1,
          finding_id: GHOST, // neither tier-1 nor a tier-2 arbitration id
          suppression_state: "NONE",
          suppression_reason: null,
          suppression_confidence: null,
          suppression_model: null,
          suppression_prompt_version: null,
          suppressed_at: null,
          suppressed_by_finding_id: null,
        },
      ],
      rejected_intents: [],
    };
    await applyArbitration({
      findingsRepo,
      rejectionsRepo,
      installationId: INSTALL,
      prId: PR,
      runId: RUN,
      reviewId: REVIEW,
      result,
      tier1Findings: [],
      tier2ReviewFindingIdByArbitrationId: {},
      suppressionModel: null,
      suppressionPromptVersion: null,
      logger,
    });
    expect(findingsRepo.tier1).toHaveLength(0);
    expect(findingsRepo.tier2).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(GHOST);
  });

  it("rejected_intents → one rejection row per intent, with provenance threaded from the caller", async () => {
    const findingsRepo = new FakeFindingsRepo();
    const rejectionsRepo = new FakeRejectionsRepo();
    const result: ArbitrationResultV1 = {
      decisions: [],
      rejected_intents: [
        {
          target_finding_id: T1,
          reason_rejected: "policy_forbids",
          intent_confidence: "0.99",
          intent_reason: "swears it is a test fixture",
        },
        {
          target_finding_id: GHOST,
          reason_rejected: "target_not_found",
          intent_confidence: null,
          intent_reason: null,
        },
      ],
    };
    await applyArbitration({
      findingsRepo,
      rejectionsRepo,
      installationId: INSTALL,
      prId: PR,
      runId: RUN,
      reviewId: REVIEW,
      result,
      tier1Findings: [],
      tier2ReviewFindingIdByArbitrationId: {},
      suppressionModel: "claude-test",
      suppressionPromptVersion: "v1",
    });
    expect(rejectionsRepo.rows).toHaveLength(2);
    const first = rejectionsRepo.rows[0]!;
    expect(first.targetFindingId).toBe(T1);
    expect(first.reasonRejected).toBe("policy_forbids");
    // The confidence is bound as the canonical-decimal STRING (lossless into the numeric column).
    expect(first.intentConfidence).toBe("0.99");
    expect(first.intentReason).toBe("swears it is a test fixture");
    expect(first.suppressionModel).toBe("claude-test");
    expect(first.suppressionPromptVersion).toBe("v1");
    expect(first.runId).toBe(RUN);
    expect(first.reviewId).toBe(REVIEW);
    // Null-confidence rejection threads null through.
    expect(rejectionsRepo.rows[1]!.intentConfidence).toBeNull();
    expect(rejectionsRepo.rows[1]!.intentReason).toBeNull();
  });
});
