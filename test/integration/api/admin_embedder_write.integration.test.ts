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
});

export { makeApp, owner, seedBackfilling, seedReadyWithChunks };
