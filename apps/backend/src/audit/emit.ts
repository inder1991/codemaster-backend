/**
 * `emitAuditEvent` — the single helper every state-changing code path uses to emit an
 * `audit.audit_events` row. 1:1 port of vendor/codemaster-py/codemaster/audit/emit.py.
 *
 * Refuses to write if no tenancy context is bound on the client ({@link AuditContextMissing}) — the
 * helper itself is a tenancy-policy gate beyond the SQLAlchemy/ORM tenancy hook (it writes via raw SQL
 * and deliberately bypasses the ORM tenancy plugin: the row IS the tenancy record).
 *
 * ## Encryption (ADR-0033)
 *
 * `before` / `after` are arbitrary JSON-able values; they are encrypted at the
 * {@link encryptAuditJsonBytea} boundary (AES-256-GCM, per-column AAD bound to
 * `audit.audit_events.before` / `.after`) and bound as bytea (`kms2:vN:` envelope as ASCII bytes).
 * `null` → DB-NULL (mirrors the Python `before is not None` / `after is not None` guards).
 *
 * ## Context binding (port of `session.info`)
 *
 * The Python `bind_audit_context(session, installation_id=...)` stamps `session.info`; `emit_audit_event`
 * reads it back. Node `pg` clients have no `info` dict, so we carry the binding in a module-level
 * {@link WeakMap} keyed by the client object — same indirection, same "bind once, read on emit" call
 * shape, and the WeakMap entry is GC'd with the client. Production callers (e.g. the start-review gate)
 * bind the context on their already-open transaction client, then call `emitAuditEvent` on the SAME
 * client so the audit row commits atomically with the surrounding work.
 *
 * ## Why raw SQL (1:1 with Python)
 *
 * (a) cross-cutting use shouldn't import every ORM model; (b) we want to bypass the tenancy hook
 * deliberately for the audit insert itself. The INSERT column list + ordering is byte-for-byte the
 * Python shape: `(audit_event_id, installation_id, actor_kind, actor_id, action, target_kind,
 * target_id, before, after, created_at)`.
 */

import type { Clock } from "#platform/clock.js";
import { SystemRandom } from "#platform/randomness.js";

import {
  AUDIT_AFTER_AAD,
  AUDIT_BEFORE_AAD,
  encryptAuditJsonBytea,
} from "#backend/security/audit_field_codec.js";

/** The valid `actor_kind` values — 1:1 with the Python `ACTOR_KINDS` tuple + the DB CHECK constraint. */
export const ACTOR_KINDS = ["user", "system", "bot"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * The minimal DB-client surface `emitAuditEvent` needs — `pg.PoolClient` and `pg.Pool` both satisfy it.
 * Typed structurally so the helper does not couple to a concrete pg type and stays unit-testable with a
 * recording double.
 */
export type AuditQueryClient = {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<unknown> }>;
};

/**
 * Raised when {@link emitAuditEvent} runs without a bound tenancy context. Production code paths MUST
 * call {@link bindAuditContext} before any state-changing operation that emits audit. Without it, the
 * helper refuses to write — fail-closed. 1:1 with the Python `class AuditContextMissing(Exception)`.
 */
export class AuditContextMissing extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuditContextMissing";
  }
}

/** The result of a successful emit — carries the minted audit_event_id. Mirrors `AuditEventEmitResultV1`. */
export type AuditEventEmitResultV1 = {
  readonly schema_version: 1;
  readonly audit_event_id: string;
};

/** Module-level binding store — the Node analogue of SQLAlchemy `session.info`. GC'd with the client. */
const CONTEXT = new WeakMap<object, string>();

const RANDOM = new SystemRandom();

/** Mint a random RFC4122 v4 UUID (canonical lowercase hyphenated) via the platform randomness seam. */
function uuid4(): string {
  const b = Buffer.from(RANDOM.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Stamp `client` so {@link emitAuditEvent} knows the tenant. Idempotent — re-binding with the same id
 * is a no-op; re-binding to a different id is allowed (some workflows process events across multiple
 * installations within one client lifetime). 1:1 with Python `bind_audit_context`.
 */
export function bindAuditContext(client: object, args: { installationId: string }): void {
  CONTEXT.set(client, args.installationId);
}

function getAuditContext(client: object): string {
  const iid = CONTEXT.get(client);
  if (iid === undefined) {
    throw new AuditContextMissing(
      "emitAuditEvent requires bindAuditContext(client, { installationId }) to be called first",
    );
  }
  return iid;
}

/** Test-only accessor for the bound context (mirrors reading `session.info` in the Python tests). */
export function getAuditContextForTesting(client: object): string | undefined {
  return CONTEXT.get(client);
}

/**
 * Insert one row into `audit.audit_events`. `before` / `after` are arbitrary JSON-able values encrypted
 * at the {@link encryptAuditJsonBytea} boundary; `null`/`undefined` → DB-NULL. Returns the minted
 * `audit_event_id`. Reads the tenant from the {@link bindAuditContext}-bound context (fail-closed via
 * {@link AuditContextMissing}). 1:1 with Python `emit_audit_event`.
 */
export async function emitAuditEvent(args: {
  client: AuditQueryClient;
  actorKind: ActorKind;
  actorId: string | null;
  action: string;
  targetKind: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  clock: Clock;
}): Promise<AuditEventEmitResultV1> {
  if (!ACTOR_KINDS.includes(args.actorKind)) {
    throw new Error(`actor_kind=${JSON.stringify(args.actorKind)} not in ${JSON.stringify(ACTOR_KINDS)}`);
  }
  const installationId = getAuditContext(args.client);
  const auditEventId = uuid4();
  const now = args.clock.now();

  // Encrypt via the AAD-bound codec — bytea (kms2: ASCII bytes), or null for a null value.
  const encBefore = encryptAuditJsonBytea(args.before ?? null, AUDIT_BEFORE_AAD);
  const encAfter = encryptAuditJsonBytea(args.after ?? null, AUDIT_AFTER_AAD);

  await args.client.query(
    "INSERT INTO audit.audit_events " +
      "(audit_event_id, installation_id, actor_kind, actor_id, " +
      " action, target_kind, target_id, before, after, created_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      auditEventId,
      installationId,
      args.actorKind,
      args.actorId,
      args.action,
      args.targetKind,
      args.targetId ?? null,
      encBefore,
      encAfter,
      now,
    ],
  );

  return { schema_version: 1, audit_event_id: auditEventId };
}
