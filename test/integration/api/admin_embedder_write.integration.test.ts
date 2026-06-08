/**
 * Integration tests for the Batch-4 embedder WRITE lifecycle endpoints against the DISPOSABLE Postgres
 * (localhost:5439 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 * The embedder lifecycle is PLATFORM-WIDE singleton state (core.embedder_runtime_state) + a global
 * generation sequence (core.embedding_generations). These tests seed their own fixtures and reset the
 * shared singleton in beforeEach, so they are robust under pytest-randomly-style shuffle ordering.
 *
 * Temporal dispatch + signal are asserted against a RecordingTemporalClient (inner.calls / inner.signals);
 * audit events are asserted against a recording audit emitter.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { Role } from "#backend/api/auth/roles.js";
import { makeAdminTemporalPort } from "#backend/api/admin/_admin_temporal_port.js";
import {
  RecordingTemporalClient,
  type StartWorkflowCall,
} from "#backend/adapters/temporal_port.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INSTALL_ID = "00000000-0000-0000-0000-000000000001";
const ACTOR_USER = "00000000-0000-0000-0000-0000000000aa";

// The migration-seed singleton points at gen 1 (active). Restore it after every test so a left-over
// pending pointer or a flipped retrieval_mode never leaks into the next test.
const SEED_ACTIVE_GENERATION = 1;
const SEED_ACTIVE_MODEL = "qwen3-embed-0.6b";

type AuditEvent = {
  actorUserId: string;
  installationId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
};

let pool: Pool;
let db: Kysely<unknown>;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
});

/** Reset the singleton to the migration-seed shape + drop any generations we created (gen_id > 1). */
async function resetEmbedderState(): Promise<void> {
  await sql`
    UPDATE core.embedder_runtime_state
       SET active_generation = ${SEED_ACTIVE_GENERATION},
           active_model_name = ${SEED_ACTIVE_MODEL},
           pending_generation = NULL,
           pending_model_name = NULL,
           retrieval_mode = 'fallback',
           updated_at = now(),
           updated_by_email = 'migration-seed'
     WHERE singleton = true
  `.execute(db);
  await sql`DELETE FROM core.chunk_embeddings WHERE generation_id > ${SEED_ACTIVE_GENERATION}`.execute(db);
  await sql`DELETE FROM core.embedding_generations WHERE generation_id > ${SEED_ACTIVE_GENERATION}`.execute(db);
  // Restore gen 1 to 'active' — the activate/rollback tests demote it to 'ready' (the singleton pointer was
  // already restored above, but the row's own state must match). active biconditional: activated_at NOT NULL
  // AND retired_at NULL.
  await sql`
    UPDATE core.embedding_generations
       SET state = 'active',
           activated_at = COALESCE(activated_at, now()),
           retired_at = NULL,
           retire_reason = NULL
     WHERE generation_id = ${SEED_ACTIVE_GENERATION}
  `.execute(db);
}

beforeEach(async () => {
  if (!INTEGRATION_DSN) return;
  await resetEmbedderState();
});

afterEach(async () => {
  if (!INTEGRATION_DSN) return;
  await resetEmbedderState();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: ACTOR_USER,
    email: "ops@example.com",
    role,
    auth_source: "local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INSTALL_ID,
  });
}

/** Build the app with the embedder write routes wired + recording temporal + recording audit. */
async function makeApp(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  inner: RecordingTemporalClient;
  audited: Array<AuditEvent>;
}> {
  const app = buildApp({});
  const inner = new RecordingTemporalClient();
  const audited: Array<AuditEvent> = [];
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    temporal: makeAdminTemporalPort(inner),
    audit: async (e) => {
      audited.push(e);
    },
  });
  await app.ready();
  return { app, inner, audited };
}

const owner = (): Record<string, string> => ({ [SESSION_COOKIE_NAME]: mintCookie("platform_owner") });

/** Insert a generation directly in `backfilling` state; returns its id. */
async function seedBackfilling(modelName: string): Promise<number> {
  const r = await sql<{ generation_id: string | number }>`
    INSERT INTO core.embedding_generations (
      state, model_name, embedding_dimension, created_by_email,
      chunker_version, preprocessing_version, normalization_version, backfill_started_at
    ) VALUES ('backfilling', ${modelName}, 1024, 'ops@example.com', '1', '1', '1', now())
    RETURNING generation_id
  `.execute(db);
  return Number(r.rows[0]!.generation_id);
}

/** Insert a generation in `ready` state with `n` chunk_embeddings rows (so activate passes the ce>0 gate). */
async function seedReadyWithChunks(modelName: string, n = 1): Promise<number> {
  const r = await sql<{ generation_id: string | number }>`
    INSERT INTO core.embedding_generations (
      state, model_name, embedding_dimension, created_by_email,
      chunker_version, preprocessing_version, normalization_version,
      backfill_started_at, backfill_completed_at, validation_passed
    ) VALUES ('ready', ${modelName}, 1024, 'ops@example.com', '1', '1', '1', now(), now(), true)
    RETURNING generation_id
  `.execute(db);
  const genId = Number(r.rows[0]!.generation_id);
  const zeroVec = `[${Array(1024).fill(0).join(",")}]`;
  for (let i = 0; i < n; i += 1) {
    // chunk_embeddings is keyed (chunk_table, chunk_id, generation_id); a random chunk_id is fine for the
    // count gate (we don't join back to a real chunk row here).
    await sql`
      INSERT INTO core.chunk_embeddings (chunk_table, chunk_id, generation_id, embedding_model_name, embedding, content_sha256)
      VALUES ('knowledge_chunks', gen_random_uuid(), ${genId}, ${modelName}, ${zeroVec}::vector, ${`sha-${genId}-${i}`})
    `.execute(db);
  }
  return genId;
}

/** Insert a generation in `ready` state with validation_passed=false (activate must reject it). */
async function seedReadyFailedValidation(modelName: string): Promise<number> {
  const r = await sql<{ generation_id: string | number }>`
    INSERT INTO core.embedding_generations (
      state, model_name, embedding_dimension, created_by_email,
      chunker_version, preprocessing_version, normalization_version,
      backfill_started_at, backfill_completed_at, validation_passed
    ) VALUES ('ready', ${modelName}, 1024, 'ops@example.com', '1', '1', '1', now(), now(), false)
    RETURNING generation_id
  `.execute(db);
  return Number(r.rows[0]!.generation_id);
}

/** Insert a generation in `retired` state (retire_reason='demoted') with `n` chunk_embeddings rows, NOT
 *  GC'd — the rollback path target. */
async function seedRetiredWithChunks(modelName: string, n = 1): Promise<number> {
  const r = await sql<{ generation_id: string | number }>`
    INSERT INTO core.embedding_generations (
      state, model_name, embedding_dimension, created_by_email,
      chunker_version, preprocessing_version, normalization_version,
      backfill_started_at, backfill_completed_at, validation_passed, retired_at, retire_reason
    ) VALUES ('retired', ${modelName}, 1024, 'ops@example.com', '1', '1', '1', now(), now(), true, now(), 'demoted')
    RETURNING generation_id
  `.execute(db);
  const genId = Number(r.rows[0]!.generation_id);
  const zeroVec = `[${Array(1024).fill(0).join(",")}]`;
  for (let i = 0; i < n; i += 1) {
    await sql`
      INSERT INTO core.chunk_embeddings (chunk_table, chunk_id, generation_id, embedding_model_name, embedding, content_sha256)
      VALUES ('knowledge_chunks', gen_random_uuid(), ${genId}, ${modelName}, ${zeroVec}::vector, ${`sha-r-${genId}-${i}`})
    `.execute(db);
  }
  return genId;
}

/** Seed one canonical confluence chunk (no FK to repositories) with NO chunk_embeddings row under the
 *  active generation — i.e. a coverage gap. Returns the chunk_id. Caller cleans up. */
async function seedConfluenceCoverageGap(): Promise<string> {
  const r = await sql<{ chunk_id: string }>`
    INSERT INTO core.confluence_chunks (
      chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
      redaction_applied, ingested_at, token_count, labels, quarantined, quarantine_reasons,
      page_status, last_modified_at, content_sha256
    ) VALUES (
      gen_random_uuid(), 'BATCH4', 'page-1', 'Batch 4 gap page', 1, 0, 'gap body',
      false, now(), 3, ARRAY[]::text[], false, ARRAY[]::text[],
      'active', now(), 'sha-conf-gap'
    )
    RETURNING chunk_id
  `.execute(db);
  return String(r.rows[0]!.chunk_id);
}

describeDb("embedder write lifecycle (disposable :5439)", () => {
  it("POST /reembed/start: inserts backfilling generation, sets pending, returns EmbeddingGenerationV1", async () => {
    const { app, inner, audited } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner(),
      payload: {
        schema_version: 1,
        target_model_name: "test-model",
        generation_label: "batch-4-test",
        generation_reason: "manual",
        created_from_generation: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ generation_id: number; state: string; model_name: string }>();
    expect(body.generation_id).toBeGreaterThan(0);
    expect(body.state).toBe("backfilling");
    expect(body.model_name).toBe("test-model");

    // Workflow dispatched with REJECT_DUPLICATE + the right workflow id/type/queue.
    const call = inner.calls.find((c: StartWorkflowCall) => c.workflowType === "ReembedGenerationWorkflow");
    expect(call).toBeDefined();
    expect(call!.workflowId).toBe(`reembed-generation-${body.generation_id}`);
    expect(call!.taskQueue).toBe("embedder-maintenance");
    expect(call!.idReusePolicy).toBe("REJECT_DUPLICATE");

    // Audit emitted.
    expect(audited.some((a) => a.action === "embedder.generation.created")).toBe(true);
    await app.close();
  });

  it("POST /reembed/start: 409 PendingGenerationInFlightError", async () => {
    const { app } = await makeApp();
    const res1 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner(),
      payload: { schema_version: 1, target_model_name: "test-model-1", generation_label: null, generation_reason: null },
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner(),
      payload: { schema_version: 1, target_model_name: "test-model-2", generation_label: null, generation_reason: null },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json<{ detail: { error: string } }>().detail.error).toBe("pending_generation_in_flight");
    await app.close();
  });

  it("403 without platform_owner or super_admin", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
      payload: { schema_version: 1, target_model_name: "x", generation_label: null, generation_reason: null },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /embedder/retrieval-mode: 200 fallback (no gate) + audit, 200 generation_only with zero gap", async () => {
    const { app, audited } = await makeApp();

    const res1 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/retrieval-mode",
      cookies: owner(),
      payload: { schema_version: 1, mode: "fallback" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json<{ retrieval_mode: string }>().retrieval_mode).toBe("fallback");
    expect(audited.some((a) => a.action === "embedder.retrieval_mode.set")).toBe(true);

    // No canonical chunks seeded → total_missing=0 → the generation_only gate passes.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/retrieval-mode",
      cookies: owner(),
      payload: { schema_version: 1, mode: "generation_only" },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ retrieval_mode: string }>().retrieval_mode).toBe("generation_only");
    await app.close();
  });

  it("POST /embedder/retrieval-mode: 422 coverage_gap_present when a canonical chunk lacks an embedding", async () => {
    const { app } = await makeApp();
    const chunkId = await seedConfluenceCoverageGap();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/embedder/retrieval-mode",
        cookies: owner(),
        payload: { schema_version: 1, mode: "generation_only" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ detail: { error: string } }>().detail.error).toBe("coverage_gap_present");
    } finally {
      await sql`DELETE FROM core.confluence_chunks WHERE chunk_id = ${chunkId}`.execute(db);
      await app.close();
    }
  });

  it("POST /reembed/cancel: cancels pending backfill (signal recorded), 409 invalid_state_transition on re-cancel", async () => {
    const { app, inner, audited } = await makeApp();

    const startRes = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/start",
      cookies: owner(),
      payload: { schema_version: 1, target_model_name: "cancel-test", generation_label: null, generation_reason: null },
    });
    expect(startRes.statusCode).toBe(200);
    const genId = startRes.json<{ generation_id: number }>().generation_id;

    const cancelRes = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/cancel",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: genId },
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelled = cancelRes.json<{ state: string; retire_reason: string }>();
    expect(cancelled.state).toBe("retired");
    expect(cancelled.retire_reason).toBe("cancelled");

    // Best-effort cancel signal recorded against the reembed workflow id.
    expect(
      inner.signals.some(([wfId, signal]) => wfId === `reembed-generation-${genId}` && signal === "cancel"),
    ).toBe(true);
    expect(audited.some((a) => a.action === "embedder.generation.cancelled")).toBe(true);

    // Re-cancel (already retired) → 409.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/cancel",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: genId },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json<{ detail: { error: string } }>().detail.error).toBe("invalid_state_transition");
    await app.close();
  });

  it("POST /reembed/cancel: 404 generation_not_found", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/cancel",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: 9_999_999 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ detail: { error: string } }>().detail.error).toBe("generation_not_found");
    await app.close();
  });

  it("POST /reembed/validate: 200 pre-validation snapshot + ALLOW_DUPLICATE dispatch on a 'ready' gen", async () => {
    const { app, inner, audited } = await makeApp();
    const genId = await seedReadyWithChunks("validate-test", 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/validate",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: genId, sample_size: 100 },
    });
    expect(res.statusCode).toBe(200);
    // Pre-validation snapshot: validation_completed_at is still null (caller polls /reembed/status).
    expect(res.json<{ validation_completed_at: string | null }>().validation_completed_at).toBeNull();

    const call = inner.calls.find((c) => c.workflowType === "ValidateGenerationWorkflow");
    expect(call).toBeDefined();
    expect(call!.workflowId).toBe(`validate-generation-${genId}`);
    expect(call!.taskQueue).toBe("embedder-maintenance");
    expect(call!.idReusePolicy).toBe("ALLOW_DUPLICATE");
    expect(audited.some((a) => a.action === "embedder.generation.validated")).toBe(true);
    await app.close();
  });

  it("POST /reembed/validate: 409 invalid_state_transition on the active generation", async () => {
    const { app } = await makeApp();
    // Seed gen 1 is 'active' — validation is only permitted on 'backfilling' or 'ready'.
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/validate",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: SEED_ACTIVE_GENERATION, sample_size: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: { error: string } }>().detail.error).toBe("invalid_state_transition");
    await app.close();
  });

  it("POST /reembed/validate: 404 generation_not_found", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/validate",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: 9_999_999, sample_size: null },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ detail: { error: string } }>().detail.error).toBe("generation_not_found");
    await app.close();
  });

  it("POST /reembed/activate: promotes ready→active, demotes previous active to ready", async () => {
    const { app, audited } = await makeApp();
    const genId = await seedReadyWithChunks("activate-test", 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/activate",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: genId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ active_generation: number }>().active_generation).toBe(genId);
    expect(audited.some((a) => a.action === "embedder.generation.activated")).toBe(true);

    // Previous active (seed gen 1) was demoted to 'ready'.
    const demoted = await sql<{ state: string }>`
      SELECT state FROM core.embedding_generations WHERE generation_id = ${SEED_ACTIVE_GENERATION}
    `.execute(db);
    expect(demoted.rows[0]!.state).toBe("ready");
    await app.close();
  });

  it("POST /reembed/activate: 422 validation_not_passed", async () => {
    const { app } = await makeApp();
    const genId = await seedReadyFailedValidation("activate-fail");
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/activate",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: genId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: { error: string } }>().detail.error).toBe("validation_not_passed");
    await app.close();
  });

  it("POST /reembed/activate: 409 generation_data_collected when zero chunk_embeddings", async () => {
    const { app } = await makeApp();
    // seedReadyWithChunks(..., 0) → 'ready' with no chunk_embeddings rows.
    const genId = await seedReadyWithChunks("activate-empty", 0);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/activate",
      cookies: owner(),
      payload: { schema_version: 1, generation_id: genId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: { error: string } }>().detail.error).toBe("generation_data_collected");
    await app.close();
  });

  it("POST /reembed/rollback: alias of activate, allows from retired", async () => {
    const { app, audited } = await makeApp();
    const genId = await seedRetiredWithChunks("rollback-test", 1);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/embedder/reembed/rollback",
      cookies: owner(),
      payload: { schema_version: 1, target_generation_id: genId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ active_generation: number }>().active_generation).toBe(genId);
    expect(audited.some((a) => a.action === "embedder.generation.rolled_back")).toBe(true);
    await app.close();
  });
});

export { makeApp, owner, seedBackfilling, seedReadyWithChunks };
