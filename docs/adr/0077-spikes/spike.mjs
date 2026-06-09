// ─────────────────────────────────────────────────────────────────────────────
// de-Temporal SPIKE — durable review pipeline on plain Postgres (no Temporal)
//
// Demonstrates the workflow_run / jobs / workers model:
//   • workflow_run = the parent PR-review ticket (state + progress only, NO lease)
//   • jobs         = individual checklist items (lease/attempts/retry live HERE)
//   • workers      = processes that claim JOB ROWS (not the whole review)
//
// Pipeline:  clone → classify → chunk_and_redact → review_chunk × N (parallel) → aggregate
//
// Proves the 4 hard properties:
//   1. Atomic hand-off     — "mark step done" + "enqueue next step" commit together
//   2. Race-safe fan-in    — exactly one aggregate job is created when the last chunk lands
//   3. Crash recovery       — a worker that dies mid-step leaves the job leased;
//                             the lease expires and another worker resumes it
//   4. Real parallelism    — multiple workers run different chunks at the same time
//
// Run:  node /Users/ascoe/Projects/dtemporal-spike/spike.mjs
// Throwaway: lives in its own `spike` schema on the disposable PG (:5439).
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire("/Users/ascoe/Projects/codemaster-backend/package.json");
const { Pool } = require("pg");

const DSN = process.env.CODEMASTER_PG_CORE_DSN ?? "postgresql://postgres:devpass@localhost:5439/postgres";
const pool = new Pool({ connectionString: DSN, max: 8 });

const N_WORKERS = 3;        // concurrent worker processes (simulated as async loops)
const N_CHUNKS = 6;         // the chunk_and_redact step fans out into this many review_chunk jobs
const LEASE_MS = 1000;      // how long a worker "owns" a claimed job before it can be reclaimed
const POLL_MS = 120;        // idle poll interval
const STEP_WORK_MS = 150;   // simulated work per step

const T0 = Date.now();
const ts = () => `+${String(Date.now() - T0).padStart(5, " ")}ms`;
const log = (w, msg) => console.log(`${ts()}  ${w.padEnd(9)}  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A "hard crash": the worker dies WITHOUT recording failure — so the job stays leased
// and recovery happens purely via lease expiry (the realistic crash path).
class HardCrash extends Error {}
let CRASH_ARMED = true; // fire exactly once, on the clone step's first attempt

// ── schema ───────────────────────────────────────────────────────────────────
async function setup() {
  await pool.query(`DROP SCHEMA IF EXISTS spike CASCADE`);
  await pool.query(`CREATE SCHEMA spike`);
  await pool.query(`
    CREATE TABLE spike.workflow_run (              -- the PARENT ticket: state/context only
      review_id        uuid PRIMARY KEY,
      state            text NOT NULL,              -- cloning|classifying|chunking|reviewing_chunks|aggregating|done
      total_chunks     int,
      completed_chunks int  NOT NULL DEFAULT 0,
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE spike.jobs (                       -- the CHILD work items: lease/retry live here
      id           bigserial PRIMARY KEY,
      review_id    uuid NOT NULL REFERENCES spike.workflow_run(review_id),
      step_type    text NOT NULL,                  -- clone|classify|chunk_and_redact|review_chunk|aggregate
      chunk_index  int,                            -- only for review_chunk
      state        text NOT NULL DEFAULT 'ready',  -- ready|leased|done|dead
      attempts     int  NOT NULL DEFAULT 0,
      max_attempts int  NOT NULL DEFAULT 5,
      leased_until timestamptz,
      run_after    timestamptz NOT NULL DEFAULT now(),
      last_error   text
    );
    -- Race-safe fan-in backstop: at most ONE clone/classify/chunk/aggregate job per review.
    CREATE UNIQUE INDEX uq_singleton ON spike.jobs (review_id, step_type)
      WHERE step_type IN ('clone','classify','chunk_and_redact','aggregate');
    -- review_chunk: exactly one job per (review, chunk_index).
    CREATE UNIQUE INDEX uq_chunk ON spike.jobs (review_id, chunk_index)
      WHERE step_type = 'review_chunk';
    CREATE INDEX ix_claimable ON spike.jobs (run_after) WHERE state IN ('ready','leased');
  `);
}

// ── claim: take ONE job row (ready, or a leased one whose lease expired = crash recovery) ──
async function claim(worker) {
  const { rows } = await pool.query(
    `UPDATE spike.jobs SET state='leased',
            leased_until = now() + ($1 || ' milliseconds')::interval,
            attempts = attempts + 1
       WHERE id = (
         SELECT id FROM spike.jobs
          WHERE (state = 'ready'  AND run_after <= now())
             OR (state = 'leased' AND leased_until < now())   -- expired lease ⇒ reclaimable (crash recovery)
          ORDER BY id
          FOR UPDATE SKIP LOCKED                              -- two workers never grab the same job
          LIMIT 1)
     RETURNING *`,
    [LEASE_MS],
  );
  return rows[0] ?? null;
}

// ── the atomic hand-off helper: complete THIS job + do the next-step writes, in ONE txn ──
async function handoff(jobId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE spike.jobs SET state='done' WHERE id=$1`, [jobId]);
    await fn(client); // enqueue next job(s) / update parent — all inside the same transaction
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function markFailed(job, err) {
  const dead = job.attempts >= job.max_attempts;
  await pool.query(
    `UPDATE spike.jobs SET state=$2, last_error=$3,
            run_after = now() + ($4 || ' milliseconds')::interval, leased_until=NULL
       WHERE id=$1`,
    [job.id, dead ? "dead" : "ready", String(err).slice(0, 200), job.attempts * 200],
  );
}

// ── the step handlers ──────────────────────────────────────────────────────────
async function runStep(job, worker) {
  switch (job.step_type) {
    case "clone": {
      if (CRASH_ARMED && job.attempts === 1) {           // simulate a worker dying mid-clone
        CRASH_ARMED = false;
        log(worker, `🧬 clone: claimed (attempt 1) … 💥 SIMULATED HARD CRASH (job left leased)`);
        throw new HardCrash("kill -9 mid-clone");
      }
      await sleep(STEP_WORK_MS);
      await handoff(job.id, async (c) => {
        await c.query(`UPDATE spike.workflow_run SET state='classifying' WHERE review_id=$1`, [job.review_id]);
        await c.query(`INSERT INTO spike.jobs (review_id, step_type) VALUES ($1,'classify')`, [job.review_id]);
      });
      log(worker, `🧬 clone: done (attempt ${job.attempts}) → enqueued classify`);
      return;
    }
    case "classify": {
      await sleep(STEP_WORK_MS);
      await handoff(job.id, async (c) => {
        await c.query(`UPDATE spike.workflow_run SET state='chunking' WHERE review_id=$1`, [job.review_id]);
        await c.query(`INSERT INTO spike.jobs (review_id, step_type) VALUES ($1,'chunk_and_redact')`, [job.review_id]);
      });
      log(worker, `🏷  classify: done → enqueued chunk_and_redact`);
      return;
    }
    case "chunk_and_redact": {
      await sleep(STEP_WORK_MS);
      await handoff(job.id, async (c) => {
        await c.query(
          `UPDATE spike.workflow_run SET state='reviewing_chunks', total_chunks=$2 WHERE review_id=$1`,
          [job.review_id, N_CHUNKS],
        );
        for (let i = 0; i < N_CHUNKS; i++) {
          await c.query(
            `INSERT INTO spike.jobs (review_id, step_type, chunk_index) VALUES ($1,'review_chunk',$2)`,
            [job.review_id, i],
          );
        }
      });
      log(worker, `✂️  chunk_and_redact: done → fanned out ${N_CHUNKS} review_chunk jobs`);
      return;
    }
    case "review_chunk": {
      await sleep(STEP_WORK_MS + (job.chunk_index % 3) * 60); // vary so parallelism is visible
      await handoff(job.id, async (c) => {
        // Atomic increment locks the parent row → exactly ONE txn sees completed == total.
        const { rows } = await c.query(
          `UPDATE spike.workflow_run SET completed_chunks = completed_chunks + 1, updated_at=now()
             WHERE review_id=$1 RETURNING completed_chunks, total_chunks`,
          [job.review_id],
        );
        const { completed_chunks: done, total_chunks: total } = rows[0];
        log(worker, `🔍 review_chunk[${job.chunk_index}]: done   (${done}/${total} chunks)`);
        if (done === total) {
          // The race-safe creation of the single aggregate job. ON CONFLICT = belt & suspenders
          // on top of the row-lock guarantee above.
          await c.query(
            `INSERT INTO spike.jobs (review_id, step_type) VALUES ($1,'aggregate')
               ON CONFLICT (review_id, step_type) WHERE step_type IN ('clone','classify','chunk_and_redact','aggregate')
               DO NOTHING`,
            [job.review_id],
          );
          await c.query(`UPDATE spike.workflow_run SET state='aggregating' WHERE review_id=$1`, [job.review_id]);
          log(worker, `   ↳ last chunk landed → enqueued the single aggregate job`);
        }
      });
      return;
    }
    case "aggregate": {
      await sleep(STEP_WORK_MS);
      await handoff(job.id, async (c) => {
        await c.query(`UPDATE spike.workflow_run SET state='done', updated_at=now() WHERE review_id=$1`, [job.review_id]);
      });
      log(worker, `📦 aggregate: done → REVIEW COMPLETE ✅`);
      return;
    }
  }
}

// ── worker loop ────────────────────────────────────────────────────────────────
async function worker(name, isDone) {
  while (!isDone()) {
    const job = await claim(name);
    if (!job) { await sleep(POLL_MS); continue; }
    try {
      await runStep(job, name);
    } catch (e) {
      if (e instanceof HardCrash) {
        // Worker "died": do NOT release the job. Recovery is automatic via lease expiry.
        continue;
      }
      log(name, `⚠️  ${job.step_type}: failed → ${e.message} (will retry)`);
      await markFailed(job, e);
    }
  }
}

// ── driver ───────────────────────────────────────────────────────────────────
async function main() {
  await setup();
  const reviewId = randomUUID();

  // PR webhook arrives: create the parent ticket + the very first job.
  await pool.query(`INSERT INTO spike.workflow_run (review_id, state) VALUES ($1,'cloning')`, [reviewId]);
  await pool.query(`INSERT INTO spike.jobs (review_id, step_type) VALUES ($1,'clone')`, [reviewId]);
  console.log(`\n  PR webhook → workflow_run ${reviewId.slice(0, 8)}…  +  first job: clone`);
  console.log(`  Starting ${N_WORKERS} workers (lease=${LEASE_MS}ms). Watch worker IDs interleave.\n`);

  let finished = false;
  const isDone = () => finished;
  const workers = Array.from({ length: N_WORKERS }, (_, i) => worker(`worker-${i + 1}`, isDone));

  // Poll the PARENT for completion (the workers never block on it).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`SELECT state FROM spike.workflow_run WHERE review_id=$1`, [reviewId]);
    if (rows[0].state === "done") break;
    await sleep(80);
  }
  finished = true;
  await Promise.all(workers);

  // ── assertions: prove the 4 properties held ──
  console.log(`\n  ── verification ───────────────────────────────────────────`);
  const run = (await pool.query(`SELECT * FROM spike.workflow_run WHERE review_id=$1`, [reviewId])).rows[0];
  const jobs = (await pool.query(`SELECT step_type, chunk_index, state, attempts FROM spike.jobs WHERE review_id=$1 ORDER BY id`, [reviewId])).rows;
  const clone = jobs.find((j) => j.step_type === "clone");
  const aggregates = jobs.filter((j) => j.step_type === "aggregate");
  const chunks = jobs.filter((j) => j.step_type === "review_chunk");
  const notDone = jobs.filter((j) => j.state !== "done");

  const checks = [
    [`parent reached state=done`, run.state === "done"],
    [`completed_chunks == total_chunks (${run.completed_chunks}/${run.total_chunks})`, run.completed_chunks === run.total_chunks],
    [`clone recovered after crash (attempts=${clone.attempts} ≥ 2, completed once)`, clone.attempts >= 2 && clone.state === "done"],
    [`exactly ONE aggregate job (race-safe fan-in)`, aggregates.length === 1],
    [`all ${chunks.length} chunks done`, chunks.length === N_CHUNKS && chunks.every((c) => c.state === "done")],
    [`no jobs left ready/leased/dead`, notDone.length === 0],
  ];
  let ok = true;
  for (const [label, pass] of checks) { console.log(`  ${pass ? "✅" : "❌"}  ${label}`); ok = ok && pass; }
  console.log(`\n  ${ok ? "✅ SPIKE PASSED — durable, crash-safe, parallel review pipeline on plain Postgres." : "❌ SPIKE FAILED"}\n`);

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
