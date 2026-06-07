import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ClaimPendingRowsInputV1,
  DispatchRowInputV1,
  MarkAttemptFailedInputV1,
  MarkDispatchedInputV1,
} from "#contracts/outbox_dispatch.v1.js";

afterAll(() => shutdownRef());

// Contract parity for the 4 OutboxDispatcherWorkflow activity-input contracts, WITHOUT fixtures:
// round-trip the SAME payload through Pydantic (via the oracle — `<Model>(**payload).model_dump(mode="json")`)
// and through Zod (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
//
// The frozen Python lives in `codemaster.activities.outbox` (NOT contracts/) — heavier imports (temporalio,
// sqlalchemy), but the oracle imports it cleanly. All 4 models use ConfigDict(extra="ignore") → the "extra
// field" case asserts AGREEMENT-ON-STRIP (both drop the unknown key → equal canonical), not mutual rejection.
const PY = "codemaster.activities.outbox";

// Lowercase UUIDs only — Pydantic lowercases UUIDs on model_dump(mode="json"); Zod's z.string().uuid() does
// not lowercase, so we feed lowercase inputs to keep the two canonical outputs equal.
const UUID_A = "12345678-1234-1234-1234-1234567890ab";
const UUID_B = "abcdef01-2345-6789-abcd-ef0123456789";

describe("ClaimPendingRowsInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { batch_size: 50, lease_seconds: 30 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ClaimPendingRowsInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ClaimPendingRowsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (batch_size=100, lease_seconds=60) when omitted", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: "ClaimPendingRowsInput", kwargs: {} });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(ClaimPendingRowsInputV1.parse({}));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.batch_size).toBe(100);
    expect(z.lease_seconds).toBe(60);
  }, 30_000);

  it("both REJECT batch_size out of range (0 and 1001)", async () => {
    for (const bad of [{ batch_size: 0 }, { batch_size: 1001 }]) {
      const r = await pyRef({ pyModule: PY, pyCallable: "ClaimPendingRowsInput", kwargs: bad });
      expect(r.ok).toBe(false);
      expect(() => ClaimPendingRowsInputV1.parse(bad)).toThrow();
    }
  }, 30_000);

  it("both REJECT lease_seconds out of range (9 and 301)", async () => {
    for (const bad of [{ lease_seconds: 9 }, { lease_seconds: 301 }]) {
      const r = await pyRef({ pyModule: PY, pyCallable: "ClaimPendingRowsInput", kwargs: bad });
      expect(r.ok).toBe(false);
      expect(() => ClaimPendingRowsInputV1.parse(bad)).toThrow();
    }
  }, 30_000);
});

describe("DispatchRowInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full normal (installation-scoped) row identically", async () => {
    const payload = {
      schema_version: 2,
      row_id: UUID_A,
      sink: "temporal_workflow_start",
      payload: { workflow_type: "reviewPullRequest", args: [{ pr: 1 }] },
      trace_context: { traceparent: "00-abc-def-01" },
      run_id: UUID_B,
      review_id: UUID_A,
      provider: "github",
      installation_id: UUID_B,
      orphan_reason: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DispatchRowInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults for a legitimate-orphan (bootstrap_sink) row", async () => {
    const payload = { row_id: UUID_A, sink: "installation_reconcile", payload: {}, orphan_reason: "bootstrap_sink" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(DispatchRowInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(2);
    expect(z.trace_context).toEqual({});
    expect(z.run_id).toBeNull();
    expect(z.review_id).toBeNull();
    expect(z.provider).toBeNull();
    expect(z.installation_id).toBeNull();
  }, 30_000);

  it("both STRIP an unknown extra field identically (extra=ignore ↔ default strip)", async () => {
    const payload = { row_id: UUID_A, sink: "s", payload: {}, installation_id: UUID_B, bogus: "dropped" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(DispatchRowInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).bogus).toBeUndefined();
  }, 30_000);

  it("tagged-union validator: both REJECT installation_id=null with no orphan_reason (propagation bug)", async () => {
    const bad = { row_id: UUID_A, sink: "s", payload: {} }; // both null
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DispatchRowInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("tagged-union validator: both REJECT setting BOTH installation_id and orphan_reason", async () => {
    const bad = { row_id: UUID_A, sink: "s", payload: {}, installation_id: UUID_B, orphan_reason: "bootstrap_sink" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DispatchRowInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT schema_version=1 (Literal[2] only)", async () => {
    const bad = { schema_version: 1, row_id: UUID_A, sink: "s", payload: {}, installation_id: UUID_B };
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DispatchRowInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-vocabulary orphan_reason", async () => {
    const bad = { row_id: UUID_A, sink: "s", payload: {}, orphan_reason: "made_up" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DispatchRowInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DispatchRowInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("MarkDispatchedInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps identically", async () => {
    const payload = { row_id: UUID_A };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkDispatchedInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MarkDispatchedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed row_id", async () => {
    const bad = { row_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkDispatchedInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkDispatchedInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("MarkAttemptFailedInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = { row_id: UUID_A, error: "boom", expected_attempts: 3 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkAttemptFailedInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MarkAttemptFailedInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same default (expected_attempts=0) when omitted", async () => {
    const payload = { row_id: UUID_A, error: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkAttemptFailedInput", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(MarkAttemptFailedInputV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as Record<string, unknown>).expected_attempts).toBe(0);
  }, 30_000);

  it("both REJECT an error longer than 1024 chars (max_length=1024)", async () => {
    const bad = { row_id: UUID_A, error: "x".repeat(1025) };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkAttemptFailedInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkAttemptFailedInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative expected_attempts", async () => {
    const bad = { row_id: UUID_A, error: "x", expected_attempts: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkAttemptFailedInput", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkAttemptFailedInputV1.parse(bad)).toThrow();
  }, 30_000);
});
