/**
 * Audit field-encryption codec — the AES-256-GCM, per-column-AAD bind/result boundary for the
 * `audit.audit_events.before` / `.after` bytea columns. TS port of the wiring in
 * vendor/codemaster-py/codemaster/audit/emit.py (`_ENCRYPTED_BEFORE` / `_ENCRYPTED_AFTER`, both
 * `EncryptedJSONByteaWithAAD` instances) plus the relevant bind/result behaviour of
 * vendor/codemaster-py/codemaster/security/field_encryption.py::EncryptedJSONByteaWithAAD.
 *
 * ## What it does (ADR-0033)
 *
 * On write: serialize a JSON-able value to canonical UTF-8 JSON (sort_keys + compact separators +
 * ensure_ascii — byte-identical to Python `json.dumps(value, sort_keys=True, separators=(",", ":"))`),
 * encrypt it with the ported {@link encryptField} crypto layer binding the per-column AAD, and return
 * the resulting `kms2:vN:<base64>` envelope as ASCII bytes (the bytea-column shape — Python returns
 * `envelope.encode("ascii")` from `process_bind_param`). On read: decode the bytea back to the ASCII
 * envelope string, decrypt under the same AAD, and JSON-parse. `null` round-trips to DB-NULL on both
 * sides (mirrors the Python `if value is None: return None` short-circuit + the `before is not None`
 * guard in `emit.py`).
 *
 * The AAD binding is the column-isolation security property: a ciphertext written for the `before`
 * column does NOT decrypt under the `after` AAD (or vice versa), so an attacker with DB write access
 * cannot move ciphertexts between columns and have them decrypt cleanly. The AAD constants are the
 * canonical `"<schema>.<table>.<column>"` ASCII bytes, matching the Python `_AUDIT_BEFORE_AAD` /
 * `_AUDIT_AFTER_AAD` exactly so columns are cross-readable between the implementations.
 *
 * ## Key source (registry seam)
 *
 * The codec reads the field-encryption key versions from a module-level {@link KeyRegistry}. Production
 * wiring populates it from Vault KV at pod startup — that loader is NOT ported here; it is a tracked
 * follow-up (FOLLOW-UP-audit-vault-key-loader — port of
 * codemaster/security/key_loader.py::load_field_encryption_keys_at_startup + the periodic refresh task,
 * which read the `secret/codemaster/field-encryption/keys` KV payload). For dev / disposable-PG
 * integration we expose {@link loadAuditKeysFromEnvForDev}, which reads a single base64 32-byte key from
 * the environment. The seam ({@link setAuditKeyRegistry} / {@link getAuditKeyRegistry}) is the join
 * point the Vault loader will populate when it lands.
 *
 * ## Fail-closed
 *
 * Encrypt with no registry installed throws (no plaintext lands in the DB). Decrypt under the wrong AAD
 * (or a tampered ciphertext, or a missing key version) throws — indistinguishable, which is the correct
 * fail-safe (no plaintext leaks). The {@link encryptField} / {@link decryptField} layer raises
 * {@link LocalKeyEncryptionError}; we let it propagate.
 */

import {
  decryptField,
  encryptField,
  LocalKeyEncryptionError,
} from "#platform/crypto/aes_gcm_aad.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

/**
 * Per-column AAD constants — the canonical `"<schema>.<table>.<column>"` ASCII bytes. Byte-identical to
 * Python's `_AUDIT_BEFORE_AAD = b"audit.audit_events.before"` / `_AUDIT_AFTER_AAD = b"audit.audit_events.after"`
 * in `codemaster/audit/emit.py`, so columns encrypted by either implementation are cross-readable.
 */
export const AUDIT_BEFORE_AAD: Uint8Array = new TextEncoder().encode("audit.audit_events.before");
export const AUDIT_AFTER_AAD: Uint8Array = new TextEncoder().encode("audit.audit_events.after");

/** Env var carrying the dev/test field-encryption key (base64 of 32 raw bytes) — name only, for errors. */
const ENV_KEY_B64_NAME = "CODEMASTER_FIELD_ENCRYPTION_KEY_B64";
const AES_256_KEY_BYTES = 32;

/**
 * Module-level registry seam. `null` until a loader installs a key set. Production: the Vault KV loader
 * (FOLLOW-UP-audit-vault-key-loader). Dev/test: {@link loadAuditKeysFromEnvForDev} or
 * {@link setAuditKeyRegistry} directly.
 */
let registry: KeyRegistry | null = null;

/** Install (or clear) the registry the codec encrypts/decrypts with. */
export function setAuditKeyRegistry(value: KeyRegistry | null): void {
  registry = value;
}

/** Return the currently-installed registry, or `null` if no loader has run. */
export function getAuditKeyRegistry(): KeyRegistry | null {
  return registry;
}

/** Test-only: clear the installed registry so each test starts pristine. */
export function resetAuditKeyRegistryForTesting(): void {
  registry = null;
}

function requireRegistry(): KeyRegistry {
  if (registry === null) {
    throw new LocalKeyEncryptionError(
      "audit field-encryption keys not loaded; call loadAuditKeysFromEnvForDev() (dev) or the Vault " +
        "key loader (FOLLOW-UP-audit-vault-key-loader) at startup before emitting audit rows",
    );
  }
  return registry;
}

/**
 * Dev / disposable-PG key loader: read a single base64 32-byte key from `CODEMASTER_FIELD_ENCRYPTION_KEY_B64`
 * (version from `CODEMASTER_FIELD_ENCRYPTION_KEY_VERSION`, default `"1"`) and install it as the current
 * registry. Throws loudly when the key var is unset or the decoded key is not 32 bytes — a misconfigured
 * dev key must fail fast, never silently degrade.
 *
 * NOT for production: the real key source is Vault KV via the ported loader (FOLLOW-UP-audit-vault-key-loader).
 * Reading a KNOWN env var (static `process.env.X` access, not dynamic indexing) is outside the
 * clock/random gate's scope.
 */
export function loadAuditKeysFromEnvForDev(): void {
  // Static `process.env.X` access (not dynamic indexing) — no object-injection sink, matching the repo
  // convention (e.g. persist_review_findings.activity.ts's clock-pin env read).
  const b64 = process.env.CODEMASTER_FIELD_ENCRYPTION_KEY_B64;
  if (b64 === undefined || b64 === "") {
    throw new Error(
      `${ENV_KEY_B64_NAME} is not set; cannot load the dev audit field-encryption key`,
    );
  }
  const version = process.env.CODEMASTER_FIELD_ENCRYPTION_KEY_VERSION ?? "1";
  const key = new Uint8Array(Buffer.from(b64, "base64"));
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `${ENV_KEY_B64_NAME} decoded to ${key.length} bytes; AES-256-GCM requires ${AES_256_KEY_BYTES}`,
    );
  }
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: version, keys: new Map([[version, key]]) }));
  registry = reg;
}

/**
 * Canonical JSON encoding — byte-identical to Python `json.dumps(value, sort_keys=True,
 * separators=(",", ":"))`, INCLUDING `ensure_ascii=True` (the default): every non-ASCII code point is
 * emitted as a `\uXXXX` escape (non-BMP as a UTF-16 surrogate pair). This matters for the
 * security-critical cross-impl property — the encrypted PLAINTEXT must be byte-equal between the Python
 * and TS codecs so a row written by one decrypts to the same JSON in the other. `JSON.stringify` alone
 * does NOT escape non-ASCII, so we post-process its output.
 */
export function canonicalAuditJson(value: unknown): string {
  return escapeNonAscii(JSON.stringify(sortKeysDeep(value)));
}

/** Recursively sort object keys (arrays preserve order; primitives pass through) — `sort_keys=True`. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // `key` is a bounded own-enumerable string key from Object.keys, never an attacker-controlled
      // object-key sink — the prototype-pollution threat model does not apply.
      // eslint-disable-next-line security/detect-object-injection
      sorted[key] = sortKeysDeep(src[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Escape every code unit above 0x7f as `\uXXXX`, reproducing Python `json.dumps(ensure_ascii=True)`.
 * Because `JSON.stringify` already emits UTF-16 code units and Python escapes non-BMP characters as
 * surrogate pairs, iterating code UNITS (not code points) reproduces the surrogate-pair output exactly.
 */
function escapeNonAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      // `i` is a bounded loop index into the local string `s`, never an attacker-controlled key sink.
      // eslint-disable-next-line security/detect-object-injection
      out += s[i];
    }
  }
  return out;
}

/**
 * Marker prefix for the UNENCRYPTED `plain:v1:` audit-payload format.
 *
 * ⚠️ DELIBERATE DEVIATION from the encrypt-at-rest invariant (ADR-0070, project-owner decision
 * 2026-06-06). Used ONLY by the output-safety audit emit so it needs NO field-encryption key / Vault:
 * the payload — including the pre-redaction `original_text`, which CONTAINS the detected secret — is
 * stored in CLEARTEXT in `audit.audit_events.before`. All OTHER audit columns keep AES-256-GCM. The
 * read path ({@link decryptAuditJsonBytea}) detects this prefix and parses the JSON tail with no key.
 */
const PLAINTEXT_FORMAT_PREFIX = "plain:v1:";

/**
 * UNENCRYPTED bind path for the output-safety audit `before` payload (ADR-0070). Serialize `value` to
 * canonical JSON and prepend the `plain:v1:` marker — NO key, NO AAD, NO encryption. `null`/`undefined`
 * → DB-NULL. The canonical JSON is ASCII (non-ASCII escaped to `\uXXXX`), so the envelope is ASCII bytes
 * just like the encrypted shape. See {@link PLAINTEXT_FORMAT_PREFIX} for the security trade-off.
 */
export function encodeAuditJsonPlaintext(value: unknown): Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Buffer.from(PLAINTEXT_FORMAT_PREFIX + canonicalAuditJson(value), "ascii");
}

/**
 * Bind path — `EncryptedJSONByteaWithAAD.process_bind_param`. Serialize `value` to canonical JSON,
 * encrypt with the per-column `aad`, and return the `kms2:vN:` envelope as ASCII bytes (the bytea
 * column shape). `null` → DB-NULL (returns `null`).
 */
export function encryptAuditJsonBytea(value: unknown, aad: Uint8Array): Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }
  const reg = requireRegistry();
  const plaintext = new TextEncoder().encode(canonicalAuditJson(value));
  const envelope = encryptField({ plaintext, registry: reg, aad });
  // Python returns `envelope.encode("ascii")`; the kms2 envelope is base64 + a small ASCII header.
  return Buffer.from(envelope, "ascii");
}

/**
 * Result path — `EncryptedJSONByteaWithAAD.process_result_value`. Decode the bytea back to the ASCII
 * envelope string, decrypt under the same `aad`, and JSON-parse. `null` → `null`.
 */
export function decryptAuditJsonBytea(
  value: Buffer | Uint8Array | null,
  aad: Uint8Array,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = Buffer.from(value).toString("ascii");
  // `plain:v1:` — UNENCRYPTED payload written by {@link encodeAuditJsonPlaintext} (ADR-0070). No key /
  // AAD needed; parse the JSON tail directly. This keeps the dual-format read scheme coherent (a new
  // format in the documented set) rather than choking on bare JSON bytes.
  if (raw.startsWith(PLAINTEXT_FORMAT_PREFIX)) {
    return JSON.parse(raw.slice(PLAINTEXT_FORMAT_PREFIX.length)) as unknown;
  }
  const reg = requireRegistry();
  const plaintext = decryptField({ ciphertext: raw, registry: reg, aad });
  return JSON.parse(Buffer.from(plaintext).toString("utf-8")) as unknown;
}
