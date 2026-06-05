export const meta = {
  name: 'phase21-bedrock-activity',
  description: 'bedrock sub-part 3: the LLM invoke seam (LlmClient.invoke_model: SDK response → LlmInvokeResultV1 + output-safety blocking) + _do_review + the bedrock_review_chunk activity (role/model resolve → prompt → invoke → parse → the 3 error paths + sanitize-and-continue) + the cassette SDK replay stub. Verified by an adversarial cassette DUAL-RUN: the 4 review_chunk cassettes through frozen Python _do_review vs TS, byte-equal ReviewChunkResponseV1.',
  phases: [
    { title: 'Port', detail: 'contracts (LlmInvokeResultV1 + LlmMessage) + the LLM error hierarchy + LlmClient.invoke_model seam (injectable collaborators; real output-safety; no-op cost-cap/blob/archive) + _do_review + bedrock_review_chunk activity + the cassette SDK stub + unit tests' },
    { title: 'Verify', detail: 'adversarial cassette dual-run: clean/five/fifty/malformed.yaml through frozen Python _do_review (_CassetteSdk + _CacheShim) vs TS, byte-equal ReviewChunkResponseV1 (findings + arbitration_intents + sanitization_event); plus the budget/unsafe error paths' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_CLIENT = REPO + '/vendor/codemaster-py/codemaster/integrations/llm/client.py'
const SRC_ERRTYPES = REPO + '/vendor/codemaster-py/codemaster/integrations/llm/error_types.py'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/review/activities.py'
const SRC_SYSPROMPT = REPO + '/vendor/codemaster-py/codemaster/llm/system_prompt.py'
const SRC_TEST = REPO + '/vendor/codemaster-py/tests/integration/test_bedrock_review_chunk_cassettes.py'
const FIX = REPO + '/vendor/codemaster-py/tests/cassettes/bedrock/review_chunk'

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
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths. Bash cwd RESETS between calls — prefix EVERY command with (cd ' + REPO + ' && ...).',
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'GATE: apps/** + libs/**/src are scanned by check_clock_random (NO raw Date/Date.now/Math.random/setTimeout outside the seams — the invoke seam measures latency; if you need elapsed time use the SAME clock seam the rest of apps/ uses — grep #platform for a clock/now seam, do NOT introduce Date.now) + check_tenant_scoped_raw_sql (no DB in this slice). NO NEW DEPS (no @anthropic-ai/* import in this slice — the SDK is an injected Protocol; the cassette stub satisfies it). Frozen Python is READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch (UNIQUE names; delete from tools/parity). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

const REUSE = [
  'ALREADY PORTED — REUSE, DO NOT re-implement:',
  '- #backend/llm/review_prompt.js — REVIEW_SYSTEM_PROMPT, REVIEW_TOOL_SCHEMA, ARBITRATION_INTENT_TOOL_SCHEMA, REVIEW_TOOL_NAME, ARBITRATION_INTENT_TOOL_NAME. (Check if buildSystemPrompt(policyRevision) already lives here; if NOT, add it — it is just `${REVIEW_SYSTEM_PROMPT}\\n[policy_revision=${n}]\\n` with a ValueError/throw when policyRevision < 0; see ' + SRC_SYSPROMPT + ':146-155.)',
  '- #backend/review/prompt_builder.js — buildUserMessage(context) (sub-part 1, byte-exact).',
  '- #backend/review/chunk_response_parser.js — parseWithSkipMalformed(blocks, { allowedEvidenceIds }) (sub-part 2). This IS the happy-path + sanitize-path parser — DO NOT re-implement scope/evidence enforcement.',
  '- #backend/security/output_safety.js — the output-safety validator (validate(text) -> a decision; reuse it for the invoke_model blocking step). Grep its exact exported name/shape.',
  '- #backend/llm/model_router.js — resolveModelForPurpose / the purpose->model seam (review_finding -> claude-sonnet-4-6). Grep its exact exported name.',
  '- #contracts/review_chunk_response.v1.js — ReviewChunkResponseV1 + OutputSafetySanitizationEventV1 (both exported from here).',
  '- #contracts/review_findings.v1.js (ReviewFindingV1), #contracts/arbitration_intent.v1.js (ArbitrationIntentV1), #contracts/review_context.v1.js (ReviewContextV1).',
  '- For the sanitize-and-continue redaction, grep apps/backend/src/backend/security for the ported redact_text equivalent (the PII/secret redactor); reuse it.',
].join('\n')

phase('Port')

const PORT = [
  'Port bedrock sub-part 3: the LLM invocation SEAM + the bedrock_review_chunk ACTIVITY to TypeScript, 1:1 with the frozen Python. The OBSERVABLE OUTPUT is ReviewChunkResponseV1 (findings + arbitration_intents + sanitization_event) — a DETERMINISTIC pure transform of the (cassette) LLM response. Production side-effects (cost-cap DB, blob archive, Langfuse, telemetry, Vault credentials) are NOT on the observable-output path: model them as INJECTED collaborators with no-op / in-memory defaults so the cassette dual-run is faithful, and note the production impls as deferred follow-ups. Output-safety IS on the observable path (it can BLOCK) — wire the REAL ported validator.',
  STYLE,
  REUSE,
  'READ FULLY (frozen Python, READ-ONLY):',
  '- ' + SRC_CLIENT + ' — LlmMessage (60-71: {role: "user"|"assistant"|"system", content: str}); LlmInvokeResultV1 (122-146); the _AsyncLlmSdk Protocol (149-166: create_message(*, model, messages, max_tokens, tools, role) -> dict); LlmClient.invoke_model + _invoke_model_impl (273-584). The PARITY-CRITICAL transform is lines ~481-584: from the SDK response dict extract content_text (first content block whose type=="text", its .text — match Python EXACTLY incl. the empty/missing case), raw_content_blocks (ALL content blocks as dicts, in order), usage -> prompt_tokens/completion_tokens, stop_reason; then output_safety.validate(content_text) -> if not "allow" raise LlmOutputUnsafeError carrying decision + raw_content_blocks + content_text + request_id; else build LlmInvokeResultV1. Cost-cap pre-check (356-387, can raise BedrockBudgetExceededError) + archive (389-408, 481-489) + Langfuse (710+) + telemetry (512-536) are side-effects: model the collaborators as injected Protocols and default them to no-op/in-memory (the existing test uses InMemoryCostCapEnforcer + BlobStoreInMemoryAdapter + a stub session factory — mirror that).',
  '- ' + SRC_ERRTYPES + ' — the dependency-free LLM error hierarchy (LlmInvocationError/BedrockInvocationError, BedrockBudgetExceededError, LlmRoleDisabledError, LlmRoleNotConfiguredError, and the LlmOutputUnsafeError shape if it lives here — else it is in client.py:86-120). Port the hierarchy faithfully (names + the fields each carries, esp. LlmOutputUnsafeError.{decision, raw_content_blocks, content_text, request_id}).',
  '- ' + SRC_ACT + ' — _do_review (972-1177) and bedrock_review_chunk (1200-1224) and (REUSE, already ported) _parse_with_skip_malformed (865-968). Port _do_review EXACTLY incl: role resolve via cache.for_role("primary") [LlmRoleNotConfigured/Disabled -> ApplicationFailure]; model resolve (resolveModelForPurpose("review_finding") unless overridden); messages=[{role:"system", content: buildSystemPrompt(policyRevision)}, {role:"user", content: buildUserMessage(context)}]; tools=[REVIEW_TOOL_SCHEMA, ARBITRATION_INTENT_TOOL_SCHEMA]; max_tokens=2048; THEN the THREE error paths: (a) BedrockBudgetExceededError -> ApplicationFailure(nonRetryable=true); (b) LlmOutputUnsafeError -> SANITIZE-AND-CONTINUE iff the decision reasons are ONLY {secret_leaked} AND tool_use findings exist in e.raw_content_blocks (redact e.content_text via the ported redactor, truncate to 64KB, build OutputSafetySanitizationEventV1, parse e.raw_content_blocks via parseWithSkipMalformed, return (findings, intents, event)) ELSE ApplicationFailure(nonRetryable=true) — READ 1067-1136 for the EXACT condition + field construction + the exact allowed_evidence_ids passed to the parser; (c) BedrockInvocationError -> ApplicationFailure(nonRetryable=false). Happy path (1144-1177): parse result.raw_content_blocks via parseWithSkipMalformed with the SAME allowed_evidence_ids _do_review computes (READ 1144-1146 — derive it from context.retrieved_evidence exactly as Python does), record the max_tokens truncation observability, return (findings, intents, null). bedrock_review_chunk wraps it into ReviewChunkResponseV1.',
  '- ' + SRC_TEST + ' — the existing cassette test: _CassetteSdk (returns spec["response"] from create_message), _CacheShim (for_role -> the client), the InMemoryCostCapEnforcer / BlobStoreInMemoryAdapter / stub session factory wiring, and _context(). This is the REPLAY SEAM you mirror: a cassette SDK stub satisfying the SDK Protocol returning the cassette response dict. Cassette format (READ ' + FIX + '/clean.yaml + five_findings.yaml): { id, description, response: { content: [...blocks...], usage: {input_tokens, output_tokens}, stop_reason }, expected: { finding_count } }.',
  'PORT TO (create):',
  '- ' + REPO + '/libs/contracts/src/llm_invoke_result.v1.ts — LlmInvokeResultV1 (Zod, .strict()/extra=forbid; mirror the Python fields; raw_content_blocks as Array<Record<string, unknown>>; provider/role Literals; if payload_blob_ref needs a BlobRef contract, port a minimal BlobRef or reuse an existing one — grep libs/contracts/src for blob). Add a parity test test/contracts/llm_invoke_result.v1.parity.test.ts driving the frozen Python via the established oracle.',
  '- ' + REPO + '/apps/backend/src/backend/llm/llm_message.ts (LlmMessage Zod or a tiny type) OR fold into the client file — match how apps/ structures small contracts; if it is a wire contract prefer libs/contracts/src/llm_message.v1.ts with a parity test.',
  '- ' + REPO + '/apps/backend/src/backend/integrations/llm/errors.ts — the ported LLM error hierarchy (classes extending Error; carry the same fields; export them so the activity can `instanceof`-dispatch). Mirror error_types.py.',
  '- ' + REPO + '/apps/backend/src/backend/integrations/llm/client.ts — the LlmSdk Protocol/type (createMessage(...)->Promise<Record<string,unknown>>), the injected collaborator Protocols (CostCap with an allow-all in-memory default; BlobStore in-memory default; ArchiveRedactor no-op default; the REAL output-safety validator passed in), and LlmClient.invokeModel(...) implementing the pure transform + the output-safety blocking step + building LlmInvokeResultV1. Latency: use the existing apps/ clock seam (grep #platform), NOT Date.now.',
  '- ' + REPO + '/apps/backend/src/backend/review/review_activity.ts — doReview(context, { cache }) (1:1 _do_review) + the bedrockReviewChunk(context) activity returning ReviewChunkResponseV1. Use ApplicationFailure from @temporalio/common (grep apps/ for the existing import idiom) for the non/retryable raises.',
  '- ' + REPO + '/apps/backend/src/backend/integrations/llm/cassette_sdk.ts — the cassette SDK stub: given a parsed cassette spec (or its response dict), createMessage(...) returns the response dict (mirrors _CassetteSdk). Plus an in-memory cost-cap (allow-all) + blob store + a CacheShim (for_role -> the client) so doReview can run against a cassette. This is the dual-run REPLAY SEAM.',
  'UNIT TESTS (TDD where you add behavior): test/unit/llm/llm_client_invoke.test.ts (the pure transform: content extraction, raw_blocks, usage; output-safety block -> throws LlmOutputUnsafeError with raw blocks) + test/unit/review/review_activity.test.ts (the 3 error paths + the sanitize-and-continue branch with a constructed unsafe-secret response carrying a tool_use finding -> sanitization_event populated + findings preserved). DRIVE the frozen Python for any non-obvious branch to confirm parity BEFORE pinning the TS expectation.',
  'Return component="bedrock_activity", files_written, commands, all_green, notes: the exact invoke_model transform (esp. content_text extraction + the output-safety block), the allowed_evidence_ids _do_review passes to the parser, the EXACT sanitize-and-continue condition (which reasons, the field construction, the truncation), the deferred collaborators (cost-cap/blob/archive/Langfuse/telemetry/credentials) + their tracked follow-up names, and ANY divergence risk for the verifier (esp. token-usage field mapping, BlobRef, ApplicationFailure shape).',
].join('\n')

const port = await agent(PORT, { label: 'port:bedrock-activity', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for bedrock sub-part 3 (the LLM invoke seam + bedrock_review_chunk activity). REFUTE that the TS doReview/bedrockReviewChunk produces a ReviewChunkResponseV1 byte-equal to the frozen Python _do_review for every review_chunk cassette + the error paths.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 700),
  'Independently drive BOTH the frozen Python and the TS via throwaway scratch (UNIQUE names; npx tsx + ' + PY + '; DELETE after). The DUAL-RUN: for each cassette, feed the SAME cassette response dict to BOTH sides and byte-compare the resulting ReviewChunkResponseV1 (findings + arbitration_intents + sanitization_event). Finding `confidence` is a bare float — strip from the canonical diff + assert structurally (the established sub-part-2 pattern); intent confidence (Decimal-string) survives verbatim.',
  'PYTHON SIDE: mirror ' + SRC_TEST + ' — _do_review(_context(), cache=_CacheShim()) with _CassetteSdk(yaml.safe_load(cassette)["response"]); wrap the returned (findings, intents, sanitization_event) into ReviewChunkResponseV1(...).model_dump(mode="json"). TS SIDE: doReview / bedrockReviewChunk over the SAME cassette via the ported cassette SDK stub; ReviewChunkResponseV1 -> canonical JSON.',
  '1. CLEAN: ' + FIX + '/clean.yaml -> 0 findings, 0 intents, null sanitization_event, byte-equal both sides.',
  '2. FIVE: ' + FIX + '/five_findings.yaml -> 5 findings parsed, byte-equal (file/severity/category/title/body/suggestion/scope/evidence_refs all match; confidence structural).',
  '3. FIFTY: ' + FIX + '/fifty_findings.yaml -> 50 findings, byte-equal.',
  '4. MALFORMED: ' + FIX + '/malformed_block.yaml -> the malformed block SKIPPED (not fatal), the good blocks kept, byte-equal both sides.',
  '5. ERROR PATHS (construct inputs; drive both sides): (a) a cost-cap stub that raises budget-exceeded -> BOTH raise a non-retryable failure (Python ApplicationError non_retryable=True ↔ TS ApplicationFailure nonRetryable=true); (b) output-unsafe with ONLY secret_leaked + a tool_use finding present -> BOTH sanitize-and-continue (sanitization_event populated identically + the findings preserved); (c) output-unsafe with a non-secret reason -> BOTH raise non-retryable. If the real output-safety validator cannot be made to fire deterministically from TS, drive the Python to capture the exact decision + assert the TS branch logic matches structurally, and say so.',
  'Run (cd ' + REPO + ' && npx vitest run <the new tests>) + check_clock_random; tsc clean (delete scratch FIRST). verdict=WEAK if ReviewChunkResponseV1 diverges on ANY cassette, or an error path classifies differently (retryable vs non-retryable, sanitize vs raise), or the sanitization_event differs; SOUND otherwise. Give the exact diverging cassette + field for any failure. Clean up ALL scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:bedrock-activity', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
