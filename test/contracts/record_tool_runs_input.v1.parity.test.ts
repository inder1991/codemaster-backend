import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { RecordToolRunsInputV1 } from "#contracts/record_tool_runs_input.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// `RecordToolRunsInput` class via the oracle — `RecordToolRunsInput(**payload).model_dump(mode="json")`)
// and through Zod (`RecordToolRunsInputV1.parse(payload)`), then diff canonical JSON. Accept/reject must
// agree on both sides.
//
// The Python class is defined inline in the activity module (not a `contracts/` module); the oracle
// imports it from there. Its installation_id/run_id/review_id are genuine uuid.UUID (lowercased on
// Pydantic dump), so payloads use lowercase UUIDs. tool_statuses carries ToolStatusV1 rows, each with two
// datetime fields — Pydantic emits a "Z"-suffixed ISO string while Zod passes the input verbatim, so we
// re-canonicalize the oracle's raw output (`canonicalize(JSON.parse(r.out))`) to apply the datetime
// normalization to BOTH sides (same pattern as tool_status.v1.parity.test.ts).
const PY = "codemaster.review.arbitration_apply_activity";

const INSTALL = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const REVIEW_ID = "33333333-3333-3333-3333-333333333333";

function toolStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool_name: "ruff",
    status: "completed",
    files_scanned: 3,
    files_total: 5,
    started_at: "2099-03-04T05:06:07+00:00",
    finished_at: "2099-03-04T05:06:08+00:00",
    duration_ms: 1234,
    findings_produced: 2,
    error_class: null,
    error_message: null,
    ...overrides,
  };
}

describe("RecordToolRunsInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically (one tool status)", async () => {
    const payload = {
      schema_version: 1,
      installation_id: INSTALL,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      tool_statuses: [toolStatus()],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RecordToolRunsInputV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("round-trips multiple tool statuses (incl. a null finished_at + error fields) identically", async () => {
    const payload = {
      installation_id: INSTALL,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      tool_statuses: [
        toolStatus({ tool_name: "ruff", status: "completed" }),
        toolStatus({
          tool_name: "mypy",
          status: "timed_out",
          files_scanned: 0,
          files_total: 0,
          finished_at: null,
          findings_produced: 0,
          error_class: "TimeoutError",
          error_message: "exceeded wall clock",
        }),
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RecordToolRunsInputV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("applies the same schema_version default (1) and an empty tool_statuses tuple when omitted", async () => {
    const payload = {
      installation_id: INSTALL,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      tool_statuses: [],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RecordToolRunsInputV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("lowercases UUIDs identically (uppercase input → lowercase dump)", async () => {
    const payload = {
      installation_id: INSTALL.toUpperCase(),
      run_id: RUN_ID.toUpperCase(),
      review_id: REVIEW_ID,
      tool_statuses: [toolStatus()],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RecordToolRunsInputV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("both REJECT a malformed UUID (run_id not a UUID)", async () => {
    const bad = {
      installation_id: INSTALL,
      run_id: "not-a-uuid",
      review_id: REVIEW_ID,
      tool_statuses: [toolStatus()],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RecordToolRunsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a tool status whose files_scanned exceeds files_total (nested superRefine)", async () => {
    const bad = {
      installation_id: INSTALL,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      tool_statuses: [toolStatus({ files_scanned: 9, files_total: 5 })],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError on the nested _check_coverage validator
    expect(() => RecordToolRunsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a tool status with an out-of-vocabulary status (nested enum)", async () => {
    const bad = {
      installation_id: INSTALL,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      tool_statuses: [toolStatus({ status: "exploded" })],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RecordToolRunsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: INSTALL,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      tool_statuses: [],
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RecordToolRunsInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RecordToolRunsInputV1.parse(bad)).toThrow();
  }, 30_000);
});
