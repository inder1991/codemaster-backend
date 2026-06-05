/**
 * Integration test for the START-REVIEW GATE's audit-emit — the Stage-3 wire-through of the previously
 * deferred FOLLOW-UP-stage3-gate-audit-emit. 1:1 with the frozen Python
 * codemaster/activities/start_review_for_webhook.py, which emits an `audit.audit_events` row on every
 * branch via `bind_audit_context` + `emit_audit_event` on the SAME transaction as the tenancy re-check +
 * mutex acquire.
 *
 * Runs against the DISPOSABLE Postgres (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER
 * the in-cluster DB); SKIPS when CODEMASTER_PG_CORE_DSN is unset.
 *
 * Coverage (the audit rows the gate now writes, atomic with its decision):
 *   - accepted          → action='pr.accepted',              after={head_sha}.
 *   - skipped_disabled  → action='pr.skipped_disabled',      after={reason:'repository.enabled=false'}.
 *   - skipped_busy      → action='pr.skipped_busy',          after={holder_workflow_id}.
 *   - skipped_legacy    → action='pr.skipped_legacy_payload',after={schema_version_received, delivery_id}.
 *   - the encrypted `after` column round-trip-decrypts to the expected dict (AES-256-GCM + AAD).
 */
import { createHash, randomInt } from "node:crypto";

import { type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startReviewForWebhook } from "#backend/activities/start_review_for_webhook.activity.js";

import {
  AUDIT_AFTER_AAD,
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

beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

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

function newHeadSha(): string {
  return createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest("hex")
    .padEnd(40, "0")
    .slice(0, 40);
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  ghOwner: string;
  ghRepoName: string;
};

async function seedTenant(enabled: boolean): Promise<Seed> {
  const installationId = newUuid();
  const repositoryId = newUuid();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();
  const ghOwner = `org-${ghRepo}`;
  const ghRepoName = `repo-${ghRepo}`;
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', $5)`,
    [repositoryId, installationId, ghRepo, `${ghOwner}/${ghRepoName}`, enabled],
  );
  return { installationId, repositoryId, ghOwner, ghRepoName };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.audit_events WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.pr_review_mutex WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [seed.installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [seed.installationId]);
}

type AuditRow = { action: string; actor_kind: string; target_kind: string; target_id: string | null; after: Buffer | null };

async function fetchAudit(installationId: string): Promise<ReadonlyArray<AuditRow>> {
  const r = await pool.query<AuditRow>(
    `SELECT action, actor_kind, target_kind, target_id, after
       FROM audit.audit_events WHERE installation_id = $1`,
    [installationId],
  );
  return r.rows;
}

function buildPayloadDict(seed: Seed, prNumber: number, headSha: string): Record<string, unknown> {
  return {
    schema_version: 2,
    installation_id: seed.installationId,
    repository_id: seed.repositoryId,
    pr_id: newUuid(),
    pr_number: prNumber,
    head_sha: headSha,
    gh_owner: seed.ghOwner,
    gh_repo_name: seed.ghRepoName,
    pr_title: "Add a feature",
    pr_description: "Implements the thing.",
    delivery_id: `delivery-${prNumber}-${headSha.slice(0, 8)}`,
    policy_revision: 0,
    run_id: newUuid(),
    review_id: newUuid(),
  };
}

describeDb("startReviewForWebhook — Stage-3 gate audit-emit (integration, disposable PG)", () => {
  it("accepted → emits a single pr.accepted audit row with after={head_sha}", async () => {
    const seed = await seedTenant(true);
    const prNumber = 701;
    const headSha = newHeadSha();
    try {
      const res = await startReviewForWebhook(buildPayloadDict(seed, prNumber, headSha));
      expect(res.status).toBe("accepted");
      const rows = await fetchAudit(seed.installationId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.action).toBe("pr.accepted");
      expect(rows[0]!.actor_kind).toBe("system");
      expect(rows[0]!.target_kind).toBe("pull_request");
      expect(rows[0]!.target_id).toBe(String(prNumber));
      const after = decryptAuditJsonBytea(rows[0]!.after, AUDIT_AFTER_AAD) as Record<string, unknown>;
      expect(after).toEqual({ head_sha: headSha });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("skipped_disabled → emits a single pr.skipped_disabled audit row with after={reason}", async () => {
    const seed = await seedTenant(false);
    const prNumber = 702;
    try {
      const res = await startReviewForWebhook(buildPayloadDict(seed, prNumber, newHeadSha()));
      expect(res.status).toBe("skipped_disabled");
      const rows = await fetchAudit(seed.installationId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.action).toBe("pr.skipped_disabled");
      const after = decryptAuditJsonBytea(rows[0]!.after, AUDIT_AFTER_AAD) as Record<string, unknown>;
      expect(after).toEqual({ reason: "repository.enabled=false" });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("skipped_busy → emits a pr.skipped_busy audit row with after={holder_workflow_id}", async () => {
    const seed = await seedTenant(true);
    const prNumber = 703;
    const firstHeadSha = newHeadSha();
    try {
      const first = await startReviewForWebhook(buildPayloadDict(seed, prNumber, firstHeadSha));
      expect(first.status).toBe("accepted");
      const second = await startReviewForWebhook(buildPayloadDict(seed, prNumber, newHeadSha()));
      expect(second.status).toBe("skipped_busy");

      const rows = await fetchAudit(seed.installationId);
      // One pr.accepted (the first) + one pr.skipped_busy (the second).
      const byAction = new Map(rows.map((r) => [r.action, r]));
      expect(byAction.has("pr.accepted")).toBe(true);
      expect(byAction.has("pr.skipped_busy")).toBe(true);
      const busyAfter = decryptAuditJsonBytea(byAction.get("pr.skipped_busy")!.after, AUDIT_AFTER_AAD) as Record<string, unknown>;
      // The holder is the FIRST acquirer's holder_workflow_id.
      const expectedHolder = `ReviewPR-${seed.ghOwner}/${seed.ghRepoName}-${prNumber}-${firstHeadSha.slice(0, 8)}`;
      expect(busyAfter).toEqual({ holder_workflow_id: expectedHolder });
    } finally {
      await cleanupTenant(seed);
    }
  });

  it("skipped_legacy_payload → emits a pr.skipped_legacy_payload audit row with after={schema_version_received, delivery_id}", async () => {
    const seed = await seedTenant(true);
    const prNumber = 704;
    try {
      const legacy: Record<string, unknown> = {
        schema_version: 1,
        installation_id: seed.installationId,
        repository_id: seed.repositoryId,
        pr_number: prNumber,
        delivery_id: "legacy-delivery-704",
      };
      const res = await startReviewForWebhook(legacy);
      expect(res.status).toBe("skipped_legacy_payload");
      const rows = await fetchAudit(seed.installationId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.action).toBe("pr.skipped_legacy_payload");
      const after = decryptAuditJsonBytea(rows[0]!.after, AUDIT_AFTER_AAD) as Record<string, unknown>;
      expect(after).toEqual({ schema_version_received: 1, delivery_id: "legacy-delivery-704" });
    } finally {
      await cleanupTenant(seed);
    }
  });
});
