/**
 * Unit tests for the TS {@link GitHubAppTokenProvider} — the 1:1 port of
 * `codemaster/integrations/github/token_provider.py` (frozen Python, Sprint 15 / S15.X-token-provider).
 *
 * NO DB, NO network. Time is the injected {@link FakeClock}; the HTTP transport is a scripting stub
 * that queues responses/throws and COUNTS requests; Vault is the {@link InMemoryVault} test double;
 * the App private key is the same real RSA-2048 PEM the app_jwt parity test uses (so `signAppJwt`
 * actually signs rather than throwing malformed).
 *
 * OTel `github.token.mint` span emission is asserted via a hand-rolled recording TracerProvider
 * installed with `trace.setGlobalTracerProvider` (NO new deps — `@opentelemetry/api` is already a
 * dep); the previous provider is restored in `afterEach`.
 *
 * Coverage (mirrors the task brief 1:1):
 *   - constructor validation: appId<=0, refreshAtFraction out of [0.1,0.95], maxCacheEntries<1.
 *   - fromEnv: reads Vault; missing keys → PermanentTokenError; VaultPathNotFound propagates.
 *   - happy mint caches; second call is a cache HIT (request count stays 1, NO second span).
 *   - refresh-at-fraction boundary: just before 0.8*ttl → HIT; at/after → re-mint.
 *   - LRU eviction (maxCacheEntries=2, 3 ids → oldest evicted, its re-request re-mints).
 *   - negative cache: 404 → PermanentTokenError; immediate retry returns SAME error w/o new HTTP;
 *     advance monotonic past 60s → re-attempts.
 *   - 401-then-200 (re-signs once, request count 2); 401-twice → PermanentTokenError.
 *   - 403/404 → PermanentTokenError.
 *   - 5xx x4 → TransientTokenError with recordedSleeps [0.5, 1.0, 2.0].
 *   - network-throw then 200 → retried.
 *   - malformed 2xx body → PermanentTokenError.
 *   - single-flight: 10 concurrent getToken (same id, slow stub) → 1 HTTP + 1 span; two ids → 2.
 *   - span github.token.mint emitted on mint with the `outcome` attribute.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { trace, type TracerProvider } from "@opentelemetry/api";

import { FakeClock } from "#platform/clock.js";

import { InMemoryVault, VaultPathNotFound } from "#backend/adapters/vault_port.js";
import {
  type GitHubHttpClient,
  type GitHubHttpResponse,
} from "#backend/integrations/github/api_client.js";
import {
  GitHubAppTokenProvider,
  NEGATIVE_CACHE_TTL_SECONDS,
  PermanentTokenError,
  TransientTokenError,
  VAULT_KV_PATH,
} from "#backend/integrations/github/token_provider.js";

// ─── Shared fixtures ───────────────────────────────────────────────────────────────────────────

// The same real RSA-2048 PEM the app_jwt parity test uses, so `signAppJwt` actually signs.
const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/integrations/github -> test/parity/fixtures
const TEST_PEM = readFileSync(
  join(HERE, "..", "..", "..", "parity", "fixtures", "jwt_test_rsa.pem"),
  "utf8",
);

const APP_ID = 123456;
const INSTALLATION_ID = 999;
// A clock instant; the cassette token expires one hour later.
const NOW = new Date("2026-05-02T12:00:00.000Z");

/** A successful 201 token-exchange body (GitHub's `Z`-suffixed expiry, one hour out). */
function tokenBody(token = "ghs_minted", expiresAt = "2026-05-02T13:00:00Z"): string {
  return JSON.stringify({ token, expires_at: expiresAt });
}

/** A scripted HTTP step: either a canned response or a throw (the network-error analogue). */
type Step =
  | { kind: "resp"; status: number; bodyText: string | null }
  | { kind: "throw"; error: Error };

/**
 * A scripting + counting HTTP stub. `steps` is consumed FIFO; once exhausted the last step repeats
 * (so e.g. a single 201 step serves every request). `slow` holds each response open until the test
 * releases it — the strongest probe of single-flight coalescence (a race shows up as >1 request).
 */
function scriptedHttp(
  steps: ReadonlyArray<Step>,
  options?: { slow?: boolean },
): {
  http: GitHubHttpClient;
  count: () => number;
  release: () => void;
  pendingCount: () => number;
} {
  let count = 0;
  let cursor = 0;
  const gates: Array<() => void> = [];
  const http: GitHubHttpClient = {
    async request(): Promise<GitHubHttpResponse> {
      count += 1;
      const step = steps[Math.min(cursor, steps.length - 1)] ?? steps[steps.length - 1]!;
      cursor += 1;
      if (options?.slow === true) {
        await new Promise<void>((resolve) => gates.push(resolve));
      } else {
        await Promise.resolve();
      }
      if (step.kind === "throw") {
        throw step.error;
      }
      return { status: step.status, headers: {}, body_text: step.bodyText };
    },
  };
  return {
    http,
    count: () => count,
    release: () => {
      for (const g of gates.splice(0)) g();
    },
    pendingCount: () => gates.length,
  };
}

// ─── OTel recording TracerProvider (no new deps) ────────────────────────────────────────────────

type RecordedSpan = { name: string; attributes: Record<string, unknown> };

/** A minimal recording TracerProvider: captures span name + the attributes set on it. */
function recordingTracerProvider(): { provider: TracerProvider; spans: Array<RecordedSpan> } {
  const spans: Array<RecordedSpan> = [];
  const tracer = {
    // The startActiveSpan overload the provider code uses: (name, fn).
    startActiveSpan<T>(name: string, fn: (span: RecordingSpan) => T): T {
      const rec: RecordedSpan = { name, attributes: {} };
      spans.push(rec);
      const span: RecordingSpan = {
        setAttribute(key: string, value: unknown): RecordingSpan {
          rec.attributes[key] = value;
          return span;
        },
        end(): void {
          /* no-op recorder */
        },
      };
      return fn(span);
    },
  };
  const provider = {
    getTracer(): typeof tracer {
      return tracer;
    },
  } as unknown as TracerProvider;
  return { provider, spans };
}

type RecordingSpan = {
  setAttribute(key: string, value: unknown): RecordingSpan;
  end(): void;
};

// The previous global provider (restored after each test). `setGlobalTracerProvider` cannot be
// re-set once installed, so we install our recorder once at module scope and clear its buffer per
// test — the simplest deterministic approach that survives OTel's no-double-register guard.
const RECORDING = recordingTracerProvider();
trace.setGlobalTracerProvider(RECORDING.provider);

beforeEach(() => {
  RECORDING.spans.length = 0;
});

afterEach(() => {
  RECORDING.spans.length = 0;
});

/** Construct a provider over a scripted HTTP stub with the shared key/clock. */
function makeProvider(
  http: GitHubHttpClient,
  opts?: { clock?: FakeClock; maxCacheEntries?: number; refreshAtFraction?: number },
): { provider: GitHubAppTokenProvider; clock: FakeClock } {
  const clock = opts?.clock ?? new FakeClock({ now: NOW });
  const provider = new GitHubAppTokenProvider({
    appId: APP_ID,
    privateKeyPem: TEST_PEM,
    http,
    clock,
    ...(opts?.maxCacheEntries !== undefined ? { maxCacheEntries: opts.maxCacheEntries } : {}),
    ...(opts?.refreshAtFraction !== undefined ? { refreshAtFraction: opts.refreshAtFraction } : {}),
  });
  return { provider, clock };
}

// ─── Constructor validation ──────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider constructor validation", () => {
  const { http } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
  const clock = new FakeClock({ now: NOW });

  it("rejects appId <= 0", () => {
    expect(
      () => new GitHubAppTokenProvider({ appId: 0, privateKeyPem: TEST_PEM, http, clock }),
    ).toThrow(/app_id must be >= 1, got 0/);
    expect(
      () => new GitHubAppTokenProvider({ appId: -5, privateKeyPem: TEST_PEM, http, clock }),
    ).toThrow(/app_id must be >= 1, got -5/);
  });

  it("rejects refreshAtFraction outside [0.1, 0.95]", () => {
    expect(
      () =>
        new GitHubAppTokenProvider({
          appId: APP_ID,
          privateKeyPem: TEST_PEM,
          http,
          clock,
          refreshAtFraction: 0.05,
        }),
    ).toThrow(/refresh_at_fraction must be in \[0.1, 0.95\], got 0.05/);
    expect(
      () =>
        new GitHubAppTokenProvider({
          appId: APP_ID,
          privateKeyPem: TEST_PEM,
          http,
          clock,
          refreshAtFraction: 0.99,
        }),
    ).toThrow(/refresh_at_fraction must be in/);
  });

  it("accepts the inclusive refreshAtFraction bounds 0.1 and 0.95", () => {
    expect(
      () =>
        new GitHubAppTokenProvider({
          appId: APP_ID,
          privateKeyPem: TEST_PEM,
          http,
          clock,
          refreshAtFraction: 0.1,
        }),
    ).not.toThrow();
    expect(
      () =>
        new GitHubAppTokenProvider({
          appId: APP_ID,
          privateKeyPem: TEST_PEM,
          http,
          clock,
          refreshAtFraction: 0.95,
        }),
    ).not.toThrow();
  });

  it("rejects maxCacheEntries < 1", () => {
    expect(
      () =>
        new GitHubAppTokenProvider({
          appId: APP_ID,
          privateKeyPem: TEST_PEM,
          http,
          clock,
          maxCacheEntries: 0,
        }),
    ).toThrow(/max_cache_entries must be >= 1, got 0/);
  });

  it("rejects installationId <= 0 on getToken", async () => {
    const { provider } = makeProvider(http);
    await expect(provider.getToken(0)).rejects.toThrow(/installation_id must be >= 1, got 0/);
    await expect(provider.getToken(-1)).rejects.toThrow(/installation_id must be >= 1, got -1/);
  });
});

// ─── fromEnv ─────────────────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider.fromEnv", () => {
  it("reads app_id + private_key_pem from Vault and constructs a working provider", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({
      path: VAULT_KV_PATH,
      data: { app_id: String(APP_ID), private_key_pem: TEST_PEM },
    });
    const { http, count } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const clock = new FakeClock({ now: NOW });

    const provider = await GitHubAppTokenProvider.fromEnv({ vault, http, clock });
    const token = await provider.getToken(INSTALLATION_ID);
    expect(token).toBe("ghs_minted");
    expect(count()).toBe(1);
  });

  it("throws PermanentTokenError when the Vault secret is missing required keys", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: VAULT_KV_PATH, data: { app_id: String(APP_ID) } });
    const { http } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const clock = new FakeClock({ now: NOW });

    await expect(GitHubAppTokenProvider.fromEnv({ vault, http, clock })).rejects.toBeInstanceOf(
      PermanentTokenError,
    );
    await expect(
      GitHubAppTokenProvider.fromEnv({ vault, http, clock }),
    ).rejects.toThrow(/missing required keys.*expected: app_id, private_key_pem.*got: \['app_id'\]/s);
  });

  it("propagates VaultPathNotFound (fail-closed at deployment) — does NOT catch", async () => {
    const vault = new InMemoryVault(); // nothing seeded
    const { http } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const clock = new FakeClock({ now: NOW });

    await expect(GitHubAppTokenProvider.fromEnv({ vault, http, clock })).rejects.toBeInstanceOf(
      VaultPathNotFound,
    );
  });

  it("rejects a non-integer app_id (Python int() parity — fail closed, never coerce a garbage App id)", async () => {
    // Parity: Python does `int(secret["app_id"])`, which raises on a malformed string. `Number(...)`
    // would silently coerce "0x10"->16, "12.5"->12.5, "1e3"->1000, "abc"->NaN (and NaN<=0 is false,
    // so the constructor's `>= 1` guard would NOT catch it -> a NaN App identity in the JWT `iss`).
    // A malformed Vault secret MUST fail the pod closed, not mint tokens under the wrong App id.
    const clock = new FakeClock({ now: NOW });
    const { http } = scriptedHttp([]);
    for (const bad of ["12.5", "0x10", "abc", "1e3", "12abc", " "]) {
      const vault = new InMemoryVault();
      await vault.kvWrite({ path: VAULT_KV_PATH, data: { app_id: bad, private_key_pem: TEST_PEM } });
      await expect(
        GitHubAppTokenProvider.fromEnv({ vault, http, clock }),
        `app_id=${JSON.stringify(bad)} must fail closed`,
      ).rejects.toThrow();
    }
  });

  it("accepts an integer app_id with surrounding whitespace (Python int() strips)", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({
      path: VAULT_KV_PATH,
      data: { app_id: `  ${String(APP_ID)}  `, private_key_pem: TEST_PEM },
    });
    const { http, count } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const clock = new FakeClock({ now: NOW });

    const provider = await GitHubAppTokenProvider.fromEnv({ vault, http, clock });
    expect(await provider.getToken(INSTALLATION_ID)).toBe("ghs_minted");
    expect(count()).toBe(1);
  });
});

// ─── Happy path + caching + spans ──────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider happy mint + cache", () => {
  it("mints on the first call, caches, and the second call is a HIT (1 request, 1 span)", async () => {
    const { http, count } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const { provider } = makeProvider(http);

    const t1 = await provider.getToken(INSTALLATION_ID);
    const t2 = await provider.getToken(INSTALLATION_ID);

    expect(t1).toBe("ghs_minted");
    expect(t2).toBe("ghs_minted");
    // Cache HIT skips HTTP + skips OTel emission.
    expect(count()).toBe(1);
    expect(RECORDING.spans).toHaveLength(1);
    expect(RECORDING.spans[0]!.name).toBe("github.token.mint");
    expect(RECORDING.spans[0]!.attributes).toMatchObject({
      installation_id: INSTALLATION_ID,
      cache_hit: false,
      outcome: "success",
    });
  });

  it("re-mints once the token is at/after the refresh-at-fraction boundary", async () => {
    // ttl = 3600s; refreshAtFraction default 0.8 → boundary at 2880s elapsed.
    const { http, count } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const { provider, clock } = makeProvider(http);

    await provider.getToken(INSTALLATION_ID); // mint @ t=0
    expect(count()).toBe(1);

    // Just before the boundary → HIT.
    clock.advance({ seconds: 2879 });
    await provider.getToken(INSTALLATION_ID);
    expect(count()).toBe(1);

    // At the boundary (elapsed >= ttl*fraction) → re-mint.
    clock.advance({ seconds: 1 }); // 2880s total
    await provider.getToken(INSTALLATION_ID);
    expect(count()).toBe(2);
    // Two actual mints → two spans.
    expect(RECORDING.spans).toHaveLength(2);
  });
});

// ─── LRU eviction ────────────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider LRU eviction", () => {
  it("evicts the oldest entry past maxCacheEntries; the evicted id re-mints on next request", async () => {
    const { http, count } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const { provider } = makeProvider(http, { maxCacheEntries: 2 });

    await provider.getToken(1); // cache: [1]
    await provider.getToken(2); // cache: [1, 2]
    await provider.getToken(3); // cache: [2, 3]  (1 evicted)
    expect(count()).toBe(3);

    // 2 and 3 are still cached → HIT (no new request).
    await provider.getToken(2);
    await provider.getToken(3);
    expect(count()).toBe(3);

    // 1 was evicted → re-mints.
    await provider.getToken(1);
    expect(count()).toBe(4);
  });
});

// ─── Negative cache ──────────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider negative cache", () => {
  it("caches a 404 PermanentTokenError; immediate retry returns the SAME error WITHOUT new HTTP", async () => {
    const { http, count } = scriptedHttp([{ kind: "resp", status: 404, bodyText: null }]);
    const { provider } = makeProvider(http);

    const err1 = await provider.getToken(INSTALLATION_ID).catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(PermanentTokenError);
    expect(count()).toBe(1);

    // Immediate retry: negative-cache fast-path throws WITHOUT a new HTTP request and WITHOUT a span.
    const err2 = await provider.getToken(INSTALLATION_ID).catch((e: unknown) => e);
    expect(err2).toBe(err1); // the SAME cached error instance
    expect(count()).toBe(1);
    // Only the original mint emitted a span (outcome=permanent); the cached re-throw did NOT.
    expect(RECORDING.spans).toHaveLength(1);
    expect(RECORDING.spans[0]!.attributes["outcome"]).toBe("permanent");
  });

  it("re-attempts once the negative-cache monotonic TTL (60s) has elapsed", async () => {
    // First a 404, then (after TTL) a 201.
    const { http, count } = scriptedHttp([
      { kind: "resp", status: 404, bodyText: null },
      { kind: "resp", status: 201, bodyText: tokenBody() },
    ]);
    const { provider, clock } = makeProvider(http);

    await expect(provider.getToken(INSTALLATION_ID)).rejects.toBeInstanceOf(PermanentTokenError);
    expect(count()).toBe(1);

    // Still inside the TTL → no new HTTP.
    clock.advance({ seconds: NEGATIVE_CACHE_TTL_SECONDS - 1 });
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toBeInstanceOf(PermanentTokenError);
    expect(count()).toBe(1);

    // Past the TTL → re-attempts (the second scripted step, a 201).
    clock.advance({ seconds: 2 });
    const token = await provider.getToken(INSTALLATION_ID);
    expect(token).toBe("ghs_minted");
    expect(count()).toBe(2);
  });
});

// ─── 401 handling ────────────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider 401 handling", () => {
  it("401-then-200: re-signs once and succeeds (request count 2)", async () => {
    const { http, count } = scriptedHttp([
      { kind: "resp", status: 401, bodyText: null },
      { kind: "resp", status: 201, bodyText: tokenBody() },
    ]);
    const { provider } = makeProvider(http);

    const token = await provider.getToken(INSTALLATION_ID);
    expect(token).toBe("ghs_minted");
    expect(count()).toBe(2);
  });

  it("401-twice → PermanentTokenError", async () => {
    const { http, count } = scriptedHttp([{ kind: "resp", status: 401, bodyText: null }]);
    const { provider } = makeProvider(http);

    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(/401 twice/);
    expect(count()).toBe(2); // first 401 burns the latch, second 401 raises.
  });
});

// ─── 403 / 404 → permanent ─────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider 403/404 → PermanentTokenError", () => {
  it("403 → PermanentTokenError", async () => {
    const { http } = scriptedHttp([{ kind: "resp", status: 403, bodyText: null }]);
    const { provider } = makeProvider(http);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toBeInstanceOf(PermanentTokenError);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(/returned 403/);
  });

  it("404 → PermanentTokenError", async () => {
    const { http } = scriptedHttp([{ kind: "resp", status: 404, bodyText: null }]);
    const { provider } = makeProvider(http);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(/returned 404/);
  });

  it("other 4xx (e.g. 400) → PermanentTokenError", async () => {
    const { http } = scriptedHttp([{ kind: "resp", status: 400, bodyText: null }]);
    const { provider } = makeProvider(http);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(/400 on token exchange/);
  });
});

// ─── 5xx exhaustion + backoff parity ────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider 5xx retry + backoff", () => {
  it("5xx on all 4 attempts → TransientTokenError; recordedSleeps == [0.5, 1.0, 2.0]", async () => {
    const { http, count } = scriptedHttp([{ kind: "resp", status: 503, bodyText: null }]);
    const { provider, clock } = makeProvider(http);

    await expect(provider.getToken(INSTALLATION_ID)).rejects.toBeInstanceOf(TransientTokenError);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(/503 after 3 retries/);
    // 4 attempts (0..3); sleeps on 0,1,2 then RAISE on 3 (no sleep on the final).
    // (Two getToken calls above each ran the full loop → 4 requests each = 8.)
    expect(count()).toBe(8);
    // recordedSleeps from the FIRST run: [0.5, 1.0, 2.0]; the second run appends another triple.
    expect(clock.recordedSleeps().slice(0, 3)).toEqual([0.5, 1.0, 2.0]);
  });

  it("a 5xx then a 200 retries successfully", async () => {
    const { http, count } = scriptedHttp([
      { kind: "resp", status: 500, bodyText: null },
      { kind: "resp", status: 201, bodyText: tokenBody() },
    ]);
    const { provider, clock } = makeProvider(http);

    const token = await provider.getToken(INSTALLATION_ID);
    expect(token).toBe("ghs_minted");
    expect(count()).toBe(2);
    expect(clock.recordedSleeps()).toEqual([0.5]);
  });
});

// ─── Network throw (httpx.RequestError analogue) ────────────────────────────────────────────────

describe("GitHubAppTokenProvider network errors", () => {
  it("a thrown network error then a 200 is retried", async () => {
    const { http, count } = scriptedHttp([
      { kind: "throw", error: new Error("ECONNRESET") },
      { kind: "resp", status: 201, bodyText: tokenBody() },
    ]);
    const { provider, clock } = makeProvider(http);

    const token = await provider.getToken(INSTALLATION_ID);
    expect(token).toBe("ghs_minted");
    expect(count()).toBe(2);
    expect(clock.recordedSleeps()).toEqual([0.5]);
  });

  it("network errors on all 4 attempts → TransientTokenError", async () => {
    const { http, count } = scriptedHttp([{ kind: "throw", error: new Error("ECONNREFUSED") }]);
    const { provider, clock } = makeProvider(http);

    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(/network error after 3 retries/);
    expect(count()).toBe(4);
    expect(clock.recordedSleeps()).toEqual([0.5, 1.0, 2.0]);
  });
});

// ─── Malformed 2xx body ─────────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider malformed response", () => {
  it("a malformed 2xx body → PermanentTokenError", async () => {
    const { http } = scriptedHttp([
      { kind: "resp", status: 201, bodyText: '{"not_a_token": true}' },
    ]);
    const { provider } = makeProvider(http);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toThrow(
      /malformed token-exchange response/,
    );
  });

  it("non-JSON 2xx body → PermanentTokenError", async () => {
    const { http } = scriptedHttp([{ kind: "resp", status: 201, bodyText: "<<<not json>>>" }]);
    const { provider } = makeProvider(http);
    await expect(provider.getToken(INSTALLATION_ID)).rejects.toBeInstanceOf(PermanentTokenError);
  });
});

// ─── Single-flight coalescence ─────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider single-flight", () => {
  it("10 concurrent getToken for the SAME id → EXACTLY 1 HTTP request + 1 span", async () => {
    const { http, count, release, pendingCount } = scriptedHttp(
      [{ kind: "resp", status: 201, bodyText: tokenBody() }],
      { slow: true },
    );
    const { provider } = makeProvider(http);

    // Fire 10 concurrent requests; they all pile on the per-id lock before ANY exchange completes.
    const inflight = Array.from({ length: 10 }, () => provider.getToken(INSTALLATION_ID));
    // Let the microtask queue settle so the single holder has issued its (slow) request.
    await Promise.resolve();
    await Promise.resolve();
    // Exactly one request is in flight (the rest are blocked on the lock + double-check).
    expect(pendingCount()).toBe(1);

    release(); // settle the single open request
    const tokens = await Promise.all(inflight);

    expect(tokens.every((t) => t === "ghs_minted")).toBe(true);
    expect(count()).toBe(1);
    expect(RECORDING.spans).toHaveLength(1);
  });

  it("concurrent getToken for TWO different ids → 2 HTTP requests + 2 spans", async () => {
    const { http, count, release } = scriptedHttp(
      [{ kind: "resp", status: 201, bodyText: tokenBody() }],
      { slow: true },
    );
    const { provider } = makeProvider(http);

    const inflight = [provider.getToken(1), provider.getToken(2)];
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all(inflight);

    expect(count()).toBe(2);
    expect(RECORDING.spans).toHaveLength(2);
  });
});

// ─── aclose ─────────────────────────────────────────────────────────────────────────────────────

describe("GitHubAppTokenProvider.aclose", () => {
  it("calls http.aclose when present and is a no-op otherwise", async () => {
    let closed = 0;
    const closableHttp: GitHubHttpClient & { aclose(): Promise<void> } = {
      async request(): Promise<GitHubHttpResponse> {
        return { status: 201, headers: {}, body_text: tokenBody() };
      },
      async aclose(): Promise<void> {
        closed += 1;
      },
    };
    const { provider } = makeProvider(closableHttp);
    await provider.aclose();
    await provider.aclose(); // idempotent
    expect(closed).toBe(2);

    // No-op when the http client has no aclose.
    const { http } = scriptedHttp([{ kind: "resp", status: 201, bodyText: tokenBody() }]);
    const { provider: plain } = makeProvider(http);
    await expect(plain.aclose()).resolves.toBeUndefined();
  });
});
