export const meta = {
  name: 'phase2-stale-write-guard',
  description: 'Phase 2.1 HARD gate (finding #1): AD-4 stale-write guard + emit_workflow_event re-threaded into persistAggregated (FINDINGS_PERSISTED milestone) — blocks 2.5 dual-run',
  phases: [
    { title: 'Port', detail: 'A1 _workflow_events_repository(emitWorkflowEvent) ; A2 stale_write_guard(assertCurrentRun)+post_commit_emit ; B re-thread persistAggregated' },
    { title: 'Verify', detail: 'adversarial 3-lens vs FROZEN PYTHON on the real PG: stale-write rejection (empirical savepoint ground truth), FINDINGS_PERSISTED idempotency, advisory-key + txn discipline' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const DSN = 'postgresql://postgres:postgres@localhost:5434/codemaster'
const SRC_GUARD = REPO + '/vendor/codemaster-py/codemaster/domain/stale_write_guard.py'
const SRC_WFE = REPO + '/vendor/codemaster-py/codemaster/ingest/_workflow_events_repository.py'
const SRC_PCE = REPO + '/vendor/codemaster-py/codemaster/infra/post_commit_emit.py'
const SRC_REPO = REPO + '/vendor/codemaster-py/codemaster/domain/repos/review_findings_repo.py'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = [
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths only. Bash cwd RESETS between commands — prefix EVERY command with (cd ' + REPO + ' && ...).',
  'TS STYLE (ENFORCED by validate-fast = gates -> lint -> typecheck -> test): ESM .js import specifiers; "type" alias not "interface"; Array<T> not T[]; NO "any" (use unknown + narrowing); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase methods/vars.',
  'IMPORTS: Node subpath aliases #contracts/* (libs/contracts/src), #platform/* (libs/platform/src), #backend/* (apps/backend/src/backend); same-dir relative ./x.js.',
  'SEAMS TO REUSE: #platform/clock.js (Clock: now(): Date, monotonic(): number, sleep; FakeClock). #platform/db/database.js (tenantKysely<T>(dsn) over the SHARED pool with TenancyPlugin; getPool; NEVER `new Pool` — the pool_memoization gate fails otherwise). #platform/observability/metrics.js (getMeter — for OTel counters; @opentelemetry/api no-op meter w/o provider so emission is always safe). Kysely transactions: `db.transaction().execute(async (tx) => {...})`; nested = SAVEPOINT (Kysely supports `tx.transaction().execute(...)` as a savepoint, OR raw sql`SAVEPOINT sp` / sql`RELEASE SAVEPOINT sp` / sql`ROLLBACK TO SAVEPOINT sp` on the tx).',
  'DATABASE: a DISPOSABLE Postgres is RUNNING with the squashed baseline migrated — DSN ' + DSN + ' (db codemaster; core.pull_request_reviews, core.review_runs, core.review_findings, audit.workflow_events[partitioned] all present). NEVER touch any other DB. Integration tests live under test/integration/** and use test/integration/_db.ts (describeDb / INTEGRATION_DSN) so they SKIP without CODEMASTER_PG_CORE_DSN. Seed FK parents per the existing test/integration/domain/repos/review_findings_repo.integration.test.ts pattern (installation -> repository -> gh_user -> pull_request), EXTENDED with a core.pull_request_reviews row (review_id, pr_id, installation_id, current_run_id, provider) and the core.review_runs row(s) the FKs require (audit.workflow_events.run_id -> core.review_runs.run_id RESTRICT; .review_id -> core.pull_request_reviews.review_id RESTRICT). Inspect the actual FK + NOT NULL columns via psql/information_schema before seeding.',
  'GATE: apps/** AND libs/**/src/** scanned by check_clock_random.ts (ERROR-mode) — time ONLY via the injected Clock. Raw SQL on tenant-scoped tables scanned by check_tenant_scoped_raw_sql.ts — carry installation_id OR a justified inline marker. NO NEW DEPS.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit. tools/parity/** holds TRACKED ref drivers — if you add a scratch driver there, remove ONLY your own file (never `rm -rf tools/parity`). The frozen Python is READ-ONLY at vendor/codemaster-py (venv at ' + PY + ').',
  'RUN BEFORE RETURNING (every one must pass; report all_green:false otherwise): (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN="' + DSN + '" npx vitest run <your test files>) ; (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean ; (cd ' + REPO + ' && npx eslint <your .ts files>) ; (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts) ; (cd ' + REPO + ' && npx tsx scripts/gates/check_tenant_scoped_raw_sql.ts). Also verify your integration test SKIPS cleanly with no DSN.',
].join('\n')

phase('Port')

const PORT_A1 = [
  'Port the workflow-events repository primitive 1:1 (Phase 2.1 stale-write gate, part A1 of 3) — the audit.workflow_events inserter the FINDINGS_PERSISTED milestone uses.',
  STYLE,
  'READ FULLY: ' + SRC_WFE + '. Port to ' + REPO + '/apps/backend/src/backend/ingest/_workflow_events_repository.ts:',
  '- WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE = 0x57424555 (export). EVENT_TYPES (the exact frozenset of valid event_type strings — port verbatim incl. FINDINGS_PERSISTED + STALE_WRITE_BLOCKED). ORPHAN_REASONS (the frozenset). BF3InstallationIdMissing error class.',
  '- runIdToLockKey(runId: string): number — EXACT port of _run_id_to_lock_key = int.from_bytes(run_id.bytes[:4], "big", signed=True). i.e. take the FIRST 4 bytes of the UUID (strip dashes, first 8 hex chars), read big-endian SIGNED int32: Buffer.from(uuidHex.replace(/-/g,"").slice(0,8), "hex").readInt32BE(0). Must be byte-identical to Python for any UUID.',
  '- emitWorkflowEvent({ db_or_tx, provider, runId, reviewId, eventType, payload?, deliveryId?, installationId?, clock? }): Promise<string> (returns the event_id uuid). The caller owns the transaction — this neither opens nor commits; it runs on the passed Kysely transaction handle (tx). Semantics 1:1: (1) requires an OPEN transaction — since it takes a `tx` (Kysely Transaction), that is structurally guaranteed; ALSO mirror the Python `session.in_transaction()` RuntimeError by accepting a tx handle only (document that calling on a non-tx Kysely is the analogue error). (2) eventType NOT in EVENT_TYPES -> throw (ValueError analogue). (3) BF-3 guard: installationId == null AND payload.orphan_reason NOT in ORPHAN_REASONS -> throw BF3InstallationIdMissing. (4) sequence_no = SELECT COALESCE(MAX(sequence_no),0)+1 FROM audit.workflow_events WHERE run_id = :rid (computed inside the tx; the uq_workflow_events_run_sequence UNIQUE catches concurrent races as a constraint error the caller handles). (5) INSERT one row (event_id=uuid4 via the platform randomness seam — NOT raw crypto; check how other code mints uuid4 under the gate, e.g. #platform randomness/uuid7 helper or SystemRandom; if a uuid4 seam does not exist, mint via the existing crypto seam used elsewhere, NEVER raw crypto.randomUUID which the gate bans), provider, delivery_id, run_id, review_id, sequence_no, event_type, payload(jsonb via CAST/json), received_at = clock.now(), installation_id). (6) return event_id.',
  'OBSERVABILITY: port the STALE/BF-3 OTel emits that ride with THIS function only if trivially available via #platform/observability/metrics getMeter; the 3 BF-3 orphan counters (record_bf3_installation_id_missing / record_bf3_orphan_emit / record_emit_workflow_event) belong to the Phase-3 orphan-retention subsystem — DEFER them with an explicit code comment + note in your return (they are NOT exercised by the persistAggregated/FINDINGS_PERSISTED path, which always passes installationId). Do NOT pull in run_id_retention.',
  'Integration test ' + REPO + '/test/integration/ingest/_workflow_events_repository.integration.test.ts (describeDb): seed the FK chain incl. core.review_runs + core.pull_request_reviews; assert emitWorkflowEvent inserts a row with sequence_no 1 then 2 (monotonic per run); unknown eventType -> throws; installationId null without orphan_reason -> BF3InstallationIdMissing; installationId null WITH a valid orphan_reason -> inserts; runIdToLockKey known-answer vector (compute the same value via ' + PY + ' -c importing codemaster.ingest._workflow_events_repository._run_id_to_lock_key for 3 UUIDs and assert equality). Unique installation_id per test; finally-cleanup; SKIPs without DSN.',
  'Return component="workflow_events_repo", files_written, commands, all_green, notes (EVENT_TYPES list, the uuid4 seam used, runIdToLockKey derivation, what BF-3 observability was deferred + why).',
].join('\n')

const portA1 = await agent(PORT_A1, { label: 'port:wfe-repo', phase: 'Port', schema: BUILD_SCHEMA })

const PORT_A2 = [
  'Port the AD-4 stale-write guard + the post-commit-emit helper 1:1 (Phase 2.1 stale-write gate, part A2 of 3).',
  STYLE,
  'A1 landed apps/backend/src/backend/ingest/_workflow_events_repository.ts: ' + JSON.stringify(portA1).slice(0, 350),
  'READ FULLY: ' + SRC_PCE + ' and ' + SRC_GUARD + '.',
  '1) post_commit_emit.ts -> ' + REPO + '/apps/backend/src/backend/infra/post_commit_emit.ts. Python emit_after_commit registers an after-commit listener that fires fn() only if the txn COMMITS and is DROPPED on rollback. Kysely has no event system, and `db.transaction().execute(fn)` resolves AFTER commit — so the TS equivalent is a small "pending emits" collector the caller drains AFTER the transaction resolves successfully. Implement: a PendingEmits class/closure (push(fn), drain() runs all, swallowing+logging any fn throw per the Python "must not raise" contract) that the caller creates, passes down, and drains after `.execute()` resolves; on a thrown/rolled-back transaction the caller simply NEVER drains -> fn dropped (matches the rollback-drops semantics). Export emitAfterCommit(pending, fn) + the PendingEmits primitive. Keep it tiny + documented.',
  '2) stale_write_guard.ts -> ' + REPO + '/apps/backend/src/backend/domain/stale_write_guard.ts. Port assertCurrentRun + StaleWriteError + the OTel counter. Signature: assertCurrentRun({ tx, runId, reviewId, site, pending, clock? }): Promise<void> where tx is the open Kysely Transaction (the open-txn requirement is structural; ALSO mirror the Python RuntimeError contract — document that a non-tx handle is the analogue). EXACT semantics 1:1: (a) SELECT current_run_id, provider FROM core.pull_request_reviews WHERE review_id = :rv FOR SHARE. (b) no row -> throw StaleWriteError(runId, reviewId, currentRunId=null, site, "...not found (orphan write)") WITHOUT any emit/telemetry. (c) current_run_id === runId -> return (happy). (d) mismatch (incl. current_run_id NULL): pg_advisory_xact_lock(WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE, runIdToLockKey(runId)) on the tx; SELECT COALESCE(MAX(sequence_no),0)+1 FROM audit.workflow_events WHERE run_id=:rid; INSERT a STALE_WRITE_BLOCKED row (event_id uuid4 via the SAME seam A1 used, provider from the row, delivery_id NULL, run_id, review_id, sequence_no, event_type STALE_WRITE_BLOCKED, payload = canonical JSON {"current":<str|null>,"incoming":<str>,"site":<str>} with SORTED keys + compact separators exactly like Python _json_dumps json.dumps(sort_keys=True, separators=(",",":")), received_at=clock.now()); FORCE the constraint check now (Kysely executes synchronously within the tx — no separate flush needed, but ensure the INSERT statement actually executes before proceeding); register the OTel counter codemaster_review_runs_stale_write_blocked_total{site} via emitAfterCommit(pending, () => counter.add(1,{site})); THEN throw StaleWriteError(runId, reviewId, currentRunId, site, "...does not match current_run_id..."). StaleWriteError carries runId/reviewId/currentRunId/site. Counter name + description verbatim from the Python.',
  'CRITICAL — do NOT guess the savepoint/rollback survival semantics. Port the STRUCTURE faithfully (the caller in part B wraps assertCurrentRun in a SAVEPOINT and releases on error); whether the STALE_WRITE_BLOCKED row survives the outer rollback is determined EMPIRICALLY by the verifier against the frozen Python. Your job is structural fidelity, not predicting the outcome.',
  'Integration test ' + REPO + '/test/integration/domain/stale_write_guard.integration.test.ts (describeDb): inside a tx + savepoint, seed a pull_request_reviews row with current_run_id = R; assertCurrentRun with runId=R -> resolves (happy); runId=R2 (!=R) -> throws StaleWriteError AND a STALE_WRITE_BLOCKED row is observable (query within the same tx before rollback) with the right payload; current_run_id NULL -> StaleWriteError; missing review_id -> StaleWriteError with NO workflow_events row; the counter fires only via pending.drain() after a (hypothetical) commit. Unique installation_id per test; cleanup; SKIP without DSN.',
  'Return component="stale_write_guard", files_written, commands, all_green, notes (the SAVEPOINT approach chosen for part B, the pending-emit drain design, payload canonical-JSON byte-format, the counter, any open question for the verifier to resolve empirically).',
].join('\n')

const portA2 = await agent(PORT_A2, { label: 'port:stale-guard', phase: 'Port', schema: BUILD_SCHEMA })

const PORT_B = [
  'Re-thread the AD-4 stale-write guard + the idempotent FINDINGS_PERSISTED milestone INTO persistAggregated (Phase 2.1 stale-write gate, part B of 3). This MODIFIES the already-landed ' + REPO + '/apps/backend/src/backend/domain/repos/review_findings_repo.ts.',
  STYLE,
  'A1: ' + JSON.stringify(portA1).slice(0, 250) + ' | A2: ' + JSON.stringify(portA2).slice(0, 250),
  'READ the frozen Python persist_aggregated transaction body: ' + SRC_REPO + ' lines 338-541 (the concrete PostgresReviewFindingsRepo.persist_aggregated). Replicate its structure EXACTLY in the TS persistAggregated:',
  '- Wrap the whole body in ONE transaction: this.db.transaction().execute(async (tx) => { ... }). Create a PendingEmits (from part A2) BEFORE the transaction; drain() it ONLY after .execute() resolves successfully.',
  '- Inside the tx, FIRST: a SAVEPOINT around assertCurrentRun (mirror Python `async with session.begin_nested() as sp: try: assert_current_run(...) except: await sp.commit(); raise`). In Kysely: open a nested savepoint (tx.transaction().execute(...) OR raw sql SAVEPOINT); call assertCurrentRun({ tx, runId, reviewId, site: "findings_repository.persist_aggregated", pending, clock: this.clock }); on StaleWriteError, RELEASE the savepoint (so the STALE_WRITE_BLOCKED INSERT is structurally retained per Python) then RE-RAISE (propagating out of .execute() -> outer rollback). Preserve Python\'s exact structure; the verifier confirms the resulting on-disk behavior matches Python.',
  '- THEN (only reached if the guard passed): if there are findings rows, run the existing multi-row INSERT ... ON CONFLICT (review_finding_id) DO NOTHING (KEEP the existing column list/bind logic — do not regress it). If zero findings, SKIP the INSERT (Postgres rejects an empty VALUES) but STILL continue to the emit (BF-8: a clean PR must still emit FINDINGS_PERSISTED).',
  '- THEN the idempotent FINDINGS_PERSISTED emit, 1:1 with Python lines 511-539: SELECT 1 FROM audit.workflow_events WHERE run_id=:rid AND event_type=\'FINDINGS_PERSISTED\' LIMIT 1; if none, look up provider = SELECT provider FROM core.pull_request_reviews WHERE review_id=:rvid (fallback "github" if null), then emitWorkflowEvent({ tx, provider, runId, reviewId, eventType: "FINDINGS_PERSISTED", payload: { findings_persisted: finding_ids.length }, deliveryId: null, installationId, clock: this.clock }).',
  '- After the tx resolves: pending.drain() (fires the deferred OTel counters on commit only). Return the finding_ids tuple/array exactly as before.',
  '- UPDATE the module header (lines ~41-43) + the persistAggregated docstring (lines ~197-199): change the "DEFERRED / NOT wired here" notes to describe the now-WIRED guard + FINDINGS_PERSISTED emit. Do NOT touch the 3 lifecycle setters (insertTier1Finding etc.) in THIS task — note in your return that wiring the guard into them is a same-shaped FOLLOW-ON (they are arbitration persistence, not on the 2.5 dual-run findings path).',
  'Integration test additions in ' + REPO + '/test/integration/domain/repos/review_findings_repo.integration.test.ts (or a sibling): (a) HAPPY: seed pull_request_reviews.current_run_id = R; persistAggregated(runId=R) with N findings -> findings persisted + EXACTLY ONE FINDINGS_PERSISTED row + NO STALE_WRITE_BLOCKED. (b) SUPERSEDED: current_run_id = R; persistAggregated(runId=R2) -> throws StaleWriteError AND the N findings are NOT persisted (rolled back). (c) EMPTY: 0 findings, runId=R -> no findings, but FINDINGS_PERSISTED still emitted once. (d) IDEMPOTENT: call persistAggregated twice (runId=R) -> findings ON CONFLICT no-op AND FINDINGS_PERSISTED emitted EXACTLY ONCE (the pre-emit SELECT dedupes). Unique tenant per test; cleanup; SKIP without DSN.',
  'Run the FULL existing review_findings integration suite too (do not regress it). Return component="persist_aggregated_rethread", files_written (incl. the modified repo), commands, all_green, notes (the Kysely savepoint mechanism used, how the empty-findings + idempotency cases behave, confirmation the existing INSERT logic is unchanged, the 3-lifecycle-setter follow-on).',
].join('\n')

const portB = await agent(PORT_B, { label: 'port:rethread-persist', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const BUILT = 'BUILT: wfe=' + JSON.stringify(portA1).slice(0, 200) + ' | guard=' + JSON.stringify(portA2).slice(0, 200) + ' | rethread=' + JSON.stringify(portB).slice(0, 250)
const VERIFY_COMMON = [
  STYLE,
  BUILT,
  'You are an ADVERSARIAL verifier. The disposable PG at ' + DSN + ' is the SHARED ground-truth substrate. Drive the FROZEN PYTHON persist_aggregated / primitives against it (construct the Python async repo over the SAME PG — the vendor venv has SQLAlchemy; the app DSN driver is postgresql+asyncpg://postgres:postgres@localhost:5434/codemaster, or +psycopg if asyncpg is absent — `' + PY + ' -m pip show asyncpg psycopg` to check) via a throwaway tools/parity/run_stale_write_ref.py (remove ONLY that file after; NEVER rm -rf tools/parity). Drive the TS via a throwaway tools/parity/_stale_scratch.ts (npx tsx; delete after). Compare resulting DB rows BYTE-FOR-BYTE (normalize uuids the workflow mints fresh + received_at timestamps; compare the structural + deterministic columns). Do NOT run tsc -p (parent does it); run the relevant integration test + the clock/tenant gates.',
].join('\n')

const V1 = [
  'LENS 1 — stale-write rejection PARITY + the EMPIRICAL savepoint ground truth. REFUTE that TS persistAggregated matches frozen Python row-for-row across happy / superseded / NULL / orphan.',
  VERIFY_COMMON,
  'For EACH scenario, run frozen-Python persist_aggregated AND TS persistAggregated against the PG (separate tenants/review_ids), then SELECT the resulting core.review_findings + audit.workflow_events rows and compare:',
  '1. HAPPY (current_run_id == run_id, N=2 findings): both persist the SAME 2 review_findings (same review_finding_ids — uuid5-derived, deterministic) + EXACTLY ONE FINDINGS_PERSISTED workflow_event (same payload {findings_persisted:2}, same provider) + ZERO STALE_WRITE_BLOCKED. Byte-compare the deterministic columns.',
  '2. SUPERSEDED (current_run_id = R, persist with run_id = R2 != R): both RAISE (StaleWriteError TS / StaleWriteError Python). The N findings are NOT persisted in EITHER. **THE KEY EMPIRICAL QUESTION**: after the rejection, query audit.workflow_events for a STALE_WRITE_BLOCKED row for run_id=R2 — does it EXIST in Python? does it exist in TS? They MUST match (whatever Python does, TS must do). Report the Python ground truth explicitly. If they differ, verdict WEAK with the exact row counts.',
  '3. NULL current_run_id: both RAISE StaleWriteError; same STALE_WRITE_BLOCKED behavior as #2 (match Python).',
  '4. ORPHAN (no pull_request_reviews row for review_id): both RAISE StaleWriteError with NO workflow_events row written (the no-emit path).',
  'verdict=WEAK if the persisted findings, the FINDINGS_PERSISTED emit, OR the STALE_WRITE_BLOCKED presence/absence diverges between Python and TS in ANY scenario; SOUND if row-for-row identical. Run (cd ' + REPO + ' && CODEMASTER_PG_CORE_DSN="' + DSN + '" npx vitest run <persist + guard integration tests>) + the gates. Clean up scratch (your files only).',
].join('\n')

const V2 = [
  'LENS 2 — FINDINGS_PERSISTED idempotency + emitWorkflowEvent + sequence_no parity vs frozen Python.',
  VERIFY_COMMON,
  '1. IDEMPOTENCY: persist_aggregated TWICE for the same run_id (Temporal-retry analogue) -> FINDINGS_PERSISTED emitted EXACTLY ONCE in BOTH Python and TS (the pre-emit existence SELECT dedupes; the findings INSERT is absorbed by ON CONFLICT). Count workflow_events FINDINGS_PERSISTED rows == 1 after two calls in each.',
  '2. EMPTY FINDINGS: persist with 0 findings, valid run_id -> 0 review_findings, but FINDINGS_PERSISTED STILL emitted once (payload {findings_persisted:0}) in BOTH (BF-8). ',
  '3. PROVIDER: the emit provider is read from core.pull_request_reviews.provider (seed it as e.g. "github_enterprise") and appears in the workflow_event row in BOTH; with a NULL provider it falls back to "github" in BOTH.',
  '4. SEQUENCE_NO: emitWorkflowEvent computes 1 + MAX(sequence_no) per run_id. Pre-seed a workflow_event at sequence_no=5 for the run, then a FINDINGS_PERSISTED -> sequence_no 6 in BOTH. Unknown event_type -> ValueError(Python)/throw(TS). emit/guard on a NON-transaction handle -> RuntimeError analogue in BOTH.',
  'verdict=WEAK if idempotency, the empty-emit, provider fallback, or sequence_no diverges from Python; SOUND otherwise. Byte-compare the workflow_events rows. Run the integration tests + gates. Clean up scratch.',
].join('\n')

const V3 = [
  'LENS 3 — advisory-key derivation + transaction/savepoint discipline + FOR SHARE concurrency.',
  VERIFY_COMMON,
  '1. runIdToLockKey vs Python _run_id_to_lock_key: for 6 distinct run_id UUIDs, the TS value === the Python value (int.from_bytes(bytes[:4],"big",signed=True)) — drive Python via ' + PY + '. Include a UUID whose first byte is >= 0x80 so the SIGNED interpretation (negative int4) is exercised; if TS returns a positive number there, the signed handling is wrong -> WEAK.',
  '2. OPEN-TXN REQUIREMENT: assertCurrentRun + emitWorkflowEvent must operate only within a transaction (the Python raises RuntimeError without session.in_transaction()). Confirm the TS API structurally enforces this (takes a Kysely Transaction handle) AND that calling the guard outside a tx is impossible/errors — document the analogue.',
  '3. FOR SHARE vs supersede FOR UPDATE: open tx A, assertCurrentRun does SELECT ... FOR SHARE on the review row; concurrently tx B attempts the supersede UPDATE core.pull_request_reviews SET current_run_id=... (which would take FOR UPDATE / row lock). Confirm the FOR SHARE read lock blocks the concurrent UPDATE until A\'s tx ends (the lock is real, not advisory-only) — i.e. the guard cannot race the supersede. (If Kysely/pg makes this hard to test deterministically, at minimum confirm the SELECT carries FOR SHARE in the emitted SQL.)',
  '4. SAVEPOINT structure: confirm persistAggregated wraps the guard in a savepoint and the overall transaction rolls the findings back on a stale-write (already covered structurally by LENS 1 #2 — here confirm the SQL/structure, e.g. SAVEPOINT/RELEASE present).',
  'verdict=WEAK if the advisory key diverges (esp. the signed case), the open-txn requirement is not enforced, or FOR SHARE is absent; SOUND otherwise. Run the integration tests + check_clock_random + check_tenant_scoped_raw_sql. Clean up scratch.',
].join('\n')

const verifications = await parallel([
  () => agent(V1, { label: 'verify:stale-rejection-parity', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V2, { label: 'verify:findings-persisted-idempotency', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V3, { label: 'verify:advisory-key-txn', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

return { portA1, portA2, portB, verify: { staleRejection: verifications[0], idempotency: verifications[1], advisoryTxn: verifications[2] } }
