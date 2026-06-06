// Field-encryption key loader — 1:1 port of codemaster/security/key_loader.py
// (the FOLLOW-UP-audit-vault-key-loader the audit codec named). Reads the local-AES keyset from Vault and
// builds a KeyRegistry the email codec + audit codec + repos share at pod startup.
//
// Vault payload shape (seeded at `secret/codemaster/field-encryption/keys`):
//
//   { "current_version": "vN", "keys": { "v1": "<base64 32-byte key>", "vN": "..." } }
//
// Read via the Vault HTTP API (kvReadRaw — the nested `keys` object must survive; the flat kvRead /
// agent-file path is for string-valued secrets only). Replaces the dev-only env loader
// (loadAuditKeysFromEnvForDev) for production wiring.

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

/** Default Vault KV path (the `secret/` mount prefix is supplied by the Vault adapter's kvMount). */
export const FIELD_ENCRYPTION_KEYS_VAULT_PATH = "codemaster/field-encryption/keys";

const AES_256_KEY_BYTES = 32;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The nested-preserving Vault read surface the loader needs (VaultHttpPort.kvReadRaw satisfies it). */
export type VaultKvRawReadPort = {
  kvReadRaw(args: { path: string; version?: number }): Promise<Record<string, unknown>>;
};

export class FieldKeyLoaderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FieldKeyLoaderError";
  }
}

/** Parse the Vault keyset payload into (currentVersion, version→key bytes). Mirrors parse_keyset_payload:
 *  validates the field shapes, strict-base64-decodes each key, and enforces the 32-byte AES-256 size. */
export function parseKeysetPayload(payload: Record<string, unknown>): {
  currentVersion: string;
  keys: Map<string, Uint8Array>;
} {
  const currentVersion = payload["current_version"];
  if (currentVersion === undefined) {
    throw new FieldKeyLoaderError("payload missing 'current_version' field");
  }
  if (typeof currentVersion !== "string") {
    throw new FieldKeyLoaderError(`current_version must be str, got ${typeof currentVersion}`);
  }
  const keysRaw = payload["keys"];
  if (keysRaw === undefined) {
    throw new FieldKeyLoaderError("payload missing 'keys' field");
  }
  if (typeof keysRaw !== "object" || keysRaw === null || Array.isArray(keysRaw)) {
    throw new FieldKeyLoaderError("keys must be an object");
  }

  const keys = new Map<string, Uint8Array>();
  for (const [version, b64] of Object.entries(keysRaw)) {
    if (typeof b64 !== "string") {
      throw new FieldKeyLoaderError(`keys[${version}] must be a base64 string, got ${typeof b64}`);
    }
    if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
      throw new FieldKeyLoaderError(`keys[${version}] is not valid base64`);
    }
    const decoded = Buffer.from(b64, "base64");
    // Round-trip guard: Node's base64 decoder is lenient about trailing junk; re-encode + compare.
    if (decoded.toString("base64") !== b64) {
      throw new FieldKeyLoaderError(`keys[${version}] is not valid base64`);
    }
    if (decoded.length !== AES_256_KEY_BYTES) {
      throw new FieldKeyLoaderError(
        `keys[${version}] decoded to ${decoded.length} bytes; AES-256 requires ${AES_256_KEY_BYTES}`,
      );
    }
    keys.set(version, new Uint8Array(decoded));
  }
  return { currentVersion, keys };
}

/** Fetch the keyset from Vault and build a populated {@link KeyRegistry}. `makeKeySet` enforces
 *  currentVersion ∈ keys (else throws). */
export async function loadFieldEncryptionKeyRegistry(
  reader: VaultKvRawReadPort,
  path: string = FIELD_ENCRYPTION_KEYS_VAULT_PATH,
): Promise<KeyRegistry> {
  const payload = await reader.kvReadRaw({ path });
  const { currentVersion, keys } = parseKeysetPayload(payload);
  const registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion, keys }));
  return registry;
}
