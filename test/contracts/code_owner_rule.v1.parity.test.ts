import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { CodeOwnerRuleV1 } from "../../libs/contracts/src/code_owner_rule.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `CodeOwnerRuleV1(**payload).model_dump(mode="json")`) and through
// Zod (`CodeOwnerRuleV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.code_owner_rule.v1";

describe("CodeOwnerRuleV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "src/server/*.py",
      owner_logins: ["@indersingh", "@org/platform-team"],
      source_file_sha: "0123456789abcdef0123456789abcdef01234567",
      // synced_at left null: a non-null datetime can't be asserted for canonical-string equality
      // because the Python ref's _canonical emits Pydantic's raw "…Z" while the TS-side canonicalize()
      // normalizes "…Z" → "…000000+00:00". Both PARSE it fine (the dedicated accept test below covers
      // it); only the equality diff is harness-asymmetric — same handling as pr_file.v1's created_at.
      synced_at: null,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CodeOwnerRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/synced_at) when omitted", async () => {
    const payload = {
      code_owner_id: "44444444-4444-4444-4444-444444444444",
      installation_id: "55555555-5555-5555-5555-555555555555",
      repository_id: "66666666-6666-6666-6666-666666666666",
      path_pattern: "*",
      owner_logins: ["@org/everyone"],
      source_file_sha: "abcdef0123456789abcdef0123456789abcdef01",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CodeOwnerRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates + dumps a single-owner individual-user payload identically", async () => {
    const payload = {
      code_owner_id: "77777777-7777-7777-7777-777777777777",
      installation_id: "88888888-8888-8888-8888-888888888888",
      repository_id: "99999999-9999-9999-9999-999999999999",
      path_pattern: "docs/**/*.md",
      owner_logins: ["@solo-maintainer"],
      source_file_sha: "ffffffffffffffffffffffffffffffffffffffff",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CodeOwnerRuleV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both ACCEPT a non-null synced_at (datetime field; equality-diff is harness-asymmetric)", async () => {
    const payload = {
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "src/a.py",
      owner_logins: ["@indersingh"],
      source_file_sha: "0123456789abcdef0123456789abcdef01234567",
      synced_at: "2026-06-03T10:00:00Z",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true); // Pydantic accepts the ISO datetime
    expect(() => CodeOwnerRuleV1.parse(payload)).not.toThrow(); // Zod accepts it too
  }, 30_000);

  it("both REJECT an empty owner_logins (min_length=1 ↔ z.array(...).min(1))", async () => {
    const bad = {
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "src/a.py",
      owner_logins: [],
      source_file_sha: "0123456789abcdef0123456789abcdef01234567",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => CodeOwnerRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed source_file_sha (pattern ↔ z.string().regex)", async () => {
    const bad = {
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "src/a.py",
      owner_logins: ["@indersingh"],
      source_file_sha: "not-a-sha",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodeOwnerRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an uppercase-hex source_file_sha (pattern is lowercase-only)", async () => {
    const bad = {
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "src/a.py",
      owner_logins: ["@indersingh"],
      source_file_sha: "0123456789ABCDEF0123456789ABCDEF01234567",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodeOwnerRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-range path_pattern (max_length=1024)", async () => {
    const bad = {
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "a".repeat(1025),
      owner_logins: ["@indersingh"],
      source_file_sha: "0123456789abcdef0123456789abcdef01234567",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodeOwnerRuleV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      code_owner_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      path_pattern: "src/a.py",
      owner_logins: ["@indersingh"],
      source_file_sha: "0123456789abcdef0123456789abcdef01234567",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CodeOwnerRuleV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CodeOwnerRuleV1.parse(bad)).toThrow();
  }, 30_000);
});
