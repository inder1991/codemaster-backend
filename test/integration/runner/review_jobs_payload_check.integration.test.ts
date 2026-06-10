// F7 (review remediation): core.review_jobs must protect its payload-store columns with DB CHECK
// constraints, not app validation alone — a manual edit or a future migration must not be able to write
// a job_payload_schema_version other than the storage-envelope version (=1, JOB_PAYLOAD_SCHEMA_VERSION)
// or a payload_sha256 that is not 64 lowercase hex chars (the sha256hex output shape).
//
// Migration 0038_review_jobs_payload_check.sql adds:
//   CHECK (job_payload_schema_version = 1)            -- ck_review_jobs_payload_schema_version
//   CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')         -- ck_review_jobs_payload_sha256_hex
import { afterAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { seedRun } from "./_fixtures.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });

// A valid sha256hex output: exactly 64 lowercase hex chars.
const VALID_SHA = "a".repeat(64);

/**
 * Direct INSERT into core.review_jobs that BYPASSES ReviewJobsRepo.enqueue (which is where the app
 * validation lives) — this is exactly the "manual edit / future migration" threat the DB CHECKs defend
 * against. installation_id is listed ⇒ the raw-SQL tenancy gate escape hatch (a) is satisfied.
 */
async function rawInsertJob(
  ids: { runId: string; reviewId: string; installationId: string },
  opts: { schemaVersion: number; sha256: string },
): Promise<void> {
  await sql`INSERT INTO core.review_jobs
      (job_id, run_id, review_id, installation_id, job_payload_schema_version, payload, payload_sha256)
    VALUES (${randomUUID()}, ${ids.runId}, ${ids.reviewId}, ${ids.installationId},
      ${opts.schemaVersion}, CAST(${"{}"} AS jsonb), ${opts.sha256})`.execute(db);
}

describeDb("core.review_jobs payload-store CHECK constraints (F7)", () => {
  it("(a) ACCEPTS a valid row: job_payload_schema_version=1 + 64-hex payload_sha256", async () => {
    const ids = await seedRun(db);
    await expect(
      rawInsertJob(ids, { schemaVersion: 1, sha256: VALID_SHA }),
    ).resolves.toBeUndefined();
  });

  it("(b) REJECTS job_payload_schema_version != 1 (the storage-envelope version CHECK)", async () => {
    const ids = await seedRun(db);
    await expect(
      rawInsertJob(ids, { schemaVersion: 2, sha256: VALID_SHA }),
    ).rejects.toThrow(/ck_review_jobs_payload_schema_version|check constraint/i);
  });

  it("(c) REJECTS a payload_sha256 that is not 64 lowercase hex chars", async () => {
    const ids = await seedRun(db);
    // too short
    await expect(
      rawInsertJob(ids, { schemaVersion: 1, sha256: "deadbeef" }),
    ).rejects.toThrow(/ck_review_jobs_payload_sha256_hex|check constraint/i);
    // uppercase hex (sha256hex emits LOWERCASE only)
    await expect(
      rawInsertJob(ids, { schemaVersion: 1, sha256: "A".repeat(64) }),
    ).rejects.toThrow(/ck_review_jobs_payload_sha256_hex|check constraint/i);
    // 64 chars but contains a non-hex char
    await expect(
      rawInsertJob(ids, { schemaVersion: 1, sha256: "g".repeat(64) }),
    ).rejects.toThrow(/ck_review_jobs_payload_sha256_hex|check constraint/i);
  });
});

// `describe` is imported so the file does not get flagged when the DSN is absent (suite skips).
void describe;
