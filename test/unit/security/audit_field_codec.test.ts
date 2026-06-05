/**
 * Unit tests for the audit field-encryption codec — TS port of the bind/result behaviour of
 * vendor/codemaster-py/codemaster/security/field_encryption.py::EncryptedJSONByteaWithAAD as wired by
 * codemaster/audit/emit.py (_ENCRYPTED_BEFORE / _ENCRYPTED_AFTER, AAD-bound to the column names).
 *
 * The codec serializes a JSON-able value to canonical UTF-8 JSON (sort_keys + compact separators +
 * ensure_ascii — byte-identical to Python `json.dumps(value, sort_keys=True, separators=(",", ":"))`),
 * encrypts it with AES-256-GCM bound to the per-column AAD, and returns the `kms2:vN:` envelope as
 * ASCII bytes (the bytea column shape). Read reverses it.
 *
 * These tests use an explicitly-installed dev KeyRegistry (NOT the env loader) so they are hermetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUDIT_AFTER_AAD,
  AUDIT_BEFORE_AAD,
  canonicalAuditJson,
  decryptAuditJsonBytea,
  encryptAuditJsonBytea,
  getAuditKeyRegistry,
  loadAuditKeysFromEnvForDev,
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

/** A deterministic 32-byte dev key registry at version "1". */
function devRegistry(fill = 0x42): KeyRegistry {
  const registry = new KeyRegistry();
  registry.set(
    makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(fill)]]) }),
  );
  return registry;
}

beforeEach(() => {
  resetAuditKeyRegistryForTesting();
});

afterEach(() => {
  resetAuditKeyRegistryForTesting();
});

describe("canonicalAuditJson (byte-parity with Python json.dumps)", () => {
  it("sorts object keys and uses compact separators", () => {
    expect(canonicalAuditJson({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it("escapes non-ASCII (ensure_ascii=True parity)", () => {
    // Python `json.dumps({"a":"café"}, ...)` -> '{"a":"caf\\u00e9"}'. JSON.stringify would NOT escape.
    expect(canonicalAuditJson({ a: "café" })).toBe('{"a":"caf\\u00e9"}');
  });

  it("escapes a non-BMP character as a surrogate pair (matches Python)", () => {
    // U+1F600 GRINNING FACE -> "😀" in Python's ensure_ascii output.
    expect(canonicalAuditJson({ e: "😀" })).toBe('{"e":"\\ud83d\\ude00"}');
  });
});

describe("encrypt/decrypt round-trip (kms2: AAD-bound bytea)", () => {
  it("round-trips a before-payload dict", () => {
    setAuditKeyRegistry(devRegistry());
    const payload = {
      schema_version: 1,
      original_text: "sk-SECRET",
      redacted_text: "sk-[REDACTED]",
      detector_kinds: ["secret_leaked"],
    };
    const enc = encryptAuditJsonBytea(payload, AUDIT_BEFORE_AAD);
    expect(enc).not.toBeNull();
    // The envelope is the kms2: prefix encoded as ASCII bytes.
    expect(Buffer.from(enc!).toString("ascii").startsWith("kms2:1:")).toBe(true);
    expect(decryptAuditJsonBytea(enc, AUDIT_BEFORE_AAD)).toEqual(payload);
  });

  it("returns null for a null value on both bind and result", () => {
    setAuditKeyRegistry(devRegistry());
    expect(encryptAuditJsonBytea(null, AUDIT_BEFORE_AAD)).toBeNull();
    expect(decryptAuditJsonBytea(null, AUDIT_BEFORE_AAD)).toBeNull();
  });

  it("produces different ciphertexts for the same payload (random nonce) but both decrypt", () => {
    setAuditKeyRegistry(devRegistry());
    const payload = { k: "v" };
    const a = encryptAuditJsonBytea(payload, AUDIT_BEFORE_AAD)!;
    const b = encryptAuditJsonBytea(payload, AUDIT_BEFORE_AAD)!;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(decryptAuditJsonBytea(a, AUDIT_BEFORE_AAD)).toEqual(payload);
    expect(decryptAuditJsonBytea(b, AUDIT_BEFORE_AAD)).toEqual(payload);
  });
});

describe("AAD binding (security property — column isolation)", () => {
  it("a before-AAD ciphertext does NOT decrypt under the after-AAD", () => {
    setAuditKeyRegistry(devRegistry());
    const enc = encryptAuditJsonBytea({ k: "v" }, AUDIT_BEFORE_AAD)!;
    expect(() => decryptAuditJsonBytea(enc, AUDIT_AFTER_AAD)).toThrow();
  });

  it("before and after AAD constants are the canonical column names", () => {
    expect(Buffer.from(AUDIT_BEFORE_AAD).toString("ascii")).toBe("audit.audit_events.before");
    expect(Buffer.from(AUDIT_AFTER_AAD).toString("ascii")).toBe("audit.audit_events.after");
  });
});

describe("registry seam (set / get / reset)", () => {
  it("getAuditKeyRegistry returns null before any load", () => {
    expect(getAuditKeyRegistry()).toBeNull();
  });

  it("encrypt fails closed when no registry is installed", () => {
    expect(() => encryptAuditJsonBytea({ k: "v" }, AUDIT_BEFORE_AAD)).toThrow();
  });

  it("set then get returns the same registry; reset clears it", () => {
    const r = devRegistry();
    setAuditKeyRegistry(r);
    expect(getAuditKeyRegistry()).toBe(r);
    resetAuditKeyRegistryForTesting();
    expect(getAuditKeyRegistry()).toBeNull();
  });
});

describe("loadAuditKeysFromEnvForDev (dev/test key source — FOLLOW-UP-audit-vault-key-loader)", () => {
  const ENV_KEY = "CODEMASTER_FIELD_ENCRYPTION_KEY_B64";
  const ENV_VER = "CODEMASTER_FIELD_ENCRYPTION_KEY_VERSION";
  let savedKey: string | undefined;
  let savedVer: string | undefined;

  beforeEach(() => {
    savedKey = process.env[ENV_KEY];
    savedVer = process.env[ENV_VER];
    delete process.env[ENV_KEY];
    delete process.env[ENV_VER];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
    if (savedVer === undefined) delete process.env[ENV_VER];
    else process.env[ENV_VER] = savedVer;
  });

  it("loads a base64 32-byte key from the env and installs it as the current registry", () => {
    process.env[ENV_KEY] = Buffer.alloc(32, 0x7a).toString("base64");
    process.env[ENV_VER] = "1";
    loadAuditKeysFromEnvForDev();
    const reg = getAuditKeyRegistry();
    expect(reg).not.toBeNull();
    expect(reg!.current().version).toBe("1");
    // And it actually works for a round-trip.
    const enc = encryptAuditJsonBytea({ ok: true }, AUDIT_BEFORE_AAD)!;
    expect(decryptAuditJsonBytea(enc, AUDIT_BEFORE_AAD)).toEqual({ ok: true });
  });

  it("defaults the version to '1' when the version env var is unset", () => {
    process.env[ENV_KEY] = Buffer.alloc(32, 0x01).toString("base64");
    loadAuditKeysFromEnvForDev();
    expect(getAuditKeyRegistry()!.current().version).toBe("1");
  });

  it("throws when the key env var is unset", () => {
    expect(() => loadAuditKeysFromEnvForDev()).toThrow(/CODEMASTER_FIELD_ENCRYPTION_KEY_B64/);
  });

  it("throws when the decoded key is not 32 bytes", () => {
    process.env[ENV_KEY] = Buffer.alloc(16, 0x01).toString("base64");
    expect(() => loadAuditKeysFromEnvForDev()).toThrow();
  });
});
