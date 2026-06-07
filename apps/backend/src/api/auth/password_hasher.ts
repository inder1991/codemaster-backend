// Argon2id password hashing (1:1 with codemaster/api/auth/password_hasher.py's PRODUCTION path, ADR-0072).
// @node-rs/argon2 reads the cost params from the encoded PHC string on verify, so it cross-verifies hashes
// the frozen Python wrote with argon2-cffi — proven by the parity fixture in password_hasher.test.ts.
//
// The Python `fallback$<salt>$<hmac>` path (only when argon2-cffi is absent in dev) is NOT ported —
// production always has real Argon2id.

import { hash, verify, type Algorithm } from "@node-rs/argon2";

// `Algorithm` is an ambient const enum in @node-rs/argon2, so its members can't be referenced as VALUES
// under verbatimModuleSyntax. Argon2id === 2 (stable in the argon2 reference + this lib; matches the Python
// `type=Type.ID`). Cast the literal to the enum type for the options shape.
const ARGON2ID = 2 as Algorithm;

// OWASP-2023 params, matching the Python (time_cost=3, memory_cost=65536 KiB, parallelism=4).
const HASH_OPTS = {
  algorithm: ARGON2ID,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
} as const;

/** Hash a password to a standard `$argon2id$…` PHC string. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTS);
}

/** Constant-time verify a password against a stored PHC hash. Returns false (never throws) on a malformed
 *  hash or mismatch — the params are read from the encoded hash, so Python-written hashes verify. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
