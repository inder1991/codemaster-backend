export const meta = {
  name: 'phase24c-langfuse',
  description: 'The 4th de-stub item: port the REAL Langfuse exporter (env-gated, fire-and-forget) so LLM-call traces actually export when LANGFUSE_HOST is configured (no-op otherwise — faithful to Python). LlmTraceV1/BedrockTraceV1 contract + LangfuseExporter (fetch transport) + wire the _maybeExportLangfuseTrace seam into the LlmClient + from_env in the worker collaborators.',
  phases: [
    { title: 'Port', detail: 'libs/contracts/src/llm_trace.v1.ts (+parity) + observability/langfuse_exporter.ts (from_env, export POST, redactSnippet via the ported redactPii, setEnabled, aclose) + wire the export seam into client.ts (success+failure paths) + client_cache from_env + tests (fetch double)' },
    { title: 'Verify', detail: 'adversarial: the POST body+headers match the frozen Python byte-for-byte (driven with a fake transport on both sides); env-gated OFF when unconfigured; fire-and-forget never raises; snippet redaction; the LlmClient export call fires on ok/failed/timeout' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_EXP = REPO + '/vendor/codemaster-py/codemaster/observability/langfuse_exporter.py'
const SRC_CONTRACT = REPO + '/vendor/codemaster-py/contracts/observability/v1.py'
const SRC_CLIENT = REPO + '/vendor/codemaster-py/codemaster/integrations/llm/client.py'

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
  'TS STYLE: ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'PRODUCTION CODE MUST BE REAL — the exporter really POSTs when configured; it is env-gated OFF (returns disabled) when LANGFUSE_HOST/LANGFUSE_API_KEY are unset — that is FAITHFUL to Python, NOT a stub. Test doubles ONLY in test files (a fake fetch transport).',
  'REUSE: #backend/redact/pii_redactor.js (redactPii — the redactSnippet reuses it, truncate to 200). The HTTP transport seam: mirror #backend/adapters/vault_http.ts FetchVaultHttpClient (an injectable fetch-based transport; production default uses global fetch; tests inject a recorder). #backend/integrations/llm/client.js (LlmClient — add the langfuse export seam alongside the existing telemetry writer seam: an injected collaborator with a no-op/disabled default; the production client_cache injects LangfuseExporter.fromEnv()). #platform/clock.js if needed.',
  'GATE: check_clock_random (no raw Date.now/Math.random; use the Clock seam if a timestamp is needed — the exporter itself takes none). NO new deps (use global fetch, not a new http lib). check_tenant_scoped_raw_sql: no DB.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the REAL Langfuse exporter to TypeScript (the 4th de-stub item) + wire it into the LlmClient. NO stub — env-gated OFF when unconfigured is the faithful Python behavior.',
  STYLE,
  'READ FULLY: ' + SRC_CONTRACT + ' (the trace contract — the exporter imports BedrockTraceV1; the class is LlmTraceV1 with fields request_id, installation_id, model, prompt_tokens(ge=0), completion_tokens(ge=0), latency_ms(ge=0), cost_usd_cents(ge=0), status Literal[ok,failed,timeout], prompt_redacted_snippet(max 200), completion_redacted_snippet(max 200), routing_reason="", policy_revision(ge=0, default 0). CHECK whether BedrockTraceV1 is the same class, an alias, or a sibling — port the name the exporter actually uses) and ' + SRC_EXP + ' (LangfuseExporter: from_env [LANGFUSE_HOST/LANGFUSE_API_KEY/LANGFUSE_EXPORT_ENABLED; disabled if host/key unset], export(trace) [if not enabled or no host: return; else POST {host}/api/public/traces with the EXACT JSON body {id, name:"bedrock_invocation", userId, metadata:{model,status,routing_reason,policy_revision}, input:{snippet}, output:{snippet}, usage:{input,output,totalCost: cost_usd_cents/100.0}, latency} + headers {Authorization: Bearer <api_key>, Content-Type: application/json}; catch+log all errors, NEVER raise], redact_snippet [redactPii then truncate 200], set_enabled, aclose) and ' + SRC_CLIENT + ' lines 710-762 (_maybe_export_langfuse_trace: builds the trace from the call params + redacted snippets, hands to the injected exporter; no-op when self._langfuse is None; fire-and-forget). totalCost = cost_usd_cents / 100.0 (a FLOAT — note JSON number formatting; match Python json.dumps float repr).',
  'PORT TO:',
  '- ' + REPO + '/libs/contracts/src/llm_trace.v1.ts — the LlmTraceV1 (and BedrockTraceV1 alias/sibling exactly as Python) Zod contract + a parity test test/contracts/llm_trace.v1.parity.test.ts.',
  '- ' + REPO + '/apps/backend/src/backend/observability/langfuse_exporter.ts — LangfuseExporter (fromEnv, export via an injected fetch transport [default global fetch], redactSnippet, setEnabled, aclose) + exported redactSnippet.',
  '- WIRE into ' + REPO + '/apps/backend/src/backend/integrations/llm/client.ts — add the langfuse exporter as an injected collaborator (default: a disabled/no-op exporter — faithful to Python self._langfuse is None) + a maybeExportLangfuseTrace(...) that builds the LlmTraceV1 (redacted snippets) and calls exporter.export, invoked on BOTH the success (status ok/failed from output-safety) and the SDK-error (failed/timeout) paths — exactly where the Python calls it. Fire-and-forget (never affects the return/raise).',
  '- WIRE into ' + REPO + '/apps/backend/src/backend/integrations/llm/client_cache.ts — sharedClientCollaborators injects LangfuseExporter.fromEnv() (off when LANGFUSE_HOST unset).',
  'TESTS: test/unit/observability/langfuse_exporter.test.ts — inject a fake fetch transport (recorder): assert the POST URL/body/headers EXACTLY (incl. totalCost = cents/100 float, the metadata, the redacted+truncated snippets); fromEnv disabled when host/key unset → export is a no-op (no POST); a transport that throws → export does NOT raise (fire-and-forget). Plus a client-level test that the LlmClient fires the export on ok + failed + timeout with the right trace (inject a recording exporter double).',
  'Return component="langfuse", files_written, commands, all_green, notes: the exact POST body + the totalCost float formatting, the LlmTraceV1/BedrockTraceV1 naming, the client wiring points (success+failure), the env-gating, the fetch-transport seam, divergence risk for the verifier.',
].join('\n')

const port = await agent(PORT, { label: 'port:langfuse', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL verifier for the Langfuse exporter de-stub. REFUTE that the TS exporter POSTs the SAME body+headers as the frozen Python and is correctly env-gated + fire-and-forget.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 500),
  '1. POST PARITY: drive BOTH the frozen Python LangfuseExporter (' + PY + ', monkeypatch httpx to capture the request) and the TS exporter (inject a recording fetch transport) with the SAME trace; byte-compare the URL, the JSON body (incl. totalCost=cents/100 float repr, metadata, input/output snippets), and the headers (Authorization Bearer + Content-Type). Use a throwaway scratch (UNIQUE name; delete after).',
  '2. ENV-GATED OFF: fromEnv with LANGFUSE_HOST/API_KEY unset → enabled=false → export() makes NO request on both sides.',
  '3. FIRE-AND-FORGET: a transport that raises → export() does NOT raise (both sides swallow + log).',
  '4. SNIPPET REDACTION: a prompt/completion with PII → the snippet is redacted (redactPii) AND truncated to 200 on both sides.',
  '5. CLIENT WIRING: the LlmClient calls the exporter on the success path (ok/failed) AND the SDK-error path (failed/timeout) with a correctly-built LlmTraceV1; with no exporter wired it is a no-op (faithful to Python self._langfuse is None).',
  'Run (cd ' + REPO + ' && npx vitest run <the new tests>) + check_clock_random; tsc clean (delete scratch first). verdict=WEAK if the POST body/headers diverge, env-gating/fire-and-forget differ, or the client does not fire on all status paths; SOUND otherwise. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:langfuse', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
