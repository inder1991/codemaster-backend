/**
 * Integration test for knowledge write endpoints against the DISPOSABLE Postgres
 * (CODEMASTER_PG_CORE_DSN — :5439, NEVER the cluster). Runs ONLY when the DSN is set.
 *
 *   - PUT  /api/admin/knowledge/{learning_id}                  (If-Match version CAS + revision insert)
 *   - POST /api/admin/knowledge/proposals/{proposal_id}/approve (self-approval 403; signal workflow)
 *   - POST /api/admin/knowledge/proposals/{proposal_id}/reject  (reason 10..2048; signal workflow)
 *
 * 1:1 port of codemaster/api/admin/knowledge.py (update_learning_body / approve_proposal /
 * reject_proposal) + the KnowledgeApprovalWorkflow signal contract
 * (workflow_id = `knowledge-approval-{proposal_id}`; approve payload {approver_user_id};
 * reject payload {approver_user_id, reason}).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeAdminTemporalPort } from "#backend/api/admin/_admin_temporal_port.js";
import { RecordingTemporalClient } from "#backend/adapters/temporal_port.js";
import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import { FakeClock } from "#platform/clock.js";
import { LearningDetailV1, StaleWriteV1 } from "#contracts/admin.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-08T10:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "f1f1f1f1-2222-3333-4444-555555555555";
const LEARNING_ID = "11111111-2222-3333-4444-555555555555";
const PROPOSAL_ID = "22222222-2222-3333-4444-555555555555";
const APPROVER_ID = "a1a1a1a1-0000-0000-0000-000000000001";
const PROPOSER_ID = "b2b2b2b2-0000-0000-0000-000000000002";

let pool: Pool;
let db: Kysely<unknown>;
let temporal: RecordingTemporalClient;

async function reseed(): Promise<void> {
  await sql`DELETE FROM core.learnings_revisions WHERE learning_id = ${LEARNING_ID}`.execute(db);
  await sql`DELETE FROM core.learnings WHERE learning_id = ${LEARNING_ID}`.execute(db);
  await sql`DELETE FROM core.learning_proposals WHERE proposal_id = ${PROPOSAL_ID}`.execute(db);

  await sql`INSERT INTO core.learnings
      (learning_id, installation_id, title, body_markdown, version, state,
       fired_count, accepted_count, feedback_count)
    VALUES (${LEARNING_ID}, ${INST}, 'Test Learning', 'original body', 1, 'active', 0, 0, 0)`.execute(db);

  await sql`INSERT INTO core.learning_proposals
      (proposal_id, installation_id, title, body, proposed_by_user_id, state)
    VALUES (${PROPOSAL_ID}, ${INST}, 'Test Proposal', 'proposal body', ${PROPOSER_ID}, 'pending_approval')`.execute(
    db,
  );
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  temporal = new RecordingTemporalClient();

  // Seed the parent installation (FK target for learnings / proposals); idempotent.
  await sql`INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${INST}, 909090909, 'kw-test-org', 'Organization')
    ON CONFLICT (installation_id) DO NOTHING`.execute(db);

  await reseed();
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.learnings_revisions WHERE learning_id = ${LEARNING_ID}`.execute(db);
    await sql`DELETE FROM core.learnings WHERE learning_id = ${LEARNING_ID}`.execute(db);
    await sql`DELETE FROM core.learning_proposals WHERE proposal_id = ${PROPOSAL_ID}`.execute(db);
    await sql`DELETE FROM core.installations WHERE installation_id = ${INST}`.execute(db);
  }
  // db.destroy() ends the underlying pg Pool; no separate pool.end() (avoids double-end).
  await db?.destroy();
});

function mintCookie(role: Role, userId: string = APPROVER_ID): string {
  return issueCookie({
    user_id: userId,
    email: "user@example.com",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    temporal: makeAdminTemporalPort(temporal),
  });
  await app.ready();
  return app;
}

describeDb("admin knowledge writes (disposable :5439)", () => {
  describe("knowledge_write repo layer", () => {
    it("updateLearningBody: CAS success bumps version + creates revision", async () => {
      await reseed();
      const { updateLearningBody } = await import("#backend/api/admin/knowledge_write.js");
      const before = await sql<{ version: number }>`
        SELECT version FROM core.learnings WHERE learning_id = ${LEARNING_ID}
      `.execute(db);
      const beforeVersion = Number(before.rows[0]!.version);

      const result = await updateLearningBody(db, {
        learningId: LEARNING_ID,
        installationId: INST,
        newBodyMarkdown: "updated in repo test",
        ifMatchVersion: beforeVersion,
        editedByUserId: APPROVER_ID,
        now: NOW,
      });

      expect(result.version).toBe(beforeVersion + 1);
      expect(result.body_markdown).toBe("updated in repo test");

      const revisions = await sql<{ version: number }>`
        SELECT version FROM core.learnings_revisions
        WHERE learning_id = ${LEARNING_ID}
        ORDER BY edited_at DESC LIMIT 1
      `.execute(db);
      expect(Number(revisions.rows[0]!.version)).toBe(beforeVersion + 1);
    });

    it("updateLearningBody: CAS failure throws KnowledgeStaleWriteError", async () => {
      await reseed();
      const { updateLearningBody, KnowledgeStaleWriteError } = await import(
        "#backend/api/admin/knowledge_write.js"
      );
      let caught: unknown;
      try {
        await updateLearningBody(db, {
          learningId: LEARNING_ID,
          installationId: INST,
          newBodyMarkdown: "will fail",
          ifMatchVersion: 999,
          editedByUserId: APPROVER_ID,
          now: NOW,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(KnowledgeStaleWriteError);
      const err = caught as InstanceType<typeof KnowledgeStaleWriteError>;
      expect(typeof err.current_version).toBe("number");
      expect(err.current_body).toBeDefined();
    });
  });

  it("PUT /api/admin/knowledge/{learning_id} — 200 updates body + returns LearningDetailV1", async () => {
    await reseed();
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      headers: { "If-Match": '"1"' },
      payload: { body_markdown: "updated body" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("learning_id", LEARNING_ID);
    expect(body).toHaveProperty("body_markdown", "updated body");
    expect(body).toHaveProperty("version", 2);
    expect(body).toHaveProperty("revisions");
    LearningDetailV1.parse(body);
    await app.close();
  });

  it("PUT /api/admin/knowledge/{learning_id} — 409 on stale version", async () => {
    await reseed();
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      headers: { "If-Match": '"999"' },
      payload: { body_markdown: "stale update" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    StaleWriteV1.parse(body);
    expect(body.code).toBe("stale_write");
    expect(body).toHaveProperty("current_body");
    expect(body).toHaveProperty("current_version");
    await app.close();
  });

  it("PUT /api/admin/knowledge/{learning_id} — 428 missing If-Match", async () => {
    await reseed();
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      payload: { body_markdown: "no header" },
    });
    expect(res.statusCode).toBe(428);
    await app.close();
  });

  it("PUT /api/admin/knowledge/{learning_id} — 403 for reader role", async () => {
    await reseed();
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/admin/knowledge/${LEARNING_ID}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
      headers: { "If-Match": '"1"' },
      payload: { body_markdown: "denied" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/approve — 204 emits signal", async () => {
    await reseed();
    temporal = new RecordingTemporalClient();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/approve`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(res.statusCode).toBe(204);
    expect(temporal.signals).toHaveLength(1);
    expect(temporal.signals[0]).toEqual([
      `knowledge-approval-${PROPOSAL_ID}`,
      "approve",
      { approver_user_id: APPROVER_ID },
    ]);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/approve — 403 self-approval", async () => {
    await reseed();
    temporal = new RecordingTemporalClient();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/approve`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner", PROPOSER_ID) },
    });
    expect(res.statusCode).toBe(403);
    expect(temporal.signals).toHaveLength(0);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/reject — 204 emits signal + validates reason", async () => {
    await reseed();
    temporal = new RecordingTemporalClient();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/reject`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      payload: { reason: "This proposal needs more detail" },
    });
    expect(res.statusCode).toBe(204);
    expect(temporal.signals).toHaveLength(1);
    expect(temporal.signals[0]).toEqual([
      `knowledge-approval-${PROPOSAL_ID}`,
      "reject",
      { approver_user_id: APPROVER_ID, reason: "This proposal needs more detail" },
    ]);
    await app.close();
  });

  it("POST /api/admin/knowledge/proposals/{proposal_id}/reject — 422 reason too short", async () => {
    await reseed();
    temporal = new RecordingTemporalClient();
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/knowledge/proposals/${PROPOSAL_ID}/reject`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
      payload: { reason: "short" },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
