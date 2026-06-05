/**
 * `emitOutputSafetyAuditEvent` activity — 1:1 in intent with the frozen Python
 * `@activity.defn emit_output_safety_audit_event_activity`
 * (vendor/codemaster-py/codemaster/activities/emit_output_safety_audit.py).
 *
 * Workflow-scheduled, idempotent. Writes ONE row to `audit.audit_events` with
 * `action='output_safety.sanitized'` whenever an upstream LLM activity (`bedrock_review_chunk` /
 * `generate_walkthrough`) returns its envelope with a populated `sanitization_event`. The encrypted
 * `before` payload carries the original (pre-redaction) LLM text + the redacted text + spans + detector
 * kinds + stage; `after` is NULL because sanitization is a one-way transform.
 *
 * ## Idempotency model (port of the Python `_derive_audit_event_id` + pre-INSERT SELECT)
 *
 * `audit_event_id` is derived DETERMINISTICALLY from the sanitization event via
 * `uuidv5(_NAMESPACE_OUTPUT_SAFETY, request_id|kinds_sorted|spans|stage)`. A pre-INSERT SELECT under the
 * open transaction checks whether a row with that id already exists for the `installation_id`; if so the
 * activity is a no-op. Temporal at-least-once retries land on the same deterministic id and the SELECT
 * short-circuits them. `detector_kinds` is sorted before joining so the id is order-invariant; `stage`
 * is in the basis so the same `request_id` reused across the chunk + walkthrough call sites does not
 * collapse to a single audit row. Content-addressable ⇒ replay-safe by construction (no wall-clock / RNG
 * feeds the id).
 *
 * ## Why a direct INSERT (NOT the shared `emitAuditEvent`)
 *
 * The canonical {@link emitAuditEvent} helper mints a FRESH uuid4 per call — correct for actor-driven
 * audit (the row's identity IS the event) but it defeats deterministic-id idempotency: a Temporal retry
 * would observe the pre-INSERT SELECT MISS (the prior row's id was random, not our derived uuid5) and
 * write a duplicate. So this activity composes the same INSERT shape directly, re-using the per-column
 * AAD codec ({@link encryptAuditJsonBytea} with {@link AUDIT_BEFORE_AAD}) so the AAD binding matches the
 * canonical path byte-for-byte. (1:1 with the Python module's "Why a direct INSERT" rationale — it
 * re-uses `_ENCRYPTED_BEFORE` from `audit/emit.py`; we re-use the same codec + AAD constant.)
 *
 * ## Runtime context
 *
 * Runs in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox — so `node:crypto` (the uuid5 +
 * AES-256-GCM) and real I/O (`pg.Pool`) are available. The DSN is read from `CODEMASTER_PG_CORE_DSN` and
 * routed through the ADR-0062 process-shared single pool (`getPool`); the activity does NOT open its own
 * pool. The encryption key comes from the audit field-encryption registry seam
 * ({@link getAuditKeyRegistry}) — populated at startup by the dev env loader or the Vault loader
 * (FOLLOW-UP-audit-vault-key-loader). Encrypt fails closed if no key is installed.
 */

import { createHash } from "node:crypto";

import { getPool } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { EmitOutputSafetyAuditEventInput } from "#contracts/emit_output_safety_audit.v1.js";

import {
  AUDIT_BEFORE_AAD,
  encryptAuditJsonBytea,
} from "#backend/security/audit_field_codec.js";

/**
 * Stable namespace for the deterministic `audit_event_id` derivation. FROZEN: changing it would break
 * idempotency for any in-flight workflow whose `sanitization_event` was produced under the old
 * namespace. Byte-identical to the Python `_NAMESPACE_OUTPUT_SAFETY` UUID. Under the gate-collapse
 * directive a change here would require a fresh content basis, NOT a `workflow.patched` guard.
 */
const NAMESPACE_OUTPUT_SAFETY = "fa01b6f4-9e2c-4d8f-b3a0-7f1e8c2a5b39";

/**
 * RFC4122 v5 UUID (SHA-1 of namespace bytes ++ name bytes), canonical lowercase hyphenated form. 1:1
 * with Python `uuid.uuid5` and the existing ports in review_findings_repo.ts / retrieved_evidence.v1.ts.
 */
function uuid5(namespaceHex: string, name: string): string {
  const nsBytes = Buffer.from(namespaceHex.replace(/-/g, ""), "hex"); // 16 bytes
  const digest = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf-8")).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Compute the deterministic `audit_event_id` for a sanitization event. Basis:
 * `(request_id, detector_kinds_sorted_joined, spans_redacted, stage)`. 1:1 with the Python
 * `_derive_audit_event_id`. `detector_kinds` is sorted before joining (order-invariance); `stage`
 * widens the basis so reuse across the chunk + walkthrough call sites does not collapse rows.
 */
function deriveAuditEventId(event: EmitOutputSafetyAuditEventInput["event"]): string {
  const kindsSorted = [...event.detector_kinds].sort().join(",");
  const name = `${event.request_id}|${kindsSorted}|${event.spans_redacted}|${event.stage}`;
  return uuid5(NAMESPACE_OUTPUT_SAFETY, name);
}

/**
 * Insert ONE row into `audit.audit_events` for a sanitization event. Idempotent: if a row with the
 * deterministic `audit_event_id` already exists for the `installation_id` (a Temporal at-least-once
 * retry), the call is a no-op.
 *
 * The single positional input is an {@link EmitOutputSafetyAuditEventInput} (CLAUDE.md invariant 11).
 * Re-validated INDEPENDENTLY against the Zod contract (don't trust the dispatcher), mirroring the Python
 * activity receiving a typed Pydantic model through the payload converter.
 */
export async function emitOutputSafetyAuditEvent(input: unknown): Promise<void> {
  const { event } = EmitOutputSafetyAuditEventInput.parse(input);
  const auditEventId = deriveAuditEventId(event);

  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot emit the output-safety audit row");
  }
  const pool = getPool(dsn);
  const clock = new WallClock();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pre-INSERT idempotency — same pattern as the Python pre-INSERT SELECT. Filters on installation_id
    // too: tenancy-gate safety (audit.audit_events is TenantScoped) + defence-in-depth against a (near-
    // impossible) uuid5 collision across installations.
    const existing = await client.query(
      "SELECT 1 FROM audit.audit_events WHERE audit_event_id = $1 AND installation_id = $2 LIMIT 1",
      [auditEventId, event.installation_id],
    );
    if (existing.rows.length > 0) {
      // Idempotent no-op (the row already exists for this installation_id). COMMIT the empty txn.
      await client.query("COMMIT");
      return;
    }

    const now = clock.now();
    const beforePayload = {
      schema_version: 1,
      original_text: event.original_text,
      redacted_text: event.redacted_text,
      spans_redacted: event.spans_redacted,
      detector_kinds: [...event.detector_kinds],
      stage: event.stage,
      audit_event_id_basis: auditEventId,
    };
    // Encrypt via the AAD-bound codec so the AAD `audit.audit_events.before` matches the ORM/canonical
    // read path byte-for-byte (kms2: ASCII bytes into the bytea column).
    const encBefore = encryptAuditJsonBytea(beforePayload, AUDIT_BEFORE_AAD);

    await client.query(
      "INSERT INTO audit.audit_events " +
        "(audit_event_id, installation_id, actor_kind, actor_id, " +
        " action, target_kind, target_id, before, after, created_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        auditEventId,
        event.installation_id,
        "system",
        null,
        "output_safety.sanitized",
        "llm_completion",
        event.request_id,
        encBefore,
        null, // after is NULL — sanitization is a one-way transform
        now,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK best-effort; surface the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}
