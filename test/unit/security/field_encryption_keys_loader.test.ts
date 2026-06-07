import { describe, expect, it } from "vitest";

import { decryptField, encryptField } from "#platform/crypto/aes_gcm_aad.js";

import {
  FIELD_ENCRYPTION_KEYS_VAULT_PATH,
  FieldKeyLoaderError,
  type VaultKvRawReadPort,
  loadFieldEncryptionKeyRegistry,
  parseKeysetPayload,
} from "#backend/security/field_encryption_keys_loader.js";

// The dev-seed key (helm/local-kind/seed-vault.sh): an all-zero 32-byte key, base64-encoded.
const ZERO_KEY_B64 = Buffer.alloc(32).toString("base64");
const NONZERO_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

function fakeReader(payload: Record<string, unknown>): VaultKvRawReadPort {
  return {
    kvReadRaw: async (args) => {
      expect(args.path).toBe(FIELD_ENCRYPTION_KEYS_VAULT_PATH);
      return payload;
    },
  };
}

describe("field_encryption_keys_loader (parity with key_loader.py)", () => {
  describe("parseKeysetPayload", () => {
    it("parses a valid keyset", () => {
      const { currentVersion, keys } = parseKeysetPayload({
        current_version: "v2",
        keys: { v1: ZERO_KEY_B64, v2: NONZERO_KEY_B64 },
      });
      expect(currentVersion).toBe("v2");
      expect(keys.size).toBe(2);
      expect(keys.get("v2")).toEqual(new Uint8Array(32).fill(7));
    });

    it("rejects a missing current_version / keys", () => {
      expect(() => parseKeysetPayload({ keys: { v1: ZERO_KEY_B64 } })).toThrow(FieldKeyLoaderError);
      expect(() => parseKeysetPayload({ current_version: "v1" })).toThrow(FieldKeyLoaderError);
    });

    it("rejects a non-string key value / non-base64 / wrong key size", () => {
      expect(() => parseKeysetPayload({ current_version: "v1", keys: { v1: 123 } })).toThrow(
        FieldKeyLoaderError,
      );
      expect(() => parseKeysetPayload({ current_version: "v1", keys: { v1: "!!!notb64" } })).toThrow(
        FieldKeyLoaderError,
      );
      // 16 bytes (AES-128) — too short for AES-256.
      expect(() =>
        parseKeysetPayload({ current_version: "v1", keys: { v1: Buffer.alloc(16).toString("base64") } }),
      ).toThrow(FieldKeyLoaderError);
    });
  });

  describe("loadFieldEncryptionKeyRegistry", () => {
    it("builds a registry whose current key encrypts/decrypts (end-to-end through the crypto layer)", async () => {
      const reg = await loadFieldEncryptionKeyRegistry(
        fakeReader({ current_version: "v1", keys: { v1: NONZERO_KEY_B64 } }),
      );
      const aad = new TextEncoder().encode("core.users.email");
      const ct = encryptField({ plaintext: new TextEncoder().encode("a@b.c"), registry: reg, aad });
      expect(ct.startsWith("kms2:v1:")).toBe(true);
      expect(new TextDecoder().decode(decryptField({ ciphertext: ct, registry: reg, aad }))).toBe(
        "a@b.c",
      );
    });

    it("throws when current_version is not present in keys (makeKeySet guard)", async () => {
      await expect(
        loadFieldEncryptionKeyRegistry(fakeReader({ current_version: "v9", keys: { v1: ZERO_KEY_B64 } })),
      ).rejects.toThrow();
    });
  });
});
