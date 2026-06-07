// Email field codec — 1:1 port of the email-column handling in the frozen Python
// (security/field_encryption.py::EncryptedStringWithAAD + postgres_local_user_repo._email_fingerprint).
//
// Two halves:
//   1. AAD-bound AES-256-GCM string encryption (reuses the ported encryptField/decryptField crypto layer).
//      The per-column AAD constant is bound into the GCM tag so a ciphertext written for one column can't
//      be moved to another and decrypt cleanly. AAD bytes are byte-identical to the Python column AADs, so
//      rows are cross-readable between the implementations.
//   2. A deterministic SHA-256 fingerprint of the lowercased email for UNIQUE-by-email lookup without
//      exposing plaintext at the index (the email_fingerprint column).
//
// The key registry is injected (mirroring aes_gcm_aad.encryptField's parameterized design) — the repo
// passes the shared field-encryption registry, tests pass a registry with a known key.

import { createHash } from "node:crypto";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";
import type { KeyRegistry } from "#platform/crypto/key_registry.js";

/** AAD for `core.local_users.email_ciphertext` — byte-identical to the Python column constant. */
export const LOCAL_USER_EMAIL_AAD: Uint8Array = new TextEncoder().encode(
  "core.local_users.email_ciphertext",
);
/** AAD for `core.users.email` — byte-identical to the Python column constant. */
export const CORE_USER_EMAIL_AAD: Uint8Array = new TextEncoder().encode("core.users.email");

/** Encrypt a plaintext email string under the given per-column AAD → `kms2:vN:<base64>` envelope. */
export function encryptEmail(plaintext: string, registry: KeyRegistry, aad: Uint8Array): string {
  return encryptField({ plaintext: new TextEncoder().encode(plaintext), registry, aad });
}

/** Decrypt an email envelope under the same per-column AAD. Throws on AAD mismatch / tamper / wrong key. */
export function decryptEmail(ciphertext: string, registry: KeyRegistry, aad: Uint8Array): string {
  return new TextDecoder().decode(decryptField({ ciphertext, registry, aad }));
}

/** SHA-256 hex of the lowercased email — deterministic, never reversible; backs the UNIQUE index. */
export function emailFingerprint(email: string): string {
  return createHash("sha256").update(email.toLowerCase(), "utf-8").digest("hex");
}
