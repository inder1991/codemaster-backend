export const meta = {
  name: 'phase21-post-check-run',
  description: 'Phase 2.1 activity #5: post_check_run — PostedCheckRunV1 + PostCheckRunInputV1 envelope (inv-11) + GhCheckRunClient (find/create/update over the ported GitHubApiClient) + the idempotent find→update-else-create logic; Tier-1 parity vs frozen Python with a stub client',
  phases: [
    { title: 'Port', detail: 'contracts + GhCheckRunClient (check-run REST over GitHubApiClient) + doPostCheckRun + activity + worker registration' },
    { title: 'Verify', detail: 'adversarial Tier-1 parity vs frozen _do_post_check_run (find→update vs create, was_update, validation) + the REST request shapes' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC = REPO + '/vendor/codemaster-py/codemaster/activities/post_check_run.py'

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
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths. Bash cwd RESETS — prefix EVERY command with (cd ' + REPO + ' && ...).',
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* (libs/contracts/src), #platform/* (libs/platform/src), #backend/* (apps/backend/src/backend); same-dir relative ./x.js.',
  'ALREADY PORTED + REUSE: apps/backend/src/backend/integrations/github/api_client.ts (GitHubApiClient — its injected GitHubHttpClient transport + the _request retry loop; the CassetteHttpClient from infra/cassettes.ts for tests). libs/contracts/src/walkthrough.v1.ts exports PrMetaV1 (the pr_meta input — already ported). The GitHub conclusion is ALWAYS "neutral" (codemaster is advisory; invariant 9 — never blocks merge). CHECK_RUN_NAME = "codemaster/review".',
  'PARITY TOOLING (established Tier-1 pattern): a DEDICATED tools/parity/run_post_check_run_ref.py + test/parity/post_check_run_oracle.ts driving frozen Python via ' + PY + ' with a STUB GhCheckRunClient (so the find→update/create LOGIC is byte-verifiable; the real REST client is exercised separately via a recording stub of the GitHubApiClient transport).',
  'GATE: apps/** + libs/**/src scanned by check_clock_random + check_tenant_scoped_raw_sql (no DB here). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP any scratch you create (delete it from tools/parity). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the post_check_run activity 1:1 to TypeScript (Phase 2.1, activity #5). Posts a "codemaster/review" GitHub check-run (conclusion ALWAYS "neutral"); idempotent (update existing-at-head-sha else create).',
  STYLE,
  'READ FULLY: ' + SRC + ' (142 lines: PostedCheckRunV1 dataclass, the GhCheckRunClient Protocol, _do_post_check_run, the activity). ALSO FIND + READ the CONCRETE GhCheckRunClient impl in the Python (grep the codebase for the actual check-run REST calls — create_check_run / update_check_run / find_existing_check_run endpoint shapes; they are NOT in post_check_run.py, the concrete client lives elsewhere, likely the github integration package) and port those EXACT endpoints.',
  'THE LOGIC (_do_post_check_run, port EXACTLY): validate summary non-empty (else raise) + head_sha non-empty (else raise); existing = findExistingCheckRun(owner, repo, head_sha, CHECK_RUN_NAME); if existing != null -> updateCheckRun(...) -> return PostedCheckRunV1{check_run_id: existing, was_update: true}; else newId = createCheckRun(...) -> return PostedCheckRunV1{check_run_id: newId, was_update: false}. conclusion is ALWAYS "neutral".',
  'PORT TO:',
  '- ' + REPO + '/libs/contracts/src/posted_check_run.v1.ts — PostedCheckRunV1 (Zod: check_run_id: z.number().int(), was_update: z.boolean(), schema_version default 1). The Python is a frozen @dataclass (NOT a Pydantic contract) — but it crosses the Temporal activity boundary so it MUST be a versioned contract (data-contract policy). AND PostCheckRunInputV1 (the typed envelope replacing the Python activity\'s 5 POSITIONAL args post_check_run(pr_meta, head_sha, summary, owner, repo_name) — fields: pr_meta: PrMetaV1, head_sha, summary, owner, repo_name; closes the inv-11 / ADR-0047 positional-dispatch violation, consistent with the other ports).',
  '- ' + REPO + '/apps/backend/src/backend/integrations/github/check_run_client.ts — the GhCheckRunClient type (findExistingCheckRun / createCheckRun / updateCheckRun, args-object, camelCase) + a concrete FetchGhCheckRunClient (or GitHubApiCheckRunClient) implementing it over the ported GitHubApiClient (its _request / injected GitHubHttpClient). Port the EXACT REST endpoints (GET commits/{sha}/check-runs filtered by name, POST check-runs, PATCH check-runs/{id}) + the request bodies + the response parse (the new check_run_id) from the Python concrete impl.',
  '- ' + REPO + '/apps/backend/src/backend/activities/post_check_run.activity.ts — export `doPostCheckRun({ prMeta, headSha, summary, owner, repoName, ghClient, status? }): Promise<PostedCheckRunV1>` (the pure logic, injected client) + `postCheckRun(input: PostCheckRunInputV1): Promise<PostedCheckRunV1>` (the activity — constructs the real check-run client over a GitHubApiClient). Mirror the sibling activities.',
  '- REGISTER `postCheckRun` in ' + REPO + '/apps/backend/src/backend/worker/registry.ts (additive; workflow untouched).',
  'TIER-1 PARITY: tools/parity/run_post_check_run_ref.py drives the frozen Python _do_post_check_run with a STUB GhCheckRunClient (scripted: existing-id or None; records the calls) over given inputs, dumps PostedCheckRunV1 + the recorded call sequence. test/parity/post_check_run_oracle.ts runs the TS doPostCheckRun with the SAME stub + inputs, asserts PostedCheckRunV1 + the call sequence byte-match. Cover: create path (no existing -> was_update false, create called), update path (existing -> was_update true, update called), empty summary -> raises, empty head_sha -> raises. ALSO a test of FetchGhCheckRunClient against a recording stub of the GitHubApiClient transport (or a CassetteHttpClient) asserting the EXACT REST method/url/body for find/create/update.',
  'Return component="post_check_run", files_written, commands, all_green, notes (the concrete check-run REST endpoints + bodies found in the Python, the inv-11 envelope closure, the find→update/create logic, the stub-vs-real test split).',
].join('\n')

const port = await agent(PORT, { label: 'port:post-check-run', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the post_check_run port. REFUTE that the TS doPostCheckRun matches the frozen _do_post_check_run, and that the REST client issues the right requests.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ', codemaster.activities.post_check_run._do_post_check_run with a stub client) and the TS doPostCheckRun via a throwaway tools/parity/_pcr_scratch.ts (npx tsx; DELETE after):',
  '1. CREATE path: no existing check-run -> create called with (owner, repo, head_sha, name="codemaster/review", status, conclusion="neutral", summary); returns PostedCheckRunV1{check_run_id: <new>, was_update: false}. Identical in BOTH.',
  '2. UPDATE path: an existing check-run id at the head_sha -> update called (NOT create); returns {check_run_id: <existing>, was_update: true}. Identical in BOTH.',
  '3. VALIDATION: empty summary -> raises in BOTH; empty head_sha -> raises in BOTH. conclusion is ALWAYS "neutral" (never blocks merge — invariant 9).',
  '4. REST SHAPES: FetchGhCheckRunClient against a recording GitHubHttpClient stub -> findExistingCheckRun issues GET .../commits/<sha>/check-runs (filtered by name), createCheckRun POST .../check-runs with the right body, updateCheckRun PATCH .../check-runs/<id>. Confirm the method/url/body match the frozen Python concrete client.',
  '5. ENVELOPE: PostCheckRunInputV1 is a single typed arg (ADR-0047/inv-11, NOT 5 positional) + postCheckRun registered in worker/registry.ts.',
  'Run (cd ' + REPO + ' && npx vitest run <the post_check_run tests>) + check_clock_random; tsc clean (delete scratch before tsc). verdict=WEAK if the find→update/create logic, was_update, the validation, or the REST shapes diverge from Python; SOUND otherwise. Exact diverging case for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:post-check-run', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
