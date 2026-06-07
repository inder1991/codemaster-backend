// Members write repo — 1:1 port of the WRITE methods of postgres_members_repo.py
// (insert_pending_change, apply_change, reject_change, _find_existing_pending_id) + get_pending_change.
//
// The two-person-approval flow: a pending role change is staged in core.role_grant_pending, then a SECOND
// user approves (CAS pending→applied + the core.role_grants write) or rejects (CAS pending→rejected).
//
// 1:1-DIVERGENCE (same as members_read.ts): apply_change's grant INSERT writes `granted_by_user_id` in the
// Python, but the production core.role_grants has NO such column (it carries granted_at + revoked_at +
// scope) — the Python INSERT would UndefinedColumn in prod. The port OMITS granted_by_user_id; the
// "who approved" is recorded on the role_grant_pending row's approved_by_user_id instead.

import { type Kysely, sql } from "kysely";

import {
  ExpiredApprovalError,
  SelfApprovalError,
  StalePendingStateError,
  checkNotExpired,
  checkPendingState,
  checkSelfApproval,
} from "#backend/api/admin/two_person_approval.js";
import {
  MISSING_PENDING_ID_FALLBACK_UUID,
  PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
} from "#backend/infra/sentinels.js";

import type { RoleChangePendingV1, RoleChangeRequestV1 } from "#contracts/admin.v1.js";

/** No row with the given pending_id. Route → 404. */
export class MemberRoleChangePendingNotFoundError extends Error {
  public constructor(pendingId: string) {
    super(`pending change ${pendingId} not found`);
    this.name = "MemberRoleChangePendingNotFoundError";
  }
}

/** Row is no longer in 'pending' state — already applied / rejected / expired. Route → 409. */
export class MemberRoleChangePendingStaleError extends Error {
  public constructor(pendingId: string) {
    super(`pending change ${pendingId} is no longer in 'pending' state`);
    this.name = "MemberRoleChangePendingStaleError";
  }
}

/** A pending change for the same (installation, subject) already exists. Route → 409 with the existing id. */
export class MemberConcurrentPendingChangeError extends Error {
  public readonly existingPendingId: string;
  public constructor(existingPendingId: string) {
    super(`a pending role change for the same subject already exists: ${existingPendingId}`);
    this.name = "MemberConcurrentPendingChangeError";
    this.existingPendingId = existingPendingId;
  }
}

/** The approver is the same user who requested the change (two-person rule). Route → 403. */
export class MemberSelfApprovalError extends Error {
  public constructor() {
    super("the approver must be a different user than the requester (two-person rule)");
    this.name = "MemberSelfApprovalError";
  }
}

/** The pending row's TTL has elapsed. Route → 410 Gone. */
export class MemberExpiredApprovalError extends Error {
  public readonly expiresAt: Date;
  public constructor(expiresAt: Date) {
    super(`pending change expired at ${expiresAt.toISOString()}; resubmit the request`);
    this.name = "MemberExpiredApprovalError";
    this.expiresAt = expiresAt;
  }
}

/** The full internal pending-change row (carries installation_id + scope, unlike the wire contract). */
export type MemberPendingRow = {
  pending_id: string;
  installation_id: string | null;
  subject_kind: string;
  subject_id: string;
  role: string;
  action: string;
  requested_at: Date;
  requested_by_user_id: string;
  expires_at: Date;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  applied_at: Date | null;
  state: string;
  scope: string;
};

const PENDING_COLS = sql`
  pending_id, installation_id, subject_kind, subject_id, role, action, requested_at,
  requested_by_user_id, expires_at, approved_at, approved_by_user_id, applied_at, state, scope
`;

type PendingSqlRow = {
  pending_id: string;
  installation_id: string | null;
  subject_kind: string;
  subject_id: string;
  role: string;
  action: string;
  requested_at: Date;
  requested_by_user_id: string;
  expires_at: Date;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  applied_at: Date | null;
  state: string;
  scope: string;
};

function mapPendingRow(r: PendingSqlRow): MemberPendingRow {
  return {
    pending_id: r.pending_id,
    installation_id: r.installation_id === null ? null : String(r.installation_id),
    subject_kind: r.subject_kind,
    subject_id: String(r.subject_id),
    role: r.role,
    action: r.action,
    requested_at: r.requested_at,
    requested_by_user_id: String(r.requested_by_user_id),
    expires_at: r.expires_at,
    approved_at: r.approved_at,
    approved_by_user_id: r.approved_by_user_id === null ? null : String(r.approved_by_user_id),
    applied_at: r.applied_at,
    state: r.state,
    scope: r.scope,
  };
}

/** SQLSTATE 23505 = unique_violation (the partial uq_role_grant_pending_one_in_flight_* indexes). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function getPendingChange(
  db: Kysely<unknown>,
  pendingId: string,
): Promise<MemberPendingRow | null> {
  const r = await sql<PendingSqlRow>`
    SELECT ${PENDING_COLS} FROM core.role_grant_pending WHERE pending_id = ${pendingId}
  `.execute(db);
  const row = r.rows[0];
  return row === undefined ? null : mapPendingRow(row);
}

export type InsertPendingArgs = {
  installationId: string | null;
  subjectKind: string;
  subjectId: string;
  role: string;
  action: string;
  requestedAt: Date;
  requestedByUserId: string;
  expiresAt: Date;
  scope: string;
};

/** INSERT a state='pending' row. Platform-scope rows carry installation_id=NULL. On a partial-unique
 *  violation, re-SELECT the in-flight row's id and raise MemberConcurrentPendingChangeError (→ 409). */
export async function insertPendingChange(
  db: Kysely<unknown>,
  args: InsertPendingArgs,
): Promise<MemberPendingRow> {
  // Platform-scope rows MUST have installation_id NULL (the scope-consistency CHECK + partial index).
  const effectiveInstall = args.scope === "platform" ? null : args.installationId;
  try {
    const r = await sql<PendingSqlRow>`
      INSERT INTO core.role_grant_pending
        (installation_id, subject_kind, subject_id, role, action, requested_at,
         requested_by_user_id, expires_at, state, scope)
      VALUES (${effectiveInstall}, ${args.subjectKind}, ${args.subjectId}, ${args.role}, ${args.action},
              ${args.requestedAt}, ${args.requestedByUserId}, ${args.expiresAt}, 'pending', ${args.scope})
      RETURNING ${PENDING_COLS}
    `.execute(db);
    return mapPendingRow(r.rows[0]!);
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const existing = await findExistingPendingId(db, {
      subjectKind: args.subjectKind,
      subjectId: args.subjectId,
      scope: args.scope,
      installationId: effectiveInstall,
    });
    throw new MemberConcurrentPendingChangeError(existing);
  }
}

async function findExistingPendingId(
  db: Kysely<unknown>,
  args: { subjectKind: string; subjectId: string; scope: string; installationId: string | null },
): Promise<string> {
  const where =
    args.scope === "platform"
      ? sql`scope = 'platform' AND subject_kind = ${args.subjectKind} AND subject_id = ${args.subjectId} AND state = 'pending'`
      : sql`scope = 'installation' AND installation_id = ${args.installationId} AND subject_kind = ${args.subjectKind} AND subject_id = ${args.subjectId} AND state = 'pending'`;
  const r = await sql<{ pending_id: string }>`
    SELECT pending_id FROM core.role_grant_pending WHERE ${where} LIMIT 1
  `.execute(db);
  // Extremely unlikely: the winner was applied/rejected between our INSERT failure and this re-SELECT.
  return r.rows[0]?.pending_id ?? MISSING_PENDING_ID_FALLBACK_UUID;
}

/** Atomically flip pending→applied AND write (or remove, for revoke) the core.role_grants row. CAS on
 *  `state='pending'` so a concurrent second-approver race leaves the row unchanged → stale error. */
export async function applyChange(
  db: Kysely<unknown>,
  args: { pendingId: string; approvedByUserId: string; approvedAt: Date; appliedAt: Date },
): Promise<MemberPendingRow> {
  return db.transaction().execute(async (tx) => {
    const upd = await sql<PendingSqlRow>`
      UPDATE core.role_grant_pending
      SET state = 'applied', approved_by_user_id = ${args.approvedByUserId},
          approved_at = ${args.approvedAt}, applied_at = ${args.appliedAt}
      WHERE pending_id = ${args.pendingId} AND state = 'pending'
      RETURNING ${PENDING_COLS}
    `.execute(tx);
    const updatedRow = upd.rows[0];
    if (updatedRow === undefined) {
      throw new MemberRoleChangePendingStaleError(args.pendingId);
    }
    const u = mapPendingRow(updatedRow);

    // Scope-routed installation predicate for the role_grants DELETE (hard-coded fragments; no user input).
    const installPredicate =
      u.scope === "installation" ? sql`AND installation_id = ${u.installation_id}` : sql`AND installation_id IS NULL`;

    if (u.action === "grant" && u.subject_kind === "user") {
      // Upsert: remove any stale grant for the subject in this scope, then insert the new one.
      await sql`
        DELETE FROM core.role_grants
        WHERE subject_kind = 'user' AND subject_id = ${u.subject_id} AND scope = ${u.scope} ${installPredicate}
      `.execute(tx);
      // granted_by_user_id OMITTED — no such column in the production schema (see header divergence).
      await sql`
        INSERT INTO core.role_grants (installation_id, scope, subject_kind, subject_id, role, granted_at)
        VALUES (${u.installation_id}, ${u.scope}, 'user', ${u.subject_id}, ${u.role}, ${args.appliedAt})
      `.execute(tx);
    } else if (u.action === "revoke" && u.subject_kind === "user") {
      await sql`
        DELETE FROM core.role_grants
        WHERE subject_kind = 'user' AND subject_id = ${u.subject_id} AND scope = ${u.scope} ${installPredicate}
      `.execute(tx);
    }
    // Team grants/revokes on core.role_grants are deferred to the team-scope follow-up (matches Python).
    return u;
  });
}

/** CAS flip pending→rejected. Same race semantics as applyChange (stale → 409). No role_grants write —
 *  rejection (incl. a requester cancelling their own draft) can't grant or revoke anything. */
export async function rejectChange(
  db: Kysely<unknown>,
  args: { pendingId: string; approvedByUserId: string; approvedAt: Date },
): Promise<MemberPendingRow> {
  return db.transaction().execute(async (tx) => {
    const r = await sql<PendingSqlRow>`
      UPDATE core.role_grant_pending
      SET state = 'rejected', approved_by_user_id = ${args.approvedByUserId}, approved_at = ${args.approvedAt}
      WHERE pending_id = ${args.pendingId} AND state = 'pending'
      RETURNING ${PENDING_COLS}
    `.execute(tx);
    const updatedRow = r.rows[0];
    if (updatedRow === undefined) {
      throw new MemberRoleChangePendingStaleError(args.pendingId);
    }
    return mapPendingRow(updatedRow);
  });
}

// ─── Orchestration (request / approve / reject) + audit seam ────────────────────────────────────────
// 1:1 with members.py's _request_role_change / _approve_role_change / _reject_role_change. Audit is an
// OPTIONAL seam (undefined → no-op): the TS audit-emit pg-client wiring is dormant (FOLLOW-UP), so the
// endpoints are structurally complete and audit can be threaded in one place later. Mirrors login.ts.

/** Optional audit-emit callback. Shape mirrors the Python AuditEmitPort.emit kwargs. */
export type MemberAuditEmitter = (e: {
  actorUserId: string;
  // string | null — platform-scope admin actions (e.g. integrations DELETE on the platform-shared
  // core.integrations table) emit a NULL installation_id (audit_events.installation_id is nullable per
  // migration 0062). Member flows always pass a concrete installation id; the widening is for those callers.
  installationId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
}) => Promise<void>;

const AUDIT_TARGET_KIND = "role_grant_pending";
const AUDIT_ACTION_REQUEST = "member.role_change.requested";
const AUDIT_ACTION_APPLY = "member.role_change.applied";
const AUDIT_ACTION_REJECT = "member.role_change.rejected";

/** Map the internal pending row to the wire contract (drops installation_id; ISO timestamps). */
function toPendingWire(row: MemberPendingRow): RoleChangePendingV1 {
  return {
    schema_version: 2,
    pending_id: row.pending_id,
    subject_kind: row.subject_kind as RoleChangePendingV1["subject_kind"],
    subject_id: row.subject_id,
    role: row.role as RoleChangePendingV1["role"],
    action: row.action as RoleChangePendingV1["action"],
    requested_at: row.requested_at.toISOString(),
    requested_by_user_id: row.requested_by_user_id,
    expires_at: row.expires_at.toISOString(),
    approved_at: row.approved_at === null ? null : row.approved_at.toISOString(),
    approved_by_user_id: row.approved_by_user_id,
    applied_at: row.applied_at === null ? null : row.applied_at.toISOString(),
    state: row.state as RoleChangePendingV1["state"],
    scope: row.scope as RoleChangePendingV1["scope"],
  };
}

/** Stage a pending grant/revoke. Platform-scope routes the repo install to NULL + audit install to the
 *  PLATFORM_SCOPE_AUDIT sentinel. Concurrent in-flight change → MemberConcurrentPendingChangeError (409). */
export async function requestRoleChange(args: {
  db: Kysely<unknown>;
  body: RoleChangeRequestV1;
  installationId: string;
  requesterUserId: string;
  now: Date;
  expiresInMs: number;
  audit?: MemberAuditEmitter | undefined;
}): Promise<RoleChangePendingV1> {
  const expiresAt = new Date(args.now.getTime() + args.expiresInMs);
  const repoInstall = args.body.scope === "platform" ? null : args.installationId;
  const auditInstall =
    args.body.scope === "platform" ? PLATFORM_SCOPE_AUDIT_INSTALLATION_ID : args.installationId;
  const row = await insertPendingChange(args.db, {
    installationId: repoInstall,
    subjectKind: args.body.subject_kind,
    subjectId: args.body.subject_id,
    role: args.body.role,
    action: args.body.action,
    requestedAt: args.now,
    requestedByUserId: args.requesterUserId,
    expiresAt,
    scope: args.body.scope,
  });
  await args.audit?.({
    actorUserId: args.requesterUserId,
    installationId: auditInstall,
    action: AUDIT_ACTION_REQUEST,
    targetKind: AUDIT_TARGET_KIND,
    targetId: row.pending_id,
    before: null,
    after: {
      subject_kind: args.body.subject_kind,
      subject_id: args.body.subject_id,
      role: args.body.role,
      action: args.body.action,
      expires_at: expiresAt.toISOString(),
      state: "pending",
      scope: args.body.scope,
    },
    now: args.now,
  });
  return toPendingWire(row);
}

/** Two-person + TTL + state checks (in that order), then atomically apply. Each predicate failure is
 *  re-raised as the route-mappable Member* error. */
export async function approveRoleChange(args: {
  db: Kysely<unknown>;
  pendingId: string;
  installationId: string;
  approverUserId: string;
  now: Date;
  audit?: MemberAuditEmitter | undefined;
}): Promise<RoleChangePendingV1> {
  const row = await getPendingChange(args.db, args.pendingId);
  if (row === null) {
    throw new MemberRoleChangePendingNotFoundError(args.pendingId);
  }
  try {
    checkSelfApproval({ requesterUserId: row.requested_by_user_id, approverUserId: args.approverUserId });
  } catch (e) {
    if (e instanceof SelfApprovalError) throw new MemberSelfApprovalError();
    throw e;
  }
  try {
    checkNotExpired({ expiresAt: row.expires_at, now: args.now });
  } catch (e) {
    if (e instanceof ExpiredApprovalError) throw new MemberExpiredApprovalError(e.expiresAt);
    throw e;
  }
  try {
    checkPendingState({ state: row.state });
  } catch (e) {
    if (e instanceof StalePendingStateError) throw new MemberRoleChangePendingStaleError(args.pendingId);
    throw e;
  }
  const applied = await applyChange(args.db, {
    pendingId: args.pendingId,
    approvedByUserId: args.approverUserId,
    approvedAt: args.now,
    appliedAt: args.now,
  });
  const auditInstall =
    row.scope === "platform" ? PLATFORM_SCOPE_AUDIT_INSTALLATION_ID : args.installationId;
  await args.audit?.({
    actorUserId: args.approverUserId,
    installationId: auditInstall,
    action: AUDIT_ACTION_APPLY,
    targetKind: AUDIT_TARGET_KIND,
    targetId: args.pendingId,
    before: { state: "pending", subject_kind: row.subject_kind, subject_id: row.subject_id, role: row.role, action: row.action },
    after: {
      state: "applied",
      applied_at: applied.applied_at === null ? null : applied.applied_at.toISOString(),
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      role: row.role,
      action: row.action,
    },
    now: args.now,
  });
  return toPendingWire(applied);
}

/** Reject a pending change. NOT subject to the two-person rule (a requester may cancel their own draft);
 *  only TTL + state checks apply. */
export async function rejectRoleChange(args: {
  db: Kysely<unknown>;
  pendingId: string;
  installationId: string;
  approverUserId: string;
  now: Date;
  audit?: MemberAuditEmitter | undefined;
}): Promise<RoleChangePendingV1> {
  const row = await getPendingChange(args.db, args.pendingId);
  if (row === null) {
    throw new MemberRoleChangePendingNotFoundError(args.pendingId);
  }
  try {
    checkNotExpired({ expiresAt: row.expires_at, now: args.now });
  } catch (e) {
    if (e instanceof ExpiredApprovalError) throw new MemberExpiredApprovalError(e.expiresAt);
    throw e;
  }
  try {
    checkPendingState({ state: row.state });
  } catch (e) {
    if (e instanceof StalePendingStateError) throw new MemberRoleChangePendingStaleError(args.pendingId);
    throw e;
  }
  const rejected = await rejectChange(args.db, {
    pendingId: args.pendingId,
    approvedByUserId: args.approverUserId,
    approvedAt: args.now,
  });
  const auditInstall =
    row.scope === "platform" ? PLATFORM_SCOPE_AUDIT_INSTALLATION_ID : args.installationId;
  await args.audit?.({
    actorUserId: args.approverUserId,
    installationId: auditInstall,
    action: AUDIT_ACTION_REJECT,
    targetKind: AUDIT_TARGET_KIND,
    targetId: args.pendingId,
    before: { state: "pending", subject_kind: row.subject_kind, subject_id: row.subject_id, role: row.role, action: row.action },
    after: { state: "rejected" },
    now: args.now,
  });
  return toPendingWire(rejected);
}
