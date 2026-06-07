/**
 * Integration test for `emitOutputSafetyAuditEvent` — 1:1 port of the frozen Python
 * codemaster/activities/emit_output_safety_audit.py::emit_output_safety_audit_event_activity. Runs
 * against a DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the
 * in-cluster DB). Runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb); SKIPS otherwise.
 *
 * Coverage (the activity's observable behaviour):
 *   - an output-safety event writes ONE audit row with action='output_safety.sanitized',
 *     actor_kind='system', target_kind='llm_completion', target_id=request_id, after IS NULL.
 *   - the audit_event_id is the DETERMINISTIC uuid5 of (request_id|kinds_sorted|spans|stage).
 *   - a second invocation for the SAME event is an idempotent no-op (still exactly one row).
 *   - the `before` column is stored UNENCRYPTED as a `plain:v1:` payload (ADR-0070 — owner decision):
 *     it round-trips via decryptAuditJsonBytea (plaintext fallback) AND the raw bytes carry the cleartext
 *     secret, written even though a key IS installed (C is unconditional, not a fallback).
 *   - detector_kinds order does NOT change the id (the derivation sorts them).
 */
import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { emitOutputSafetyAuditEvent } from "#backend/activities/emit_output_safety_audit.activity.js";

import {
  AUDIT_BEFORE_AAD,
  decryptAuditJsonBytea,
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { getPool, disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;

if (INTEGRATION_DSN) {
  pool = getPool(INTEGRATION_DSN);
}

/** Install a deterministic dev key registry so encrypt/decrypt have a key without needing Vault. */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

/** Deterministic-but-unique v4 UUID for fixtures. */
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

/** Seed the installation row the audit FK / tenancy needs. */
async function seedInstallation(installationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, randomInt(1, 2_000_000_000), `acct-${installationId.slice(0, 8)}`],
  );
}

async function cleanup(installationId: string): Promise<void> {
  await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
}

type AuditRow = {
  audit_event_id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target_kind: string;
  target_id: string | null;
  before: Buffer | null;
  after: Buffer | null;
};

async function fetchRows(installationId: string): Promise<ReadonlyArray<AuditRow>> {
  const r = await pool.query<AuditRow>(
    `SELECT audit_event_id, actor_kind, actor_id, action, target_kind, target_id, before, after
       FROM audit.audit_events WHERE installation_id = $1`,
    [installationId],
  );
  return r.rows;
}

function buildEvent(installationId: string, requestId: string, kinds: ReadonlyArray<string>): {
  schema_version: number;
  installation_id: string;
  request_id: string;
  original_text: string;
  redacted_text: string;
  spans_redacted: number;
  detector_kinds: ReadonlyArray<string>;
  stage: string;
} {
  return {
    schema_version: 1,
    installation_id: installationId,
    request_id: requestId,
    original_text: "sk-SECRET-leaked in the model preamble café 😀",
    redacted_text: "sk-[REDACTED] in the model preamble café 😀",
    spans_redacted: 1,
    detector_kinds: kinds,
    stage: "review_chunk",
  };
}

describeDb("emitOutputSafetyAuditEvent (integration, disposable PG)", () => {
  it("writes ONE audit row; before is stored UNENCRYPTED (plain:v1: cleartext) per ADR-0070", async () => {
    const installationId = newUuid();
    const requestId = newUuid();
    await seedInstallation(installationId);
    try {
      await emitOutputSafetyAuditEvent({
        event: buildEvent(installationId, requestId, ["secret_leaked", "aws_access_key"]),
      });
      const rows = await fetchRows(installationId);
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.actor_kind).toBe("system");
      expect(row.actor_id).toBeNull();
      expect(row.action).toBe("output_safety.sanitized");
      expect(row.target_kind).toBe("llm_completion");
      expect(row.target_id).toBe(requestId);
      expect(row.after).toBeNull(); // sanitization is a one-way transform

      // ADR-0070: `before` is stored UNENCRYPTED. A key IS installed (beforeAll), yet the row is still
      // plain:v1: cleartext — proving C is unconditional, and the detected secret sits in cleartext.
      const rawBefore = Buffer.from(row.before!).toString("ascii");
      expect(rawBefore.startsWith("plain:v1:")).toBe(true);
      expect(rawBefore).toContain("sk-SECRET-leaked");

      // The `before` payload round-trips via the plaintext fallback in decryptAuditJsonBytea.
      const before = decryptAuditJsonBytea(row.before, AUDIT_BEFORE_AAD) as Record<string, unknown>;
      expect(before.original_text).toBe("sk-SECRET-leaked in the model preamble café 😀");
      expect(before.redacted_text).toBe("sk-[REDACTED] in the model preamble café 😀");
      expect(before.spans_redacted).toBe(1);
      expect(before.detector_kinds).toEqual(["secret_leaked", "aws_access_key"]);
      expect(before.stage).toBe("review_chunk");
      expect(before.audit_event_id_basis).toBe(row.audit_event_id);
    } finally {
      await cleanup(installationId);
    }
  });

  it("derives the audit_event_id deterministically (matches the frozen Python uuid5)", async () => {
    // Fixed inputs whose Python uuid5 is precomputed against the frozen ref:
    //   _NAMESPACE_OUTPUT_SAFETY = fa01b6f4-9e2c-4d8f-b3a0-7f1e8c2a5b39
    //   name = "<request_id>|<kinds_sorted>|<spans>|<stage>"
    const installationId = "33333333-3333-4333-8333-333333333333";
    const requestId = "22222222-2222-4222-8222-222222222222";
    await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [installationId]);
    await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
    await seedInstallation(installationId);
    try {
      await emitOutputSafetyAuditEvent({
        event: {
          schema_version: 1,
          installation_id: installationId,
          request_id: requestId,
          original_text: "sk-SECRET-leaked-here",
          redacted_text: "sk-[REDACTED]",
          spans_redacted: 1,
          detector_kinds: ["secret_leaked", "b_kind"],
          stage: "review_chunk",
        },
      });
      const rows = await fetchRows(installationId);
      expect(rows.length).toBe(1);
      // Precomputed via the frozen Python `_derive_audit_event_id`.
      expect(rows[0]!.audit_event_id).toBe("2ad4e676-f544-5ef4-8d6f-131458cc0cc0");
    } finally {
      await cleanup(installationId);
    }
  });

  it("is idempotent — a 2nd invocation for the same event is a no-op (still one row)", async () => {
    const installationId = newUuid();
    const requestId = newUuid();
    await seedInstallation(installationId);
    try {
      const event = buildEvent(installationId, requestId, ["secret_leaked"]);
      await emitOutputSafetyAuditEvent({ event });
      await emitOutputSafetyAuditEvent({ event });
      const rows = await fetchRows(installationId);
      expect(rows.length).toBe(1);
    } finally {
      await cleanup(installationId);
    }
  });

  it("detector_kinds order does NOT change the deterministic id (the derivation sorts them)", async () => {
    const installationId = newUuid();
    const requestId = newUuid();
    await seedInstallation(installationId);
    try {
      // Two emits with the SAME logical event but kinds in different order → same id → one row.
      await emitOutputSafetyAuditEvent({
        event: buildEvent(installationId, requestId, ["secret_leaked", "aws_access_key"]),
      });
      await emitOutputSafetyAuditEvent({
        event: buildEvent(installationId, requestId, ["aws_access_key", "secret_leaked"]),
      });
      const rows = await fetchRows(installationId);
      expect(rows.length).toBe(1);
    } finally {
      await cleanup(installationId);
    }
  });

});
