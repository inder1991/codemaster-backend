import { describe, expect, it } from "vitest";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import {
  CORE_USER_EMAIL_AAD,
  LOCAL_USER_EMAIL_AAD,
  decryptEmail,
  emailFingerprint,
  encryptEmail,
} from "#backend/api/auth/email_codec.js";

function testRegistry(): KeyRegistry {
  const reg = new KeyRegistry();
  const key = new Uint8Array(32).fill(7); // deterministic 32-byte AES-256 key
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", key]]) }));
  return reg;
}

describe("email_codec — AAD-bound string encryption (parity with EncryptedStringWithAAD)", () => {
  it("round-trips a plaintext email under the local-users AAD", () => {
    const reg = testRegistry();
    const ct = encryptEmail("ops@example.com", reg, LOCAL_USER_EMAIL_AAD);
    expect(ct.startsWith("kms2:1:")).toBe(true); // AAD-bound envelope
    expect(decryptEmail(ct, reg, LOCAL_USER_EMAIL_AAD)).toBe("ops@example.com");
  });

  it("round-trips under the core-users AAD", () => {
    const reg = testRegistry();
    const ct = encryptEmail("user@org.com", reg, CORE_USER_EMAIL_AAD);
    expect(decryptEmail(ct, reg, CORE_USER_EMAIL_AAD)).toBe("user@org.com");
  });

  it("refuses to decrypt a ciphertext under a different column's AAD (column isolation)", () => {
    const reg = testRegistry();
    const ct = encryptEmail("ops@example.com", reg, LOCAL_USER_EMAIL_AAD);
    expect(() => decryptEmail(ct, reg, CORE_USER_EMAIL_AAD)).toThrow();
  });

  it("pins the canonical per-column AAD bytes", () => {
    expect(new TextDecoder().decode(LOCAL_USER_EMAIL_AAD)).toBe("core.local_users.email_ciphertext");
    expect(new TextDecoder().decode(CORE_USER_EMAIL_AAD)).toBe("core.users.email");
  });

  describe("emailFingerprint (SHA-256 hex of lowercase, parity with Python hashlib)", () => {
    it("matches Python-minted SHA-256 fixtures", () => {
      expect(emailFingerprint("ops@example.com")).toBe(
        "af3c82544f648b38dc7d403473bb4b957cd04353afd9096fa871c1e469656c8c",
      );
      expect(emailFingerprint("admin@codemaster.internal")).toBe(
        "83902f742c9f5aea3cdb77b202d92bca431b0769e1d917ad200ea6a65c9132a6",
      );
    });

    it("is case-insensitive (lowercases before hashing)", () => {
      expect(emailFingerprint("Ops@Example.COM")).toBe(emailFingerprint("ops@example.com"));
    });
  });
});
