// Argon2id hasher tests. The PARITY FIXTURE is the load-bearing one: a real hash minted by the frozen
// Python (argon2-cffi, production params time_cost=3/memory_cost=65536/parallelism=4/type=ID) MUST verify
// under @node-rs/argon2 — else super_admin can't log in. (Recorded 2026-06-07; see ADR-0072.)

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "#backend/api/auth/password_hasher.js";

// Minted by: argon2.PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, type=ID).hash("test-password-123")
const PYTHON_ARGON2ID_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$B5QfWyYH3WdHYy1TH9rkoA$SomedFZGU2en2csfxEl+WOEJNowVbJjN0AIxtQoavN4";

describe("password_hasher (Argon2id, cross-impl parity with Python argon2-cffi)", () => {
  it("verifies a Python-argon2-cffi-written PHC hash (the super_admin-login parity anchor)", async () => {
    expect(await verifyPassword(PYTHON_ARGON2ID_HASH, "test-password-123")).toBe(true);
    expect(await verifyPassword(PYTHON_ARGON2ID_HASH, "wrong-password")).toBe(false);
  });

  it("returns false (never throws) on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(await verifyPassword("fallback$abc$def", "x")).toBe(false); // the un-ported Python fallback path
  });

  it("round-trips its own hashes (a $argon2id$ PHC string)", async () => {
    const h = await hashPassword("hunter2");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "hunter2")).toBe(true);
    expect(await verifyPassword(h, "hunter3")).toBe(false);
  });
});
