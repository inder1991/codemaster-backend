// Audit-events read — 1:1 port of codemaster/api/admin/audit_events.py + postgres_audit_events_repo.py.
//
// Server-side filter + cursor pagination + decryption over audit.audit_events. Only user-actor rows surface
// (actor_kind='user' AND actor_id IS NOT NULL). Cross-tenant is gated to super_admin/security_auditor; for
// everyone else the query is scoped to the caller's installation. Time windows > 30 days are refused for
// non-security_auditor (absent from/to normalize to now-7d..now).
//
// CRYPTO DIVERGENCE (faithful to the TS model, not the Python): the Python decrypts before/after via Vault
// Transit; here we use the LOCAL AES-256-GCM-AAD codec (decryptAuditJsonBytea) — the same codec the TS audit
// emit writes with, so reads must match. Decrypt failure fails OPEN to a placeholder excerpt (never blocks).

import { type Kysely, sql } from "kysely";

import type { AuditEventListItemV1 } from "#contracts/admin.v1.js";

import type { Role } from "#backend/api/auth/roles.js";
import {
  AUDIT_AFTER_AAD,
  AUDIT_BEFORE_AAD,
  decryptAuditJsonBytea,
} from "#backend/security/audit_field_codec.js";

export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;
const EXCERPT_CAP = 200;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const VAULT_UNAVAILABLE = "<encrypted; vault unavailable>";

/** Roles permitted to read audit events at all (org_owner / knowledge_curator are NOT). */
export const AUDIT_READ_ROLES = new Set<Role>([
  "reader",
  "platform_operator",
  "platform_owner",
  "super_admin",
  "security_auditor",
]);
/** Roles permitted cross-tenant audit reads. */
export const AUDIT_CROSS_TENANT_ROLES = new Set<Role>(["super_admin", "security_auditor"]);

export class AuditCrossTenantRefusedError extends Error {
  public constructor() {
    super("cross-tenant searches require security_auditor role");
    this.name = "AuditCrossTenantRefusedError";
  }
}
export class AuditWindowTooWideError extends Error {
  public constructor() {
    super("window > 30d requires security_auditor role");
    this.name = "AuditWindowTooWideError";
  }
}
export class AuditCursorInvalidError extends Error {
  public constructor() {
    super("invalid cursor");
    this.name = "AuditCursorInvalidError";
  }
}

export type AuditQuery = {
  actorUserId?: string | null;
  action?: string | null;
  targetId?: string | null;
  fromAt?: string | null;
  toAt?: string | null;
  crossTenant: boolean;
};

/** Opaque cursor = base64url(JSON({occurred_at, audit_event_id})), unpadded — clients can't forge one that
 *  bypasses authz (the authz filters are re-applied on every page). */
export function encodeCursor(occurredAtIso: string, auditEventId: string): string {
  const raw = JSON.stringify({ occurred_at: occurredAtIso, audit_event_id: auditEventId });
  return Buffer.from(raw, "utf-8").toString("base64url");
}
export function decodeCursor(cursor: string): { occurredAt: string; auditEventId: string } {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
      occurred_at?: unknown;
      audit_event_id?: unknown;
    };
    if (typeof payload.occurred_at !== "string" || typeof payload.audit_event_id !== "string") {
      throw new AuditCursorInvalidError();
    }
    return { occurredAt: payload.occurred_at, auditEventId: payload.audit_event_id };
  } catch {
    throw new AuditCursorInvalidError();
  }
}

/** Clamp the window per role; non-security_auditor is capped to 30 days (absent → now-7d..now). */
export function validateWindow(
  role: Role,
  fromAt: string | null,
  toAt: string | null,
  now: Date,
): { from: string | null; to: string | null } {
  if (role === "security_auditor") {
    return { from: fromAt, to: toAt };
  }
  const effectiveTo = toAt !== null ? new Date(toAt) : now;
  const effectiveFrom = fromAt !== null ? new Date(fromAt) : new Date(effectiveTo.getTime() - DEFAULT_WINDOW_MS);
  if (effectiveTo.getTime() - effectiveFrom.getTime() > MAX_WINDOW_MS) {
    throw new AuditWindowTooWideError();
  }
  return { from: effectiveFrom.toISOString(), to: effectiveTo.toISOString() };
}

type AuditDbRow = {
  audit_event_id: string;
  installation_id: string;
  actor_user_id: string;
  action: string;
  target_id: string | null;
  occurred_at: Date;
  before_encrypted: Buffer | null;
  after_encrypted: Buffer | null;
};

function truncate(text: string): string {
  return text.length <= EXCERPT_CAP ? text : text.slice(0, EXCERPT_CAP) + "…";
}

/** Decrypt a before/after bytea to a truncated excerpt; null → "", decrypt failure → the placeholder. */
function decryptExcerpt(value: Buffer | null, aad: Uint8Array): string {
  if (value === null) {
    return "";
  }
  try {
    const decrypted = decryptAuditJsonBytea(value, aad);
    return decrypted === null ? "" : truncate(JSON.stringify(decrypted));
  } catch {
    return VAULT_UNAVAILABLE;
  }
}

function decryptRow(row: AuditDbRow): AuditEventListItemV1 {
  return {
    audit_event_id: row.audit_event_id,
    actor_user_id: row.actor_user_id,
    action: row.action,
    target_id: row.target_id,
    occurred_at: new Date(row.occurred_at).toISOString(),
    before_excerpt: decryptExcerpt(row.before_encrypted, AUDIT_BEFORE_AAD),
    after_excerpt: decryptExcerpt(row.after_encrypted, AUDIT_AFTER_AAD),
  };
}

/** Search + decrypt + paginate. Throws AuditCrossTenantRefusedError / AuditWindowTooWideError /
 *  AuditCursorInvalidError on the corresponding violations (the route maps them to 403/403/400). */
export async function searchAuditEvents(
  db: Kysely<unknown>,
  args: {
    role: Role;
    callerInstallationId: string;
    query: AuditQuery;
    cursor: string | null;
    size: number;
    now: Date;
  },
): Promise<{ rows: Array<AuditEventListItemV1>; nextCursor: string | null }> {
  if (args.query.crossTenant && !AUDIT_CROSS_TENANT_ROLES.has(args.role)) {
    throw new AuditCrossTenantRefusedError();
  }
  const { from, to } = validateWindow(
    args.role,
    args.query.fromAt ?? null,
    args.query.toAt ?? null,
    args.now,
  );
  const size = Math.min(Math.max(args.size, 1), AUDIT_MAX_PAGE_SIZE);
  const installationId = args.query.crossTenant ? null : args.callerInstallationId;

  const conditions = [sql`actor_kind = 'user'`, sql`actor_id IS NOT NULL`];
  if (installationId !== null) {
    conditions.push(sql`installation_id = ${installationId}`);
  }
  if (args.query.actorUserId != null) {
    conditions.push(sql`actor_id = ${args.query.actorUserId}`);
  }
  if (args.query.action != null) {
    conditions.push(sql`action = ${args.query.action}`);
  }
  if (args.query.targetId != null) {
    conditions.push(sql`target_id = ${args.query.targetId}`);
  }
  if (from != null) {
    conditions.push(sql`created_at >= ${from}`);
  }
  if (to != null) {
    conditions.push(sql`created_at < ${to}`);
  }
  if (args.cursor != null) {
    const { occurredAt, auditEventId } = decodeCursor(args.cursor);
    conditions.push(sql`(created_at, audit_event_id) < (${occurredAt}, ${auditEventId})`);
  }
  const where = sql.join(conditions, sql` AND `);

  const r = await sql<AuditDbRow>`
    SELECT audit_event_id, installation_id, actor_id AS actor_user_id, action, target_id,
           created_at AS occurred_at, before AS before_encrypted, after AS after_encrypted
    FROM audit.audit_events
    WHERE ${where}
    ORDER BY created_at DESC, audit_event_id DESC
    LIMIT ${size + 1}
  `.execute(db);

  const hasMore = r.rows.length > size;
  const emitted = r.rows.slice(0, size);
  const rows = emitted.map(decryptRow);
  let nextCursor: string | null = null;
  if (hasMore && emitted.length > 0) {
    const last = emitted[emitted.length - 1]!;
    nextCursor = encodeCursor(new Date(last.occurred_at).toISOString(), last.audit_event_id);
  }
  return { rows, nextCursor };
}
