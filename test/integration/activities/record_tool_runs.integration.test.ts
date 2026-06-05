import { createHash, randomInt } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { recordToolRuns } from "#backend/activities/record_tool_runs.activity.js";

import { disposeAllPools } from "#platform/db/database.js";

import { type RecordToolRunsInputV1 } from "#contracts/record_tool_runs_input.v1.js";
import { type ToolStatusV1 } from "#contracts/tool_status.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the `recordToolRuns` activity, against the DISPOSABLE Postgres
// (migrations applied; core.review_tool_runs present). Runs ONLY when CODEMASTER_PG_CORE_DSN is set
// (via describeDb); SKIPS otherwise so validate-fast stays green without a DB. NEVER touches any other
// DB. Each test uses a UNIQUE installation_id + run_id so rows never collide, and cleans up its own rows.
//
// The activity is the thin wrapper over `record_tool_runs` → ReviewToolRunsRepo.insertToolRun (one row
// per ToolStatusV1). 1:1 in intent with the frozen Python `@activity.defn record_tool_runs_activity`
// (vendor/codemaster-py/codemaster/review/arbitration_apply_activity.py +
// codemaster/review/arbitration_apply.py::record_tool_runs). THIS test proves the ACTIVITY composes the
// repo correctly end-to-end: typed input → one row per status in core.review_tool_runs → read back;
// the writes carry installation_id (tenancy); idempotent on (run_id, tool_name) via ON CONFLICT DO NOTHING.

let pool: Pool;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // The activity reads the DSN from process.env; mirror it so the activity's repo + this reader pool
  // both point at the disposable DB. Set unconditionally inside the gated block.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
});

afterAll(async () => {
  await pool?.end();
  // ADR-0062 teardown: end the activity-owned shared pool(s) via the central seam.
  await disposeAllPools();
});

/** Deterministic-enough UUID v4 for test fixtures (NOT security-sensitive; just unique-per-call). */
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

/** A small unique bigint so github_installation_id never collides across tests. */
function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

/** Seed only the FK target core.review_tool_runs needs (installation_id → core.installations). */
async function seedInstallation(installationId: string): Promise<void> {
  const ghInstall = uniqueBigint();
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, ghInstall, `acct-${ghInstall}`],
  );
}

/** Delete this tenant's tool-run rows then its installation (FK is ON DELETE RESTRICT). */
async function cleanup(installationId: string): Promise<void> {
  await pool.query(`DELETE FROM core.review_tool_runs WHERE installation_id = $1`, [installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [installationId]);
}

/** A complete ToolStatusV1 with every optional supplied (built via the contract shape). */
function toolStatus(overrides: Partial<ToolStatusV1> = {}): ToolStatusV1 {
  return {
    schema_version: 1,
    tool_name: "ruff",
    status: "completed",
    files_scanned: 3,
    files_total: 5,
    started_at: "2099-03-04T05:06:07+00:00",
    finished_at: "2099-03-04T05:06:08+00:00",
    duration_ms: 1234,
    findings_produced: 2,
    error_class: null,
    error_message: null,
    ...overrides,
  };
}

/** Build the single typed input envelope the activity takes (CLAUDE.md invariant 11). */
function input(args: {
  installationId: string;
  runId: string;
  reviewId: string;
  toolStatuses: ReadonlyArray<ToolStatusV1>;
}): RecordToolRunsInputV1 {
  return {
    schema_version: 1,
    installation_id: args.installationId,
    run_id: args.runId,
    review_id: args.reviewId,
    tool_statuses: [...args.toolStatuses],
  };
}

type ToolRunRow = {
  tool_name: string;
  status: string;
  files_scanned: number;
  files_total: number;
  duration_ms: number;
  findings_produced: number;
  error_class: string | null;
  error_message: string | null;
  installation_id: string;
  review_id: string;
};

async function readRuns(installationId: string, runId: string): Promise<ReadonlyArray<ToolRunRow>> {
  const r = await pool.query<ToolRunRow>(
    `SELECT tool_name, status, files_scanned, files_total, duration_ms, findings_produced,
            error_class, error_message, installation_id::text AS installation_id,
            review_id::text AS review_id
       FROM core.review_tool_runs
      WHERE installation_id = $1 AND run_id = $2
      ORDER BY tool_name`,
    [installationId, runId],
  );
  return r.rows;
}

describeDb("recordToolRuns activity (integration, disposable PG)", () => {
  it("persists one row per ToolStatusV1; the rows carry installation_id + review_id (tenancy)", async () => {
    const installationId = newUuid();
    const runId = newUuid();
    const reviewId = newUuid();
    try {
      await seedInstallation(installationId);

      const statuses = [
        toolStatus({ tool_name: "ruff", status: "completed" }),
        toolStatus({
          tool_name: "mypy",
          status: "timed_out",
          files_scanned: 0,
          files_total: 0,
          finished_at: null,
          findings_produced: 0,
          error_class: "TimeoutError",
          error_message: "exceeded wall clock",
        }),
      ];

      const result = await recordToolRuns(input({ installationId, runId, reviewId, toolStatuses: statuses }));
      expect(result).toBeUndefined(); // activity returns void (Python returns None)

      const rows = await readRuns(installationId, runId);
      expect(rows.map((r) => r.tool_name)).toEqual(["mypy", "ruff"]);

      const ruff = rows.find((r) => r.tool_name === "ruff")!;
      expect(ruff.status).toBe("completed");
      expect(ruff.files_scanned).toBe(3);
      expect(ruff.files_total).toBe(5);
      expect(ruff.duration_ms).toBe(1234);
      expect(ruff.findings_produced).toBe(2);
      expect(ruff.error_class).toBeNull();
      expect(ruff.installation_id).toBe(installationId); // tenancy column persisted
      expect(ruff.review_id).toBe(reviewId);

      const mypy = rows.find((r) => r.tool_name === "mypy")!;
      expect(mypy.status).toBe("timed_out");
      expect(mypy.error_class).toBe("TimeoutError");
      expect(mypy.error_message).toBe("exceeded wall clock");
    } finally {
      await cleanup(installationId);
    }
  });

  it("is idempotent on (run_id, tool_name) — a Temporal-retry double-call yields no row drift", async () => {
    const installationId = newUuid();
    const runId = newUuid();
    const reviewId = newUuid();
    try {
      await seedInstallation(installationId);
      const statuses = [toolStatus({ tool_name: "ruff" }), toolStatus({ tool_name: "bandit" })];

      await recordToolRuns(input({ installationId, runId, reviewId, toolStatuses: statuses }));
      // Second call with a DIFFERENT findings_produced — ON CONFLICT DO NOTHING keeps the FIRST row.
      const replayed = [
        toolStatus({ tool_name: "ruff", findings_produced: 999 }),
        toolStatus({ tool_name: "bandit", findings_produced: 999 }),
      ];
      await recordToolRuns(input({ installationId, runId, reviewId, toolStatuses: replayed }));

      const rows = await readRuns(installationId, runId);
      expect(rows.length).toBe(2); // exactly two rows; the retry did not duplicate
      // The original values won (DO NOTHING — not DO UPDATE).
      expect(rows.every((r) => r.findings_produced === 2)).toBe(true);
    } finally {
      await cleanup(installationId);
    }
  });

  it("an empty tool_statuses tuple writes no rows (the per-status loop has nothing to do)", async () => {
    const installationId = newUuid();
    const runId = newUuid();
    const reviewId = newUuid();
    try {
      await seedInstallation(installationId);
      await recordToolRuns(input({ installationId, runId, reviewId, toolStatuses: [] }));
      const rows = await readRuns(installationId, runId);
      expect(rows.length).toBe(0);
    } finally {
      await cleanup(installationId);
    }
  });

  it("tenant isolation: two installations sharing a tool_name on distinct runs each get their own row", async () => {
    const a = newUuid();
    const b = newUuid();
    const runA = newUuid();
    const runB = newUuid();
    const reviewId = newUuid();
    try {
      await seedInstallation(a);
      await seedInstallation(b);
      await recordToolRuns(
        input({ installationId: a, runId: runA, reviewId, toolStatuses: [toolStatus({ tool_name: "ruff" })] }),
      );
      await recordToolRuns(
        input({ installationId: b, runId: runB, reviewId, toolStatuses: [toolStatus({ tool_name: "ruff" })] }),
      );

      const aRows = await readRuns(a, runA);
      const bRows = await readRuns(b, runB);
      expect(aRows.length).toBe(1);
      expect(bRows.length).toBe(1);
      expect(aRows[0]?.installation_id).toBe(a);
      expect(bRows[0]?.installation_id).toBe(b);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });
});
