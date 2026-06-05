// Cassette replay seam — mirrors the Python tests/integration/test_bedrock_review_chunk_cassettes.py
// `_CassetteSdk` + `_CacheShim` + the InMemoryCostCapEnforcer / BlobStoreInMemoryAdapter wiring.
//
// This is the DUAL-RUN REPLAY SEAM: a cassette SDK stub that satisfies the LlmSdk Protocol by returning
// the recorded `response` dict (the same response the real anthropic SDK would have produced), plus an
// allow-all in-memory cost-cap, an in-memory blob store, and a CacheShim whose `forRole` returns a
// pre-built LlmClient — so `doReview` can run against a cassette with NO network, NO DB, NO real SDK.
//
// NO @anthropic-ai/* import — the SDK is the injected LlmSdk Protocol, and the cassette stub satisfies it.

import { WallClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";

import { type BlobStore, type LlmSdk, LlmClient } from "./client.js";

import type { BlobRef } from "#contracts/blob_ref.v1.js";

/** The parsed shape of a `bedrock/review_chunk/*.yaml` cassette. */
export type CassetteSpec = {
  readonly id: string;
  readonly description?: string;
  readonly response: Record<string, unknown>;
  readonly expected?: Record<string, unknown>;
};

/**
 * SDK stub that replays a single cassette `response` dict (mirrors the Python `_CassetteSdk`). The
 * call args (model / messages / max_tokens / tools / role) are ignored — the recorded response is
 * deterministic by construction, which is exactly what a cassette replay requires.
 */
export class CassetteSdk implements LlmSdk {
  private readonly response: Record<string, unknown>;

  public constructor(response: Record<string, unknown>) {
    this.response = response;
  }

  public async createMessage(): Promise<Record<string, unknown>> {
    return this.response;
  }
}

/**
 * In-memory blob store mirroring the Python `BlobStoreInMemoryAdapter`. Retains the bytes (keyed by
 * `installationId\0key`) so a test could assert on them; returns a well-formed BlobRef.
 */
export class InMemoryBlobStoreAdapter implements BlobStore {
  private readonly clock = new WallClock();
  private readonly store = new Map<string, { body: Uint8Array; contentType: string }>();

  public async put(args: {
    installationId: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<BlobRef> {
    this.store.set(`${args.installationId}\0${args.key}`, {
      body: args.body,
      contentType: args.contentType,
    });
    return {
      schema_version: 1,
      installation_id: args.installationId,
      key: args.key,
      byte_size: args.body.length,
      content_type: args.contentType,
      created_at: this.clock.now().toISOString(),
    };
  }
}

/**
 * Minimal LlmClientCache-compatible shim (mirrors the Python `_CacheShim`): `forRole` returns the
 * pre-built client regardless of role. `doReview` calls `cache.forRole("primary")`.
 */
export type LlmClientCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/** Build a CacheShim whose `forRole` always yields `client`. */
export function cacheShim(client: LlmClient): LlmClientCacheLike {
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

/**
 * Assemble the full cassette replay wiring from a parsed cassette spec: a CassetteSdk over its
 * `response`, an allow-all InMemoryCostCapEnforcer, an in-memory blob store, and a CacheShim — exactly
 * the collaborators the Python cassette test wires. Returns the cache the activity consumes.
 */
export function cassetteCache(spec: CassetteSpec): LlmClientCacheLike {
  const client = new LlmClient({
    sdk: new CassetteSdk(spec.response),
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
  });
  return cacheShim(client);
}
