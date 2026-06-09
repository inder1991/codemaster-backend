// ─────────────────────────────────────────────────────────────────────────────
// de-Temporal SPIKE v2 — the production failure modes the reviewer flagged.
//
// Proves the LAYERED defense that lease-expiry-alone does NOT give you:
//   #3 FENCING        — a worker whose lease was stolen cannot corrupt state.
//                       Completion is gated on (lease_owner, attempt_token).
//   #4 HEARTBEAT      — a legitimately-long step extends its lease and is NOT stolen.
//   #5 IDEMPOTENCY    — even when a step body runs twice (steal), the external
//                       side effect (the "LLM call") happens exactly once.
//
// Scenario: 4 review_chunk jobs.
//   chunk[0] = slow + NO heartbeat  → lease expires → STOLEN by another worker.
//              fencing must keep completed_chunks correct; idempotency must keep
//              the external effect single, even though the body ran twice.
//   chunk[1] = slow + WITH heartbeat → lease kept alive → NOT stolen (runs once).
//   chunk[2,3] = normal.
//
// Run:  node /Users/ascoe/Projects/dtemporal-spike/spike2.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire("/Users/ascoe/Projects/codemaster-backend/package.json");
const { Pool } = require("pg");

const DSN = process.env.CODEMASTER_PG_CORE_DSN ?? "postgresql://postgres:devpass@localhost:5439/postgres";
const pool = new Pool({ connectionString: DSN, max: 10 });

const N_WORKERS = 3, N_CHUNKS = 4;
const LEASE_MS = 500, HB_MS = 180, SLOW_MS = 1400, FAST_MS = 120, POLL_MS = 90;
const INJECT = { 0: "slow_no_hb", 1: "slow_with_hb", 2: "normal", 3: "normal" };

const T0 = Date.now();
const ts = () => `+${String(Date.now() - T0).padStart(5, " ")}ms`;
const log = (w, m) => console.log(`${ts()}  ${w.padEnd(9)}  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FenceLost extends Error {}

async function setup() {
  await pool.query(`DROP SCHEMA IF EXISTS spike2 CASCADE; CREATE SCHEMA spike2`);
  await pool.query(`
    CREATE TABLE spike2.workflow_run (
      review_id uuid PRIMARY KEY, state text NOT NULL,
      total_chunks int, completed_chunks int NOT NULL DEFAULT 0);
    CREATE TABLE spike2.jobs (
      id bigserial PRIMARY KEY, review_id uuid NOT NULL, step_type text NOT NULL, chunk_index int,
      state text NOT NULL DEFAULT 'ready', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
      lease_owner text, attempt_token uuid, leased_until timestamptz, heartbeat_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX uq2_singleton ON spike2.jobs (review_id, step_type) WHERE step_type='aggregate';
    CREATE UNIQUE INDEX uq2_chunk ON spike2.jobs (review_id, chunk_index) WHERE step_type='review_chunk';
    -- the external-side-effect idempotency ledger (stands in for the ADR-0068 LLM ledger / GitHub keys)
    CREATE TABLE spike2.side_effects (idem_key text PRIMARY KEY, label text, created_at timestamptz DEFAULT now());
    -- audit of how many times a step BODY actually executed (to expose double-execution under steal)
    CREATE TABLE spike2.executions (id bigserial PRIMARY KEY, chunk_index int, worker text, token uuid, at timestamptz DEFAULT now());
  `);
}

// claim: mints a FRESH attempt_token + lease_owner. A reclaimed (lease-expired) job gets a NEW token,
// which is precisely what invalidates the previous owner's writes.
async function claim(worker) {
  const { rows } = await pool.query(
    `UPDATE spike2.jobs SET state='leased', lease_owner=$2, attempt_token=gen_random_uuid(),
            leased_until=now() + ($1||' ms')::interval, heartbeat_at=now(), attempts=attempts+1
       WHERE id=(SELECT id FROM spike2.jobs
                  WHERE (state='ready'  AND run_after<=now())
                     OR (state='leased' AND leased_until<now())     -- expired lease ⇒ steal-able
                  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`, [LEASE_MS, worker]);
  return rows[0] ?? null;
}

// FENCED completion: the mark-done only affects the row if THIS worker still owns the exact lease.
async function fencedHandoff(job, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `UPDATE spike2.jobs SET state='done'
         WHERE id=$1 AND state='leased' AND lease_owner=$2 AND attempt_token=$3`,
      [job.id, job.lease_owner, job.attempt_token]);
    if (r.rowCount !== 1) { await c.query("ROLLBACK"); throw new FenceLost(); } // lease was stolen
    await fn(c);                                                                 // next-step writes, same txn
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

// heartbeat: extend the lease, but ONLY while we still own it (token match). Returns false if stolen.
async function heartbeat(job) {
  const r = await pool.query(
    `UPDATE spike2.jobs SET leased_until=now()+($1||' ms')::interval, heartbeat_at=now()
       WHERE id=$2 AND lease_owner=$3 AND attempt_token=$4 AND state='leased'`,
    [LEASE_MS, job.id, job.lease_owner, job.attempt_token]);
  return r.rowCount === 1;
}
function startHeartbeat(job, worker) {
  let alive = true;
  (async () => { while (alive) { await sleep(HB_MS); if (!alive) break; const ok = await heartbeat(job); if (ok) log(worker, `   ♥ heartbeat chunk[${job.chunk_index}] (lease extended)`); } })();
  return () => { alive = false; };
}

// idempotent external effect: returns true the FIRST time a key is seen, false (suppressed) after.
async function doEffect(key, label) {
  const r = await pool.query(
    `INSERT INTO spike2.side_effects (idem_key, label) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING idem_key`,
    [key, label]);
  return r.rowCount === 1;
}

async function runChunk(job, worker) {
  await pool.query(`INSERT INTO spike2.executions (chunk_index, worker, token) VALUES ($1,$2,$3)`,
    [job.chunk_index, worker, job.attempt_token]);
  const mode = job.attempts === 1 ? INJECT[job.chunk_index] : "normal"; // injection only on the first attempt
  let stopHb = () => {};
  if (mode === "slow_no_hb")   log(worker, `🐢 chunk[${job.chunk_index}] slow, NO heartbeat (lease will expire → steal)`);
  if (mode === "slow_with_hb") { log(worker, `🐢 chunk[${job.chunk_index}] slow, WITH heartbeat (should NOT be stolen)`); stopHb = startHeartbeat(job, worker); }
  await sleep(mode.startsWith("slow") ? SLOW_MS : FAST_MS);
  stopHb();

  // the "external LLM call" — idempotent on a deterministic key (chunk id)
  const real = await doEffect(`chunk:${job.review_id}:${job.chunk_index}`, `review_chunk_${job.chunk_index}`);
  log(worker, `   ${real ? "🔮 LLM call EXECUTED" : "🔁 LLM call SUPPRESSED (idempotent)"} chunk[${job.chunk_index}]`);

  try {
    await fencedHandoff(job, async (c) => {
      const { rows } = await c.query(
        `UPDATE spike2.workflow_run SET completed_chunks=completed_chunks+1 WHERE review_id=$1
           RETURNING completed_chunks, total_chunks`, [job.review_id]);
      const { completed_chunks: done, total_chunks: total } = rows[0];
      log(worker, `✅ chunk[${job.chunk_index}] completed & counted (${done}/${total})`);
      if (done === total) {
        await c.query(`INSERT INTO spike2.jobs (review_id, step_type) VALUES ($1,'aggregate') ON CONFLICT DO NOTHING`, [job.review_id]);
        await c.query(`UPDATE spike2.workflow_run SET state='done' WHERE review_id=$1`, [job.review_id]);
      }
    });
  } catch (e) {
    if (e instanceof FenceLost) { log(worker, `🚧 chunk[${job.chunk_index}] FENCED OUT — lease was stolen, completion discarded (no double count)`); return; }
    throw e;
  }
}

async function worker(name, done) {
  while (!done()) {
    const job = await claim(name);
    if (!job) { await sleep(POLL_MS); continue; }
    try { await runChunk(job, name); } catch (e) { log(name, `error: ${e.message}`); }
  }
}

async function main() {
  await setup();
  const review = randomUUID();
  await pool.query(`INSERT INTO spike2.workflow_run (review_id, state, total_chunks) VALUES ($1,'reviewing_chunks',$2)`, [review, N_CHUNKS]);
  for (let i = 0; i < N_CHUNKS; i++)
    await pool.query(`INSERT INTO spike2.jobs (review_id, step_type, chunk_index) VALUES ($1,'review_chunk',$2)`, [review, i]);
  console.log(`\n  ${N_CHUNKS} chunks, ${N_WORKERS} workers, lease=${LEASE_MS}ms. chunk[0]=steal, chunk[1]=heartbeat.\n`);

  let fin = false;
  const workers = Array.from({ length: N_WORKERS }, (_, i) => worker(`worker-${i + 1}`, () => fin));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`SELECT state FROM spike2.workflow_run WHERE review_id=$1`, [review]);
    if (rows[0].state === "done") break; await sleep(70);
  }
  fin = true; await Promise.all(workers);

  console.log(`\n  ── verification ───────────────────────────────────────────`);
  const run = (await pool.query(`SELECT * FROM spike2.workflow_run WHERE review_id=$1`, [review])).rows[0];
  const effects = (await pool.query(`SELECT count(*)::int n FROM spike2.side_effects`)).rows[0].n;
  const ex = (await pool.query(`SELECT chunk_index, count(*)::int n FROM spike2.executions GROUP BY chunk_index ORDER BY chunk_index`)).rows;
  const aggs = (await pool.query(`SELECT count(*)::int n FROM spike2.jobs WHERE review_id=$1 AND step_type='aggregate'`, [review])).rows[0].n;
  const exMap = Object.fromEntries(ex.map((r) => [r.chunk_index, r.n]));

  const checks = [
    [`completed_chunks == total (${run.completed_chunks}/${run.total_chunks}) — FENCING held under steal`, run.completed_chunks === N_CHUNKS],
    [`exactly ${N_CHUNKS} external effects (1 per chunk) — IDEMPOTENCY held`, effects === N_CHUNKS],
    [`chunk[0] body executed ${exMap[0]}× (stolen) but counted once & effect once`, exMap[0] >= 2],
    [`chunk[1] body executed ${exMap[1]}× — HEARTBEAT prevented the steal`, exMap[1] === 1],
    [`exactly ONE aggregate job`, aggs === 1],
    [`run reached state=done`, run.state === "done"],
  ];
  let ok = true; for (const [l, p] of checks) { console.log(`  ${p ? "✅" : "❌"}  ${l}`); ok = ok && p; }
  console.log(`\n  ${ok ? "✅ SPIKE v2 PASSED — fencing + heartbeat + external idempotency under lease-steal." : "❌ FAILED"}\n`);
  await pool.end(); process.exit(ok ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
