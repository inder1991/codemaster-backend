/**
 * Integration test for the members WRITE repo (insert/apply/reject pending role changes) against the
 * DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * 1:1 with postgres_members_repo.py's write methods. Exercises: pending-change INSERT + the partial-unique
 * concurrent-change 409 path, the CAS apply (pending→applied + role_grants write), the stale-state guard,
 * reject, and platform-scope (installation_id NULL) routing.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  MemberConcurrentPendingChangeError,
  MemberRoleChangePendingStaleError,
  applyChange,
  getPendingChange,
  insertPendingChange,
  rejectChange,
} from "#backend/api/admin/members_write.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const INST = "ac000000-0000-0000-0000-000000000001";
const SUBJ_A = "ac000000-0000-0000-0000-00000000000a";
const SUBJ_B = "ac000000-0000-0000-0000-00000000000b";
const SUBJ_P = "ac000000-0000-0000-0000-00000000000c";
const REQ = "ac000000-0000-0000-0000-000000000010"; // requester
const APP = "ac000000-0000-0000-0000-000000000011"; // approver (distinct)
const T0 = new Date("2026-06-07T12:00:00.000Z");
const EXP = new Date("2026-06-14T12:00:00.000Z");

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.role_grant_pending WHERE subject_id IN (${SUBJ_A}, ${SUBJ_B}, ${SUBJ_P})`.execute(db);
  await sql`DELETE FROM core.role_grants WHERE subject_id IN (${SUBJ_A}, ${SUBJ_B}, ${SUBJ_P})`.execute(db);
  await sql`DELETE FROM core.users WHERE user_id IN (${REQ}, ${APP})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INST}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INST}, 991000001, 'itest-memwrite', 'Organization')`.execute(db);
  // role_grant_pending.requested_by_user_id / approved_by_user_id FK → core.users
  await sql`INSERT INTO core.users (user_id, installation_id, email, display_name)
            VALUES (${REQ}, ${INST}, 'req@x', 'Req'), (${APP}, ${INST}, 'app@x', 'App')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function baseArgs(subjectId: string, scope: "platform" | "installation") {
  return {
    installationId: scope === "platform" ? null : INST,
    subjectKind: "user",
    subjectId,
    role: "reader",
    action: "grant" as const,
    requestedAt: T0,
    requestedByUserId: REQ,
    expiresAt: EXP,
    scope,
  };
}

describeDb("members write repo (disposable :5434)", () => {
  it("insertPendingChange: creates a pending row; a 2nd for the same subject → concurrent 409", async () => {
    const row = await insertPendingChange(db, baseArgs(SUBJ_A, "installation"));
    expect(row.state).toBe("pending");
    expect(row.installation_id).toBe(INST);
    expect(row.scope).toBe("installation");
    expect(row.subject_id).toBe(SUBJ_A);

    await expect(insertPendingChange(db, baseArgs(SUBJ_A, "installation"))).rejects.toBeInstanceOf(
      MemberConcurrentPendingChangeError,
    );
    try {
      await insertPendingChange(db, baseArgs(SUBJ_A, "installation"));
    } catch (e) {
      expect((e as MemberConcurrentPendingChangeError).existingPendingId).toBe(row.pending_id);
    }

    expect((await getPendingChange(db, row.pending_id))?.state).toBe("pending");
    expect(await getPendingChange(db, "ac000000-0000-0000-0000-0000000000ff")).toBeNull();
  });

  it("applyChange: CAS pending→applied + writes role_grants; re-apply → stale 409", async () => {
    const pending = await getPendingChange(db, (await firstPendingFor(SUBJ_A)).pending_id);
    const applied = await applyChange(db, {
      pendingId: pending!.pending_id,
      approvedByUserId: APP,
      approvedAt: T0,
      appliedAt: T0,
    });
    expect(applied.state).toBe("applied");
    expect(applied.approved_by_user_id).toBe(APP);
    // the grant is now an active role_grants row (granted_by_user_id column does NOT exist in prod schema)
    const grants = await sql<{ role: string; scope: string }>`
      SELECT role, scope FROM core.role_grants
      WHERE subject_kind='user' AND subject_id=${SUBJ_A} AND installation_id=${INST}
    `.execute(db);
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0]).toEqual({ role: "reader", scope: "installation" });

    await expect(
      applyChange(db, { pendingId: pending!.pending_id, approvedByUserId: APP, approvedAt: T0, appliedAt: T0 }),
    ).rejects.toBeInstanceOf(MemberRoleChangePendingStaleError);
  });

  it("rejectChange: CAS pending→rejected (no role_grants write)", async () => {
    const pending = await insertPendingChange(db, baseArgs(SUBJ_B, "installation"));
    const rejected = await rejectChange(db, { pendingId: pending.pending_id, approvedByUserId: APP, approvedAt: T0 });
    expect(rejected.state).toBe("rejected");
    const grants = await sql`SELECT 1 FROM core.role_grants WHERE subject_id=${SUBJ_B}`.execute(db);
    expect(grants.rows).toHaveLength(0); // reject never writes a grant
  });

  it("platform scope: installation_id NULL on pending + the applied grant", async () => {
    const pending = await insertPendingChange(db, baseArgs(SUBJ_P, "platform"));
    expect(pending.installation_id).toBeNull();
    expect(pending.scope).toBe("platform");
    const applied = await applyChange(db, {
      pendingId: pending.pending_id,
      approvedByUserId: APP,
      approvedAt: T0,
      appliedAt: T0,
    });
    expect(applied.state).toBe("applied");
    const grants = await sql<{ installation_id: string | null }>`
      SELECT installation_id FROM core.role_grants WHERE subject_id=${SUBJ_P} AND scope='platform'
    `.execute(db);
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0]!.installation_id).toBeNull();
  });
});

/** Helper: re-select the (single) in-flight pending row for a subject under INST. */
async function firstPendingFor(subjectId: string): Promise<{ pending_id: string }> {
  const r = await sql<{ pending_id: string }>`
    SELECT pending_id FROM core.role_grant_pending
    WHERE subject_id=${subjectId} AND installation_id=${INST} AND state='pending' LIMIT 1
  `.execute(db);
  return r.rows[0]!;
}
