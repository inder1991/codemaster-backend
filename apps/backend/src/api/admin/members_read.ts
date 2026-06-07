// Members read — 1:1 port of the READ path of postgres_members_repo.py::list_members +
// list_pending_changes, assembled by members.py::_build_members_page. GET /api/admin/members.
//
// Two reads merged into one MembersPageV1: the active role grants (core.role_grants ⋈ core.users)
// and every in-flight pending change (core.role_grant_pending). Platform-scope rows (installation_id
// NULL) are returned in EVERY per-install view AND exclusively in the zero-UUID platform view — a
// deliberate cross-tenant read gated by explicit SQL scope predicates (mirrors the Python repo's
// documented tenancy carve-out; the Kysely tenancy plugin only fires on ORM statements, not raw sql).
//
// 1:1-DIVERGENCES from the frozen Python SQL (both are stale against the real production schema — the
// 0001_baseline.sql pg_dump — and would raise UndefinedColumn at runtime; the Python integration test
// only ever ran against a hand-rolled fixture schema that had these columns):
//
//   1. JOIN ON u.user_id, not u.id. core.users' PK is `user_id`; there is no `id` column. Python's
//      `JOIN core.users u ON u.id = rg.subject_id` would 500 in production.
//   2. granted_by_user_id is ALWAYS null. The production core.role_grants has no `granted_by_user_id`
//      column (it carries granted_at + revoked_at + scope). Python SELECTs `rg.granted_by_user_id`,
//      which would also 500. The contract field is nullable, so the faithful-to-deployed-reality value
//      is null. (When a granter column is added to the schema, wire it here.)
//   3. display_name is COALESCE'd to '' . core.users.display_name is NULLABLE but MemberV1.display_name
//      is a non-null str; Python would crash (Pydantic reject + sorted() TypeError) on a NULL row. The
//      port substitutes '' for a deterministic, contract-valid ordering key.
//
// email is application-encrypted under the core.users.email AAD (ADR-0033); the raw-SQL read decrypts
// it via the same codec the auth repos use — the column never leaves this function as ciphertext.

import { type Kysely, sql } from "kysely";

import type { KeyRegistry } from "#platform/crypto/key_registry.js";

import { CORE_USER_EMAIL_AAD, decryptEmail } from "#backend/api/auth/email_codec.js";
import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/infra/sentinels.js";

import type { MemberV1, MembersPageV1, RoleChangePendingV1 } from "#contracts/admin.v1.js";

type MemberSqlRow = {
  subject_id: string;
  role: string;
  scope: string;
  granted_at: Date;
  email: string;
  display_name: string;
};

type PendingSqlRow = {
  pending_id: string;
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

/** A timestamptz column is parsed to a JS Date by node-pg; `null` survives. */
function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

async function listMembers(
  db: Kysely<unknown>,
  registry: KeyRegistry,
  installationId: string,
): Promise<Array<MemberV1>> {
  const platformOnly = installationId === SUPER_ADMIN_PLATFORM_VIEW_UUID;
  const where = platformOnly
    ? sql`rg.scope = 'platform' AND rg.subject_kind = 'user'`
    : sql`( (rg.installation_id = ${installationId} AND rg.scope = 'installation') OR rg.scope = 'platform' )
          AND rg.subject_kind = 'user'`;
  const r = await sql<MemberSqlRow>`
    SELECT rg.subject_id, rg.role, rg.scope, rg.granted_at,
           u.email, COALESCE(u.display_name, '') AS display_name
    FROM core.role_grants rg
    JOIN core.users u ON u.user_id = rg.subject_id
    WHERE ${where}
  `.execute(db);

  // Deterministic order: display_name ASC (mirrors the Python app-side sorted()).
  const rows = [...r.rows].sort((a, b) =>
    a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0,
  );
  return rows.map((row) => ({
    schema_version: 2,
    user_id: row.subject_id,
    email: decryptEmail(row.email, registry, CORE_USER_EMAIL_AAD),
    display_name: row.display_name,
    role: row.role as MemberV1["role"],
    granted_at: row.granted_at.toISOString(),
    granted_by_user_id: null, // no granter column in the production schema (see header divergence 2)
    scope: row.scope as MemberV1["scope"],
  }));
}

async function listPendingChanges(
  db: Kysely<unknown>,
  installationId: string,
): Promise<Array<RoleChangePendingV1>> {
  // NOTE: this read ALWAYS binds the supplied installation_id (even the zero-UUID platform view) — only
  // list_members special-cases the zero-UUID. With the zero-UUID, the installation branch matches no
  // rows, so only platform-scope pending rows return. installation_id is NOT a field of the contract.
  const r = await sql<PendingSqlRow>`
    SELECT pending_id, subject_kind, subject_id, role, action, requested_at, requested_by_user_id,
           expires_at, approved_at, approved_by_user_id, applied_at, state, scope
    FROM core.role_grant_pending
    WHERE state = 'pending'
      AND ( (installation_id = ${installationId} AND scope = 'installation') OR scope = 'platform' )
  `.execute(db);

  // Deterministic order: requested_at ASC (oldest first — queue head renders at top).
  const rows = [...r.rows].sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime());
  return rows.map((row) => ({
    schema_version: 2,
    pending_id: row.pending_id,
    subject_kind: row.subject_kind as RoleChangePendingV1["subject_kind"],
    subject_id: row.subject_id,
    role: row.role as RoleChangePendingV1["role"],
    action: row.action as RoleChangePendingV1["action"],
    requested_at: row.requested_at.toISOString(),
    requested_by_user_id: row.requested_by_user_id,
    expires_at: row.expires_at.toISOString(),
    approved_at: isoOrNull(row.approved_at),
    approved_by_user_id: row.approved_by_user_id,
    applied_at: isoOrNull(row.applied_at),
    state: row.state as RoleChangePendingV1["state"],
    scope: row.scope as RoleChangePendingV1["scope"],
  }));
}

export async function buildMembersPage(args: {
  db: Kysely<unknown>;
  registry: KeyRegistry;
  installationId: string;
}): Promise<MembersPageV1> {
  const members = await listMembers(args.db, args.registry, args.installationId);
  const pending = await listPendingChanges(args.db, args.installationId);
  return { schema_version: 1, members, pending_changes: pending };
}
