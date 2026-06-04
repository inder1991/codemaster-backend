/**
 * GitHubAppTokenProvider — 1:1 port of `codemaster/integrations/github/token_provider.py`
 * (frozen Python, Sprint 15 / S15.X-token-provider).
 *
 * The production `_TokenProvider` the worker wires into {@link GitHubApiClient}: an async
 * `(installationId) => Promise<token>` source that wraps the Sprint-4 `app_jwt` +
 * `installation_token` primitives with the operational hardening required for a 5,000-engineer /
 * 60-org / 3,000-repo deployment:
 *
 *   - {@link GitHubAppTokenProvider.fromEnv} factory that loads `app_id` + `private_key_pem` from a
 *     Vault KV-v2 secret at `codemaster/github/app` (Vault read failures PROPAGATE — fail-closed at
 *     deployment level: the pod fails to start, kubelet retries with backoff).
 *   - Per-installation single-flight mint coalescence via the {@link KeyedMutex} (the
 *     `asyncio.Lock`-per-id analogue REUSED from `installation_token.ts`).
 *   - LRU-bounded token cache (default 1000 entries) so a long-lived process cannot leak. The
 *     OrderedDict `move_to_end` / `popitem(last=False)` semantics are reproduced via a plain
 *     `Map` (JS Maps preserve insertion order) with explicit delete+set to move-to-end on hit AND
 *     put, and oldest-first eviction (`map.keys().next().value`).
 *   - 60-second negative cache for {@link PermanentTokenError} to absorb the webhook-redelivery
 *     fan-out against a deleted/suspended installation (otherwise a single bad install_id hammers
 *     GitHub's mint endpoint). Keyed on the MONOTONIC axis (`clock.monotonic()`), not wall-clock.
 *   - 5xx exponential backoff up to {@link MAX_5XX_RETRIES} retries, surfaced as
 *     {@link TransientTokenError} on exhaustion. The loop runs `MAX_5XX_RETRIES + 1` attempts; a
 *     pure-5xx run sleeps `[0.5, 1.0, 2.0]` across attempts 0,1,2 then RAISES on attempt 3 (NO sleep
 *     on the final). A 401-first run BURNS a loop iteration with NO sleep + NO backoff change.
 *   - OTel span `github.token.mint` per ACTUAL mint (NOT cache hits) carrying `installation_id`,
 *     `cache_hit`, `outcome` attributes.
 *
 * --- Injected seams (everything non-deterministic is injected) ---
 *   - `clock`: ALL timing (the 5xx backoff `sleep`, the negative-cache `monotonic` TTL, the cache
 *     `now`) goes through the injected {@link Clock}, NEVER `Date`/`setTimeout` — the
 *     check_clock_random gate enforces this.
 *   - `http`: the HTTP transport. Production passes {@link FetchGitHubHttpClient}; tests pass a
 *     counting/scripting stub satisfying {@link GitHubHttpClient} structurally.
 *
 * Port fidelity notes vs the Python:
 *   - The cache envelope ({@link CachedToken}) is process-local and DISTINCT from the on-the-wire
 *     {@link InstallationAccessTokenResponseV1}; it carries `mintedAt` so the refresh-at-fraction
 *     check is precise.
 *   - httpx `RequestError` (a THROWN transport/network error) → the JS analogue is a THROWN error
 *     from `http.request`; the retry loop catches it as the transient/network branch.
 *   - PyJWT's `PyJWTError` catch (for malformed-key inputs newer PyJWT surfaces as `InvalidKeyError`)
 *     collapses in TS to "ANY throw from `signAppJwt`": `app_jwt.signAppJwt` already wraps
 *     `node:crypto` failures as {@link GitHubPrivateKeyMalformed}, and we additionally catch any
 *     other signing throw and wrap it as a {@link PermanentTokenError}.
 */

import {
  InstallationAccessTokenResponseV1,
} from "#contracts/installation_access_token_response.v1.js";

import { formatException } from "#platform/errors.js";
import { type Clock } from "#platform/clock.js";
import { getTracer } from "#platform/observability/tracing.js";

import { type VaultPort } from "#backend/adapters/vault_port.js";
import { type GitHubHttpClient } from "#backend/integrations/github/api_client.js";
import { signAppJwt } from "#backend/integrations/github/app_jwt.js";
import { KeyedMutex } from "#backend/integrations/github/installation_token.js";

const TRACER = getTracer("codemaster.integrations.github.token_provider");

// ─── Constants (1:1 with the frozen Python module constants) ──────────────────────────────────

/** GitHub REST API base. */
export const GITHUB_BASE_URL = "https://api.github.com";
/** Token-exchange path; `{installation_id}` is substituted at call time. */
export const TOKEN_EXCHANGE_PATH = "/app/installations/{installation_id}/access_tokens";

/** Re-mint once the token is ≥ this fraction through its TTL (default 0.8). */
export const DEFAULT_REFRESH_FRACTION = 0.8;
/** LRU cache bound (default 1000 entries). */
export const DEFAULT_MAX_CACHE_ENTRIES = 1000;
/** A PermanentTokenError is negative-cached for this many seconds. */
export const NEGATIVE_CACHE_TTL_SECONDS = 60;
/** Max 5xx/network retries (the loop runs MAX_5XX_RETRIES + 1 attempts). */
export const MAX_5XX_RETRIES = 3;
/** Initial backoff before the first retry; DOUBLES each subsequent 5xx/network retry. */
export const INITIAL_BACKOFF_SECONDS = 0.5;
/** Vault KV-v2 path holding `app_id` + `private_key_pem`. */
export const VAULT_KV_PATH = "codemaster/github/app";

// Refresh-fraction validation bounds (1:1 with the Python `0.1 <= x <= 0.95`).
const REFRESH_FRACTION_MIN = 0.1;
const REFRESH_FRACTION_MAX = 0.95;

/** Base-10 integer literal (optional surrounding whitespace + sign), matching Python `int(str)`. */
const APP_ID_INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Parse the Vault-seeded `app_id` string the way Python's `int(secret["app_id"])` does: optional
 * surrounding whitespace, an optional sign, then base-10 digits ONLY. This FAILS CLOSED on a
 * malformed secret (`"12.5"`, `"0x10"`, `"abc"`, `"1e3"`, `"12abc"`) instead of silently coercing
 * to a wrong/`NaN` App identity the way `Number(...)` would (`Number("0x10")` → 16, `Number("abc")`
 * → `NaN`, and `NaN <= 0` is `false`, so the constructor's `>= 1` guard would NOT catch it). A
 * malformed App id must fail the pod at startup, never mint tokens under the wrong identity.
 */
function parseGithubAppId(raw: string): number {
  const trimmed = raw.trim();
  if (!APP_ID_INTEGER_PATTERN.test(trimmed)) {
    throw new Error(
      `app_id in the Vault secret at ${VAULT_KV_PATH} is not a base-10 integer: ${JSON.stringify(raw)}`,
    );
  }
  return Number.parseInt(trimmed, 10);
}

const MS_PER_SECOND = 1000;

// HTTP status sentinels (mirroring the Python literals).
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CLIENT_ERROR_FLOOR = 400;
const HTTP_SERVER_ERROR_FLOOR = 500;
const HTTP_SERVER_ERROR_CEIL = 600;

// ─── Errors (1:1 with the Python error hierarchy) ─────────────────────────────────────────────

/** Base class for token-provider failures. */
export class TokenProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TokenProviderError";
  }
}

/**
 * Non-retryable: bad app id, expired/malformed key, deleted installation, malformed response,
 * App suspended. Negative-cached for {@link NEGATIVE_CACHE_TTL_SECONDS}.
 */
export class PermanentTokenError extends TokenProviderError {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentTokenError";
  }
}

/** Retryable: GitHub 5xx, network blip, primary rate-limit. Surfaced after retries are exhausted. */
export class TransientTokenError extends TokenProviderError {
  public constructor(message: string) {
    super(message);
    this.name = "TransientTokenError";
  }
}

// ─── Cache envelope ───────────────────────────────────────────────────────────────────────────

/**
 * Process-local cache entry. DISTINCT from the on-the-wire
 * {@link InstallationAccessTokenResponseV1} envelope; carries `mintedAt` so the
 * refresh-at-fraction check is precise.
 */
export type CachedToken = {
  token: string;
  expiresAt: Date;
  mintedAt: Date;
};

// ─── Negative-cache entry ─────────────────────────────────────────────────────────────────────

type NegativeCacheEntry = {
  error: PermanentTokenError;
  /** Monotonic-clock instant (seconds) past which the entry expires and a re-attempt is forced. */
  expiresMonotonic: number;
};

// ─── Provider ─────────────────────────────────────────────────────────────────────────────────

export type GitHubAppTokenProviderOptions = {
  appId: number;
  privateKeyPem: string;
  http: GitHubHttpClient;
  clock: Clock;
  refreshAtFraction?: number;
  maxCacheEntries?: number;
  baseUrl?: string;
};

/**
 * Implements the `_TokenProvider` contract: `getToken(installationId) => Promise<string>`.
 *
 * The {@link GitHubApiClient} `TokenProvider` type is `(installationId) => Promise<string>`, so wire
 * this in as `provider.getToken.bind(provider)` (a bound method satisfies the function type).
 */
export class GitHubAppTokenProvider {
  private readonly appId: number;
  private readonly privateKeyPem: string;
  private readonly http: GitHubHttpClient;
  private readonly clock: Clock;
  private readonly refreshAtFraction: number;
  private readonly maxCacheEntries: number;
  private readonly baseUrl: string;

  // Plain Map gives us LRU semantics: insertion order is iteration order, so move-to-end is
  // delete+set and oldest-first eviction is `keys().next().value`. (The Python OrderedDict.)
  private readonly cache = new Map<number, CachedToken>();
  // Per-installation single-flight locks (the Python `_locks` dict of `asyncio.Lock`).
  private readonly mutex = new KeyedMutex<number>();
  // Negative cache: installation_id -> { error, monotonic_expiry }.
  private readonly negativeCache = new Map<number, NegativeCacheEntry>();

  public constructor({
    appId,
    privateKeyPem,
    http,
    clock,
    refreshAtFraction = DEFAULT_REFRESH_FRACTION,
    maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
    baseUrl = GITHUB_BASE_URL,
  }: GitHubAppTokenProviderOptions) {
    if (appId <= 0) {
      throw new Error(`app_id must be >= 1, got ${appId}`);
    }
    if (!(refreshAtFraction >= REFRESH_FRACTION_MIN && refreshAtFraction <= REFRESH_FRACTION_MAX)) {
      throw new Error(
        `refresh_at_fraction must be in [0.1, 0.95], got ${refreshAtFraction}`,
      );
    }
    if (maxCacheEntries < 1) {
      throw new Error(`max_cache_entries must be >= 1, got ${maxCacheEntries}`);
    }

    this.appId = appId;
    this.privateKeyPem = privateKeyPem;
    this.http = http;
    this.clock = clock;
    this.refreshAtFraction = refreshAtFraction;
    this.maxCacheEntries = maxCacheEntries;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Read `app_id` + `private_key_pem` from Vault and construct.
   *
   * Missing keys → {@link PermanentTokenError} (message lists the expected + sorted got-keys, 1:1
   * with Python). Vault read failures ({@link VaultPathNotFound} etc.) PROPAGATE — the caller
   * (worker bootstrap) lets this fail the pod so kubelet retries with backoff. **Fail-closed at
   * deployment level.**
   */
  public static async fromEnv({
    vault,
    http,
    clock,
  }: {
    vault: VaultPort;
    http: GitHubHttpClient;
    clock: Clock;
  }): Promise<GitHubAppTokenProvider> {
    const secret = await vault.kvRead({ path: VAULT_KV_PATH });
    if (!("app_id" in secret) || !("private_key_pem" in secret)) {
      const gotKeys = Object.keys(secret).sort();
      throw new PermanentTokenError(
        `Vault secret at ${VAULT_KV_PATH} missing required keys ` +
          `(expected: app_id, private_key_pem; got: [${gotKeys.map((k) => `'${k}'`).join(", ")}])`,
      );
    }
    return new GitHubAppTokenProvider({
      appId: parseGithubAppId(secret["app_id"]!),
      privateKeyPem: secret["private_key_pem"]!,
      http,
      clock,
    });
  }

  /**
   * Return a valid installation token. The Python `async __call__` analogue.
   *
   * Cache hits skip HTTP + skip OTel emission. Cache misses + refreshes mint synchronously with
   * single-flight coalescence and emit `github.token.mint`. A non-expired negative-cache entry is
   * THROWN without an HTTP round trip.
   */
  public async getToken(installationId: number): Promise<string> {
    if (installationId <= 0) {
      throw new Error(`installation_id must be >= 1, got ${installationId}`);
    }

    // Negative-cache fast-path: a recent permanent failure suppresses repeat HTTP for 60 seconds.
    const cachedErr = this.checkNegativeCache(installationId);
    if (cachedErr !== null) {
      throw cachedErr;
    }

    // Positive-cache fast-path.
    const cachedToken = this.cacheLookup(installationId);
    if (cachedToken !== null) {
      return cachedToken;
    }

    // Single-flight: only one mint per installation_id at a time; others wait on the lock then
    // re-read the cache.
    const release = await this.mutex.acquire(installationId);
    try {
      const reread = this.cacheLookup(installationId);
      if (reread !== null) {
        return reread;
      }
      return await this.mint(installationId);
    } finally {
      release();
    }
  }

  /** Close the underlying HTTP client if it exposes `aclose`. Idempotent; no-op otherwise. */
  public async aclose(): Promise<void> {
    const closable = this.http as { aclose?: () => Promise<void> };
    if (typeof closable.aclose === "function") {
      await closable.aclose();
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────────────────────

  /**
   * Sign App JWT, exchange for an installation token, populate the cache. Wraps the work in the
   * `github.token.mint` OTel span (emitted ONLY on an actual mint). Negative-caches a
   * {@link PermanentTokenError}.
   */
  private async mint(installationId: number): Promise<string> {
    return TRACER.startActiveSpan("github.token.mint", async (span) => {
      span.setAttribute("installation_id", installationId);
      span.setAttribute("cache_hit", false);
      try {
        const token = await this.exchangeWithRetry(installationId);
        span.setAttribute("outcome", "success");
        return token;
      } catch (e) {
        if (e instanceof PermanentTokenError) {
          span.setAttribute("outcome", "permanent");
          this.negativeCache.set(installationId, {
            error: e,
            expiresMonotonic: this.clock.monotonic() + NEGATIVE_CACHE_TTL_SECONDS,
          });
          throw e;
        }
        if (e instanceof TransientTokenError) {
          span.setAttribute("outcome", "transient");
          throw e;
        }
        throw e;
      } finally {
        span.end();
      }
    });
  }

  /**
   * POST `/app/installations/{id}/access_tokens` with the retry policy. 401 retries ONCE with a
   * fresh JWT (burning a loop iteration, NO sleep); 5xx/network exponential backoff up to MAX
   * retries; otherwise a typed error is raised.
   */
  private async exchangeWithRetry(installationId: number): Promise<string> {
    let jwt: string;
    try {
      jwt = signAppJwt({
        appId: String(this.appId),
        privateKeyPem: this.privateKeyPem,
        clock: this.clock,
      });
    } catch (e) {
      // `signAppJwt` wraps node:crypto failures as GitHubPrivateKeyMalformed; the Python ALSO
      // catches PyJWTError. In TS, ANY signing throw is a permanent (malformed-key) failure.
      throw new PermanentTokenError(`private key in Vault is malformed: ${formatException(e)}`);
    }

    let attempt401Consumed = false;
    let backoff = INITIAL_BACKOFF_SECONDS;
    const url =
      this.baseUrl + TOKEN_EXCHANGE_PATH.replace("{installation_id}", String(installationId));

    for (let attempt = 0; attempt <= MAX_5XX_RETRIES; attempt += 1) {
      let resp;
      try {
        resp = await this.http.request({
          method: "POST",
          url,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          // The token-exchange POST carries an EMPTY body.
          text_body: "",
        });
      } catch (e) {
        // The httpx.RequestError analogue: a THROWN transport/network error.
        if (attempt < MAX_5XX_RETRIES) {
          await this.clock.sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw new TransientTokenError(
          `network error after ${MAX_5XX_RETRIES} retries: ${formatException(e)}`,
        );
      }

      const status = resp.status;

      if (status === HTTP_UNAUTHORIZED && !attempt401Consumed) {
        attempt401Consumed = true;
        // Mint a fresh JWT in case the previous one was unlucky on clock-skew tolerance. This
        // consumes a loop iteration but does NOT sleep or change the backoff.
        jwt = signAppJwt({
          appId: String(this.appId),
          privateKeyPem: this.privateKeyPem,
          clock: this.clock,
        });
        continue;
      }
      if (status === HTTP_UNAUTHORIZED) {
        throw new PermanentTokenError(
          `GitHub returned 401 twice for installation_id=${installationId}; ` +
            "App suspended, key rotated, or unrecoverable clock skew",
        );
      }
      if (status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND) {
        throw new PermanentTokenError(
          `GitHub returned ${status} for installation_id=${installationId}`,
        );
      }
      if (status >= HTTP_SERVER_ERROR_FLOOR && status < HTTP_SERVER_ERROR_CEIL) {
        if (attempt < MAX_5XX_RETRIES) {
          await this.clock.sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw new TransientTokenError(
          `GitHub ${status} after ${MAX_5XX_RETRIES} retries on token exchange`,
        );
      }
      if (status >= HTTP_CLIENT_ERROR_FLOOR) {
        throw new PermanentTokenError(
          `GitHub ${status} on token exchange for installation_id=${installationId}`,
        );
      }

      // 2xx: parse + cache.
      let envelope: InstallationAccessTokenResponseV1;
      try {
        const parsed: unknown = JSON.parse(resp.body_text ?? "");
        envelope = InstallationAccessTokenResponseV1.parse(parsed);
      } catch (e) {
        throw new PermanentTokenError(
          `malformed token-exchange response: ${formatException(e)}`,
        );
      }

      this.cachePut(installationId, envelope);
      return envelope.token;
    }

    // Unreachable: the loop body either returns or throws.
    /* c8 ignore next */
    throw new TransientTokenError("unreachable retry loop exit");
  }

  /**
   * Return a still-fresh cached token, or `null` if absent / past the refresh-at-fraction boundary.
   * On a hit, LRU-touches the entry (move-to-end).
   */
  private cacheLookup(installationId: number): string | null {
    const cached = this.cache.get(installationId);
    if (cached === undefined) {
      return null;
    }
    const ttlSeconds = (cached.expiresAt.getTime() - cached.mintedAt.getTime()) / MS_PER_SECOND;
    const elapsed = (this.clock.now().getTime() - cached.mintedAt.getTime()) / MS_PER_SECOND;
    if (elapsed >= ttlSeconds * this.refreshAtFraction) {
      // Past the refresh boundary; treat as expired so we re-mint.
      return null;
    }
    // LRU touch: move-to-end (delete + re-set so this id is the newest insertion).
    this.cache.delete(installationId);
    this.cache.set(installationId, cached);
    return cached.token;
  }

  private cachePut(installationId: number, envelope: InstallationAccessTokenResponseV1): void {
    const cached: CachedToken = {
      token: envelope.token,
      expiresAt: new Date(envelope.expires_at),
      mintedAt: this.clock.now(),
    };
    // Move-to-end: delete any prior entry so the re-set lands at the tail (newest).
    this.cache.delete(installationId);
    this.cache.set(installationId, cached);
    // LRU eviction: drop oldest (the first key in insertion order) until under the bound.
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
      // Drop the lock for the evicted id too so it doesn't accumulate. KeyedMutex self-cleans an
      // idle key's tail on release, so there is no per-id lock object to pop here — the observable
      // no-unbounded-growth invariant the Python `self._locks.pop(evicted_id)` guarantees holds by
      // construction. (A fresh request for that id re-allocates a tail.)
    }
  }

  private checkNegativeCache(installationId: number): PermanentTokenError | null {
    const entry = this.negativeCache.get(installationId);
    if (entry === undefined) {
      return null;
    }
    if (this.clock.monotonic() < entry.expiresMonotonic) {
      return entry.error;
    }
    // Past TTL; drop and force a re-attempt.
    this.negativeCache.delete(installationId);
    return null;
  }
}
