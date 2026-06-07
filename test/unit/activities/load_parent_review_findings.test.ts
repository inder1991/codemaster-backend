// Unit tests for the carry-forward rollout flag (CODEMASTER_CARRY_FORWARD_ENABLED) in
// loadParentReviewFindingsActivity. The ENABLED path (real DB load) is covered by the DB-gated
// integration test; here we cover the DISABLED short-circuit with NO DB — it must return the empty parent
// set without ever reading the DSN.

import { afterEach, describe, expect, it } from "vitest";

import { loadParentReviewFindingsActivity } from "#backend/activities/load_parent_review_findings.activity.js";

import { LoadParentReviewFindingsInputV1 } from "#contracts/load_parent_review_findings.v1.js";

const FLAG = "CODEMASTER_CARRY_FORWARD_ENABLED";

const input = LoadParentReviewFindingsInputV1.parse({
  installation_id: "11111111-1111-4111-8111-111111111111",
  pr_id: "22222222-2222-4222-8222-222222222222",
  review_id: "33333333-3333-4333-8333-333333333333",
});

describe("loadParentReviewFindingsActivity — carry-forward rollout flag", () => {
  const savedFlag = process.env[FLAG];
  const savedDsn = process.env.CODEMASTER_PG_CORE_DSN;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    if (savedDsn === undefined) delete process.env.CODEMASTER_PG_CORE_DSN;
    else process.env.CODEMASTER_PG_CORE_DSN = savedDsn;
  });

  it("disabled (flag unset) → empty parent set, WITHOUT reading the DSN (gate short-circuits first)", async () => {
    delete process.env[FLAG];
    delete process.env.CODEMASTER_PG_CORE_DSN; // if the gate didn't short-circuit, the DSN read would throw
    const result = await loadParentReviewFindingsActivity(input);
    expect(result.parent_review_id).toBeNull();
    expect(result.parent_findings).toEqual([]);
  });

  it("disabled explicitly (flag='false') → empty parent set", async () => {
    process.env[FLAG] = "false";
    delete process.env.CODEMASTER_PG_CORE_DSN;
    const result = await loadParentReviewFindingsActivity(input);
    expect(result.parent_review_id).toBeNull();
    expect(result.parent_findings).toEqual([]);
  });
});
