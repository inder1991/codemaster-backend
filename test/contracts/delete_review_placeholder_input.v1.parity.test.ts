import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (the frozen
// DeleteReviewPlaceholderInput via the oracle) and through Zod, then diff canonical JSON. Accept/reject
// must also agree. Same shape as PostReviewPlaceholderInput, but a DISTINCT model on both sides.
const PY = "codemaster.activities.delete_review_placeholder";
const CALLABLE = "DeleteReviewPlaceholderInput";

const VALID = {
  schema_version: 1,
  pr_id: "11111111-1111-1111-1111-111111111111",
  run_id: "22222222-2222-2222-2222-222222222222",
  review_id: "33333333-3333-3333-3333-333333333333",
  installation_id: "44444444-4444-4444-4444-444444444444",
  owner: "test-org",
  repo_name: "test-repo",
  pr_number: 42,
};

describe("DeleteReviewPlaceholderInput parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: VALID });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DeleteReviewPlaceholderInput.parse(VALID))).toBe(r.out);
  }, 30_000);

  it("applies the same default (schema_version=1) when omitted", async () => {
    const payload = {
      pr_id: VALID.pr_id,
      run_id: VALID.run_id,
      review_id: VALID.review_id,
      installation_id: VALID.installation_id,
      owner: VALID.owner,
      repo_name: VALID.repo_name,
      pr_number: VALID.pr_number,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DeleteReviewPlaceholderInput.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both ACCEPT a non-positive pr_number (bare int, NO ge=1)", async () => {
    const payload = { ...VALID, pr_number: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DeleteReviewPlaceholderInput.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT schema_version != 1 (Literal[1])", async () => {
    const bad = { ...VALID, schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DeleteReviewPlaceholderInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID installation_id", async () => {
    const bad = { ...VALID, installation_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DeleteReviewPlaceholderInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (run_id)", async () => {
    const bad = {
      schema_version: VALID.schema_version,
      pr_id: VALID.pr_id,
      review_id: VALID.review_id,
      installation_id: VALID.installation_id,
      owner: VALID.owner,
      repo_name: VALID.repo_name,
      pr_number: VALID.pr_number,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DeleteReviewPlaceholderInput.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { ...VALID, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DeleteReviewPlaceholderInput.parse(bad)).toThrow();
  }, 30_000);
});
