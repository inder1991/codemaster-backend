/**
 * `LlmClientCache` — REAL per-pod client cache keyed on role (de-stub step 3).
 *
 * 1:1 TypeScript port of the frozen Python spine cache
 * `vendor/codemaster-py/codemaster/integrations/llm/client_cache.py::LlmClientCache`.
 *
 * This is the REAL cache — NO stub on the shipped path. It holds at most two live {@link LlmClient}s
 * (primary + secondary), each built over the REAL {@link AnthropicBedrockSdkAdapter}
 * (`@anthropic-ai/bedrock-sdk`). Freshness is a PK-scan against `core.llm_provider_settings` on every
 * call (sub-ms; no Vault decrypt); the Vault decrypt happens only on a true cache miss (the rotation
 * fingerprint changed or the slot is absent). Per the frozen spec §3.2 + §4.1.
 *
 * ── for_role fingerprint logic ──
 *   1. `read_rotation_fingerprint()` PK-scans ALL platform rows → `[(role, last_rotated_at), …]` (≤2).
 *   2. The scan is sorted into a stable fingerprint so DB row order doesn't matter.
 *   3. Fast path — cache hit: the role's cached fingerprint equals the current one → return the cached
 *      client immediately, no decrypt.
 *   4. Slow path — under a single `asyncio.Lock` analogue: double-check (a concurrent miss may have
 *      already repopulated the slot), then `read_decrypted_settings(role)` (the ONLY decrypt site),
 *      build the SDK adapter + the client, cache `(client, fingerprint)`, return.
 *
 * A single lock serializes reconstruction across BOTH roles (the sub-ms PK scan + per-decrypt cost
 * makes finer-grained locking unnecessary) — faithful to the Python's single `asyncio.Lock`. (This is
 * deliberately DIFFERENT from {@link LlmCredentialsProvider}'s per-role locks: the provider's failover
 * design needs per-role isolation; the client cache's coarse single lock matches the Python and the
 * reconstruction is rare.)
 *
 * ── Factories (the de-stub wiring) ──
 *   - `sdkFactory(provider, credentialsProvider)` → a {@link BedrockSdk}-shaped object. The default
 *     ({@link defaultSdkFactory}) builds the REAL {@link AnthropicBedrockSdkAdapter} (which satisfies
 *     the {@link LlmSdk} Protocol {@link LlmClient} consumes). `provider` is the provider STRING from
 *     the settings row (`row.provider`, e.g. `"bedrock"`); today only Bedrock is wired, so it is
 *     accepted-and-ignored — a future second provider branches on it here.
 *   - `clientFactory(sdk)` → an {@link LlmClient}. The default ({@link defaultClientFactory}) builds the
 *     REAL `LlmClient` wired with the REAL, ALWAYS-ON production collaborators — the
 *     {@link PostgresCostCapEnforcer} (atomic optimistic-reservation cost gate, ADR-0062 single-pool
 *     Kysely), the {@link BlobStorePostgresAdapter} (zstd-compressed payload archive into
 *     `telemetry.llm_payloads`), and the {@link PostgresLlmCallsTelemetryWriter} (one `telemetry.llm_calls`
 *     row per invocation). All three are built from `CODEMASTER_PG_CORE_DSN` + the shared {@link WallClock}
 *     and memoized once per process ({@link sharedClientCollaborators}) so every role's client shares the
 *     same singletons — exactly the Python `_client_factory` closure that captures the spine's shared
 *     `cost_cap` / `blob_store` / `session_factory` / `clock`. After this de-stub step the
 *     production `forRole` path is FULLY real: there is NO allow-all / in-memory faking stub on it.
 *     (The cassette / unit tests build their own `LlmClient` with the in-memory test doubles — those
 *     never flow through `defaultClientFactory`.)
 *
 * ── ADR-0061 D2 (shutdown teardown) ──
 * {@link LlmClientCache.aclose} closes every cached client's SDK pool under the same lock `for_role`
 * uses, then empties the cache — the httpx/undici pools are torn down on the worker's own loop at
 * shutdown rather than reclaimed by GC on the workflow sandbox loop (the ADR-0061 crash class).
 */

import { type Clock, WallClock } from "#platform/clock.js";

import { BlobStorePostgresAdapter } from "#backend/adapters/blobstore_postgres.js";
import { PostgresCostCapEnforcer } from "#backend/cost/postgres_enforcer.js";
import { KeyedMutex } from "#backend/integrations/github/installation_token.js";
import { AnthropicBedrockSdkAdapter } from "#backend/integrations/llm/bedrock_sdk_adapter.js";
import {
  type BlobStore,
  type LlmCallsTelemetryWriter,
  type LlmSdk,
  LlmClient,
  PostgresLlmCallsTelemetryWriter,
} from "#backend/integrations/llm/client.js";
import { type LlmCredentialsProvider } from "#backend/integrations/llm/credentials_provider.js";
import {
  type LangfuseExporterPort,
  LangfuseExporter,
} from "#backend/observability/langfuse_exporter.js";
import { LlmRoleNotConfiguredError } from "#backend/integrations/llm/errors.js";
import {
  type LlmProviderRole,
  type LlmProviderSettings,
  type RotationFingerprintEntry,
} from "#backend/integrations/llm/llm_provider_settings_repo.js";

import type { CostCapEnforcer } from "#backend/cost/enforcer.js";

// ─── The repo slice the cache depends on (the two reads it uses) ────────────────────────────────

/**
 * Persistence surface the cache needs — the two reads named by the de-stub task. A structural subset
 * of `PostgresLlmProviderSettingsRepo` so the cache depends only on the freshness probe + the decrypt,
 * not the whole adapter. In production this is the REAL `PostgresLlmProviderSettingsRepo`; in tests a
 * stub satisfying this shape.
 */
export type LlmClientCacheRepoPort = {
  /** PK-scan all platform rows → `[(role, lastRotatedAt), …]` (≤2). The freshness signal; no decrypt. */
  readRotationFingerprint(): Promise<Array<RotationFingerprintEntry>>;
  /** Decrypt the settings row for `role`, or `null` when absent/disabled (fail-closed). The ONLY decrypt site. */
  readDecryptedSettings(role: LlmProviderRole): Promise<LlmProviderSettings | null>;
};

// ─── Factory seams ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds the per-role SDK from the settings-row provider string + the shared credentials provider. The
 * default ({@link defaultSdkFactory}) constructs the REAL {@link AnthropicBedrockSdkAdapter}. Async so a
 * future provider whose SDK construction is async fits without a signature change (today the adapter
 * construction is sync, wrapped in a resolved promise).
 */
export type SdkFactory = (args: {
  provider: string;
  credentialsProvider: LlmCredentialsProvider;
}) => LlmSdk;

/** Builds an {@link LlmClient} over a constructed SDK. The default builds the REAL `LlmClient`. */
export type ClientFactory = (args: { sdk: LlmSdk }) => LlmClient;

/**
 * Production default {@link SdkFactory}: the REAL {@link AnthropicBedrockSdkAdapter}.
 *
 * `provider` is accepted-and-ignored today (only Bedrock is wired); a future second provider branches
 * on it here. The adapter satisfies the {@link LlmSdk} Protocol — its `createMessage(...)` is exactly
 * the call surface {@link LlmClient} drives. The cast bridges the two structurally-identical shapes
 * (the adapter's `createMessage` accepts the same `{ model, messages, maxTokens, tools, role }`).
 */
export const defaultSdkFactory: SdkFactory = (args: {
  provider: string;
  credentialsProvider: LlmCredentialsProvider;
}): LlmSdk => {
  // The adapter's `createMessage({ model, messages, maxTokens, tools, role })` IS the `LlmSdk`
  // Protocol surface — the structural assignment below is the compiler-checked proof it satisfies it.
  const adapter: LlmSdk = new AnthropicBedrockSdkAdapter({ provider: args.credentialsProvider });
  return adapter;
};

/**
 * The REAL, ALWAYS-ON production collaborators an {@link LlmClient} needs beyond its SDK — the
 * Postgres-backed cost-cap, blob store, and `llm_calls` telemetry writer, the Langfuse trace exporter
 * (env-gated OFF until LANGFUSE_HOST / LANGFUSE_API_KEY are set), plus the shared clock. These are the
 * objects that REPLACE the (now-removed) in-client faking stubs on the production path.
 */
export type ClientCollaborators = {
  readonly costCap: CostCapEnforcer;
  readonly blobStore: BlobStore;
  readonly telemetry: LlmCallsTelemetryWriter;
  readonly langfuse: LangfuseExporterPort;
  readonly clock: Clock;
};

/**
 * Process-wide memo of the shared production collaborators, keyed on DSN. The Python `_client_factory`
 * captures the spine's shared `cost_cap` / `blob_store` / `session_factory` / `clock` singletons; here
 * we mirror that by building them ONCE per DSN and reusing them across every role's client. Each
 * Postgres collaborator is built via its `fromDsn` constructor, which reuses the ADR-0062 single pool —
 * so this memo is belt-and-suspenders against constructing redundant Kysely wrappers per `forRole`.
 */
const SHARED_COLLABORATORS = new Map<string, ClientCollaborators>();

/**
 * Read the canonical core-store DSN from the environment (static access — no dynamic indexing, so no
 * object-injection sink). Throws loudly when unset: the production client cannot wire a real cost-cap /
 * blob / telemetry without a database, and a silent fall-through to a faking stub is exactly the hazard
 * this de-stub step removes.
 */
function requireCoreDsn(): string {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; the production LlmClientCache cannot construct the " +
        "PostgresCostCapEnforcer / BlobStorePostgresAdapter / PostgresLlmCallsTelemetryWriter",
    );
  }
  return dsn;
}

/**
 * Build (or return the memoized) shared production collaborators for `dsn`. The cost-cap is constructed
 * with `readCapsFromDb: true` — the production posture the frozen Python worker wires (live caps from
 * `core.cost_cap_overrides` + `core.cost_cap_settings`, env-var seed as first-boot fallback).
 */
export function sharedClientCollaborators(dsn: string): ClientCollaborators {
  const existing = SHARED_COLLABORATORS.get(dsn);
  if (existing !== undefined) {
    return existing;
  }
  const clock = new WallClock();
  const collaborators: ClientCollaborators = {
    costCap: PostgresCostCapEnforcer.fromDsn({ dsn, clock, readCapsFromDb: true }),
    blobStore: BlobStorePostgresAdapter.fromDsn({ dsn, clock }),
    telemetry: PostgresLlmCallsTelemetryWriter.fromDsn({ dsn }),
    // Langfuse exporter from env — env-gated OFF (no POST) until LANGFUSE_HOST / LANGFUSE_API_KEY are
    // set. Shared per-process like the other collaborators (the Python `_client_factory` captures the
    // spine's shared exporter). NOT keyed on the DSN — the env config is process-global — but lives in
    // the per-DSN memo so every role's client shares the same exporter instance.
    langfuse: LangfuseExporter.fromEnv(),
    clock,
  };
  SHARED_COLLABORATORS.set(dsn, collaborators);
  return collaborators;
}

/**
 * Production default {@link ClientFactory}: the REAL `LlmClient` wired with the REAL, ALWAYS-ON
 * production collaborators — {@link PostgresCostCapEnforcer} + {@link BlobStorePostgresAdapter} +
 * {@link PostgresLlmCallsTelemetryWriter}, all built from `CODEMASTER_PG_CORE_DSN` + the shared
 * {@link WallClock} and memoized once per process. This is the FULLY-real `forRole` path: NO allow-all
 * cost-cap, NO in-memory blob store, NO faking stub of any kind flows through here. The cassette / unit
 * tests construct their own `LlmClient` with the in-memory test doubles and NEVER call this factory.
 */
export const defaultClientFactory: ClientFactory = (args: { sdk: LlmSdk }): LlmClient => {
  const { costCap, blobStore, telemetry, langfuse, clock } = sharedClientCollaborators(
    requireCoreDsn(),
  );
  return new LlmClient({ sdk: args.sdk, costCap, blobStore, telemetry, langfuse, clock });
};

// ─── Cache envelope ────────────────────────────────────────────────────────────────────────────

/**
 * Stable rotation fingerprint: a canonical string of the sorted `(role, lastRotatedAtEpochMs)` pairs.
 * Sorting makes the value order-independent regardless of DB row order (the Python
 * `tuple(sorted(fp_rows))`); the string carrier makes equality a plain `===` value comparison (not
 * reference identity) with no array-index access. Epoch ms (not the `Date` object) keeps it a value.
 */
type Fingerprint = string;

/** Per-role cache entry: the live client + the rotation fingerprint it was built under. */
type CacheEntry = {
  readonly client: LlmClient;
  readonly fingerprint: Fingerprint;
};

// ─── The cache ─────────────────────────────────────────────────────────────────────────────────

export type LlmClientCacheOptions = {
  readonly repo: LlmClientCacheRepoPort;
  readonly credentialsProvider: LlmCredentialsProvider;
  readonly sdkFactory?: SdkFactory;
  readonly clientFactory?: ClientFactory;
};

/**
 * Per-pod cache of {@link LlmClient}s keyed on role. At most two entries (primary + secondary); each
 * tracks its rotation fingerprint. Admin Save bumps `last_rotated_at` in `core.llm_provider_settings`,
 * and the next {@link LlmClientCache.forRole} call detects the change via the PK-scan and reconstructs.
 */
export class LlmClientCache {
  private readonly repo: LlmClientCacheRepoPort;
  private readonly credentialsProvider: LlmCredentialsProvider;
  private readonly sdkFactory: SdkFactory;
  private readonly clientFactory: ClientFactory;

  // 2-slot map: role -> (client, fingerprint). Natural cap; no LRU needed.
  private readonly cache = new Map<LlmProviderRole, CacheEntry>();

  // A single mutex serializes reconstruction across BOTH roles (the Python's single `asyncio.Lock`).
  // KeyedMutex with one fixed key is the single-lock analogue; REUSED from the github seam.
  private readonly lock = new KeyedMutex<"reconstruct">();

  public constructor(options: LlmClientCacheOptions) {
    this.repo = options.repo;
    this.credentialsProvider = options.credentialsProvider;
    this.sdkFactory = options.sdkFactory ?? defaultSdkFactory;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  /**
   * Return a live {@link LlmClient} for `role`.
   *
   * Always performs the PK-scan first; the Vault decrypt happens only on a cache miss.
   *
   * @throws {@link LlmRoleNotConfiguredError} no row exists for `role` (operator hasn't seeded via
   *   `/admin/llm`) OR the row is disabled (the repo folds disabled into `null`, fail-closed).
   */
  public async forRole(role: LlmProviderRole): Promise<LlmClient> {
    const fpRows = await this.repo.readRotationFingerprint();
    const currentFp = toFingerprint(fpRows);

    // Fast path: cache hit — fingerprint unchanged, return immediately.
    const cached = this.cache.get(role);
    if (cached !== undefined && fingerprintEqual(cached.fingerprint, currentFp)) {
      return cached.client;
    }

    // Slow path: acquire the lock before reconstructing.
    const release = await this.lock.acquire("reconstruct");
    try {
      // Double-check under the lock: a concurrent miss may have already populated the slot.
      const recheck = this.cache.get(role);
      if (recheck !== undefined && fingerprintEqual(recheck.fingerprint, currentFp)) {
        return recheck.client;
      }

      // Vault decrypt happens here — the only place in this module.
      const row = await this.repo.readDecryptedSettings(role);
      if (row === null) {
        throw new LlmRoleNotConfiguredError(
          `core.llm_provider_settings has no row for role=${role}; configure via /admin/llm`,
        );
      }

      const sdk = this.sdkFactory({
        provider: row.provider,
        credentialsProvider: this.credentialsProvider,
      });
      const client = this.clientFactory({ sdk });
      this.cache.set(role, { client, fingerprint: currentFp });
      return client;
    } finally {
      release();
    }
  }

  /**
   * Close every cached client's SDK pool and empty the cache (ADR-0061 D2).
   *
   * Called once at worker shutdown. Holds the same lock {@link forRole} uses so a concurrent
   * reconstruction can't repopulate a slot mid-teardown. Duck-typed: a client without `aclose()` is
   * simply dropped. After this the cache is empty; a later {@link forRole} would transparently rebuild,
   * so callers must treat the cache as dead post-shutdown.
   */
  public async aclose(): Promise<void> {
    const release = await this.lock.acquire("reconstruct");
    try {
      for (const entry of this.cache.values()) {
        // Duck-typed teardown (the Python `getattr(client, "aclose", None)`): the current pure-transform
        // `LlmClient` exposes no `aclose`, but the NEXT workflow may wire one through to the underlying
        // SDK adapter's pool teardown. Narrow via `unknown` so this calls it iff present at runtime.
        const client = entry.client as unknown as { aclose?: () => Promise<void> };
        if (typeof client.aclose === "function") {
          await client.aclose();
        }
      }
      this.cache.clear();
    } finally {
      release();
    }
  }
}

// ─── Fingerprint helpers ─────────────────────────────────────────────────────────────────────────

/** Build the stable sorted `(role, epochMs)` fingerprint from a PK-scan (the Python `tuple(sorted(...))`). */
function toFingerprint(rows: Array<RotationFingerprintEntry>): Fingerprint {
  // Each pair -> "role<NUL>epochMs"; sort the pair strings into a total order (lexical, which is
  // order-independent across DB row orderings); join with an RS record separator. The NUL field
  // separator + RS record separator (control chars built via String.fromCharCode, never a literal
  // control byte in source) cannot collide with a role value (`primary`/`secondary`) or a base-10
  // epoch-ms integer, so two distinct fingerprints never serialize to the same carrier string.
  const FIELD_SEP = String.fromCharCode(0);
  const RECORD_SEP = String.fromCharCode(30);
  return rows
    .map((r) => `${r.role}${FIELD_SEP}${r.lastRotatedAt.getTime()}`)
    .sort()
    .join(RECORD_SEP);
}

function fingerprintEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a === b;
}
