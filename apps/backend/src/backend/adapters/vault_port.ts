/**
 * Vault adapter port — 1:1 port of `codemaster/adapters/vault_port.py`
 * (frozen Python, Sprint 0 / S0.3b).
 *
 * The {@link VaultPort} type is what `vault_credential_write` and any other secrets-touching code
 * depends on. Production wiring uses a real-Vault adapter (a later task); tests use the
 * {@link InMemoryVault} test double defined here.
 *
 * Why a Port: the outbox sink, the integrations API, and the on-startup secret loader all need
 * Vault operations. Putting them behind a typed interface means each can be unit-tested without
 * spinning up Vault, and chaos tests can inject failure modes deterministically (see
 * {@link InMemoryVault.simulateUnreachable}).
 *
 * --- Port-fidelity notes vs the Python (see also the test header) ---
 *   - `bytes` → `Uint8Array`. Python Transit plaintext is `bytes`; TS uses `Uint8Array`. The
 *     in-memory fixture stores the array reference verbatim (Python stores the `bytes` object
 *     verbatim — `bytes` is immutable, `Uint8Array` is not, but the fixture is a test-only oracle
 *     keyed by an opaque ciphertext blob; callers never mutate the stored array in practice).
 *   - kv versions are 1-indexed in the public API exactly as in the Python: version N is stored at
 *     array index N-1; `kvWrite` returns the new length; `kvRead({ version: undefined })` reads the
 *     latest.
 *   - copy-on-read / copy-on-write: `kvWrite` stores a `{ ...data }` shallow copy and `kvRead`
 *     returns a `{ ...stored }` shallow copy, mirroring the Python `dict(data)` / `dict(...)` so a
 *     caller cannot mutate stored state through the value it passed in or got back.
 *   - keyword args → a single args-object per call (the repo's args-object convention).
 */

// ─── The narrow Vault-operation interface this codebase depends on ─────────────────────────────

/**
 * The narrow Vault-operation interface this codebase depends on. Implemented by the production
 * adapter (a later task) and by {@link InMemoryVault} for tests.
 */
export type VaultPort = {
  /**
   * Write secret material at `path`. Returns the new vault_version.
   *
   * If `cas` is provided, the write succeeds only if the current version === `cas` (Vault's
   * check-and-set). Throws {@link VaultCasMismatch} on conflict.
   */
  kvWrite(args: { path: string; data: Record<string, string>; cas?: number }): Promise<number>;

  /** Read secret material from `path`. If `version` is undefined, returns the latest. */
  kvRead(args: { path: string; version?: number }): Promise<Record<string, string>>;

  /** Return the current vault_version at `path`. 0 if the path does not exist. */
  kvCurrentVersion(args: { path: string }): Promise<number>;

  /**
   * Delete ALL versions at `path` (Vault KV-v2 metadata-delete).
   *
   * Idempotent — deleting a non-existent path is a no-op; reading after delete throws
   * {@link VaultPathNotFound}.
   */
  kvDelete(args: { path: string }): Promise<void>;

  /** Encrypt with Vault Transit; return the ciphertext blob. */
  transitEncrypt(args: { keyName: string; plaintext: Uint8Array }): Promise<string>;

  /** Decrypt a Transit ciphertext blob. */
  transitDecrypt(args: { keyName: string; ciphertext: string }): Promise<Uint8Array>;
};

// ─── Typed exceptions (1:1 with the Python error hierarchy) ────────────────────────────────────

/** Base class for Vault operation failures. */
export class VaultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Thrown when `kvWrite` is given a `cas` that does not equal the current version. */
export class VaultCasMismatch extends VaultError {
  public constructor(message: string) {
    super(message);
    this.name = "VaultCasMismatch";
  }
}

/** Thrown when reading a path that does not exist (or an out-of-range version). */
export class VaultPathNotFound extends VaultError {
  public constructor(message: string) {
    super(message);
    this.name = "VaultPathNotFound";
  }
}

/** Thrown when Vault is unreachable. Retryable by the caller. */
export class VaultConnectivityError extends VaultError {
  public constructor(message: string) {
    super(message);
    this.name = "VaultConnectivityError";
  }
}

// ─── In-memory implementation for tests ────────────────────────────────────────────────────────

/**
 * Test implementation of {@link VaultPort}. Keeps all state in `Map`s.
 *
 * Use this in unit tests for sink handlers, the integrations API, and any code that depends on
 * Vault. {@link simulateUnreachable} flips every method to throw {@link VaultConnectivityError}
 * for chaos tests.
 */
export class InMemoryVault implements VaultPort {
  // path -> list of versions (1-indexed in the public API: version N is at array index N-1).
  private readonly kv = new Map<string, Array<Record<string, string>>>();
  // keyName -> (ciphertext -> plaintext). Test fixture; production Vault uses real cryptography.
  private readonly transit = new Map<string, Map<string, Uint8Array>>();
  private transitCounter = 0;
  private unreachable = false;

  // --- VaultPort impl ---

  public async kvWrite(args: {
    path: string;
    data: Record<string, string>;
    cas?: number;
  }): Promise<number> {
    if (this.unreachable) {
      throw new VaultConnectivityError("simulated connectivity failure");
    }
    let versions = this.kv.get(args.path);
    if (versions === undefined) {
      versions = [];
      this.kv.set(args.path, versions);
    }
    const current = versions.length;
    if (args.cas !== undefined && args.cas !== current) {
      throw new VaultCasMismatch(`cas=${args.cas} but current=${current}`);
    }
    // Copy-on-write: store a shallow copy so the caller cannot mutate stored state (Python dict()).
    versions.push({ ...args.data });
    return versions.length;
  }

  public async kvRead(args: { path: string; version?: number }): Promise<Record<string, string>> {
    if (this.unreachable) {
      throw new VaultConnectivityError("simulated connectivity failure");
    }
    const versions = this.kv.get(args.path);
    if (versions === undefined || versions.length === 0) {
      throw new VaultPathNotFound(args.path);
    }
    // Mirror Python's `idx = (version or len) - 1`: version 0 is FALSY in Python, so it (like
    // `undefined`) reads the LATEST version — Vault's convention that version 0 means "current".
    // `??` would NOT coalesce 0 (only null/undefined), wrongly mapping 0 -> idx -1 -> not-found and
    // diverging from both Python and the VaultHttpPort sibling. A negative version stays as-is and
    // trips the `idx < 0` guard below, matching Python's pre-index guard.
    const requestedVersion =
      args.version === undefined || args.version === 0 ? versions.length : args.version;
    const idx = requestedVersion - 1;
    if (idx < 0 || idx >= versions.length) {
      throw new VaultPathNotFound(`${args.path} version=${args.version}`);
    }
    // Copy-on-read: return a shallow copy so the caller cannot mutate stored state (Python dict()).
    return { ...versions[idx]! };
  }

  public async kvCurrentVersion(args: { path: string }): Promise<number> {
    if (this.unreachable) {
      throw new VaultConnectivityError("simulated connectivity failure");
    }
    return this.kv.get(args.path)?.length ?? 0;
  }

  public async kvDelete(args: { path: string }): Promise<void> {
    if (this.unreachable) {
      throw new VaultConnectivityError("simulated connectivity failure");
    }
    // Idempotent — deleting a non-existent path is a no-op (Map.delete on an absent key is fine).
    this.kv.delete(args.path);
  }

  public async transitEncrypt(args: { keyName: string; plaintext: Uint8Array }): Promise<string> {
    if (this.unreachable) {
      throw new VaultConnectivityError("simulated connectivity failure");
    }
    this.transitCounter += 1;
    const ciphertext = `vault:v1:${args.keyName}:${this.transitCounter}`;
    let perKey = this.transit.get(args.keyName);
    if (perKey === undefined) {
      perKey = new Map<string, Uint8Array>();
      this.transit.set(args.keyName, perKey);
    }
    perKey.set(ciphertext, args.plaintext);
    return ciphertext;
  }

  public async transitDecrypt(args: {
    keyName: string;
    ciphertext: string;
  }): Promise<Uint8Array> {
    if (this.unreachable) {
      throw new VaultConnectivityError("simulated connectivity failure");
    }
    const plaintext = this.transit.get(args.keyName)?.get(args.ciphertext);
    if (plaintext === undefined) {
      // Mirrors the Python `KeyError` surfacing: an out-of-fixture decrypt is a
      // test-programming error, so we let it surface as a hard failure.
      throw new VaultError(
        `no transit fixture for key_name=${args.keyName} ciphertext=${args.ciphertext}`,
      );
    }
    return plaintext;
  }

  // --- test-only API ---

  /** Toggle simulated connectivity failure for chaos tests (Python `simulate_unreachable`). */
  public simulateUnreachable(value = true): void {
    this.unreachable = value;
  }
}
