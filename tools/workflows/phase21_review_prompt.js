export const meta = {
  name: 'phase21-review-prompt',
  description: 'bedrock sub-part 1: the review prompt builder — REVIEW_SYSTEM_PROMPT + REVIEW_TOOL_SCHEMA + _build_user_message (trust-tier wrapping, evidence manifest, PR-scope topology manifest 3-tier compression). Deterministic; byte-exact Tier-1 parity vs frozen Python (the prompt IS the LLM input)',
  phases: [
    { title: 'Port', detail: 'review_prompt.ts (system prompt + tool schema + epistemic clause) + prompt_builder.ts (buildUserMessage + renderEvidenceManifest + topology rendering)' },
    { title: 'Verify', detail: 'adversarial byte-exact Tier-1: ReviewContextV1 → prompt string matches frozen Python char-for-char; tool schema + system prompt identical; trust-tier wrapping; manifest truncation' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_ACT = REPO + '/vendor/codemaster-py/codemaster/review/activities.py'
const SRC_PROMPT = REPO + '/vendor/codemaster-py/codemaster/llm/review_prompt.py'

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
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'ALREADY PORTED + REUSE: #backend/security/trust_tier_wrapping.js (the trust-tier <diff trust="untrusted"> / <knowledge trust="..."> wrapping — the LLM-boundary trust tagging; DO NOT re-implement). #contracts/review_context.v1.js (ReviewContextV1 — the input: chunk + retrieved_knowledge + retrieved_evidence + pr_topology_manifest + applicable_policy + tool_status...). #contracts/retrieved_evidence.v1.js, pr_topology.v1.js, tool_status.v1.js. The prompt string is the LLM INPUT — it MUST be byte-identical to Python or the dual-run LLM output diverges; this is a byte-exact port.',
  'PARITY TOOLING (established Tier-1): a DEDICATED tools/parity/run_review_prompt_ref.py + test/parity/review_prompt_oracle.ts driving frozen Python via ' + PY + '. Compare the FULL prompt STRING char-for-char (not canonicalized — exact bytes) + the tool schema (JSON) + the system prompt.',
  'GATE: apps/** + libs/**/src scanned by check_clock_random (no Date/Math.random/setTimeout — the prompt builder is pure, no time/random) + check_tenant_scoped_raw_sql (no DB). NO NEW DEPS. Frozen Python READ-ONLY at vendor/codemaster-py.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch (delete from tools/parity; use a UNIQUE scratch name to avoid colliding with concurrent agents). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

phase('Port')

const PORT = [
  'Port the review PROMPT BUILDER 1:1 to TypeScript (bedrock sub-part 1). This builds the exact LLM input for bedrock_review_chunk — it is DETERMINISTIC (ReviewContextV1 -> a prompt string + the tool schema) and must be BYTE-IDENTICAL to the frozen Python (the dual-run replays the LLM, so a 1-char prompt drift = a different recorded interaction).',
  STYLE,
  'READ FULLY: ' + SRC_PROMPT + ' (REVIEW_SYSTEM_PROMPT, REVIEW_TOOL_SCHEMA, the EPISTEMIC_BOUNDARY_CLAUSE, any prompt constants) and the prompt-building functions in ' + SRC_ACT + ': _build_user_message (line ~725), _render_evidence_manifest (line ~636), and whatever they call (the PR-scope topology-manifest rendering — invariant 13\'s 3-tier semantic compression per-path -> file-inventory -> directory-aggregation; the MAX_EVIDENCE_MANIFEST_TOKENS=1500 evidence-manifest truncation + footer; the <diff trust="untrusted"> chunk wrapping; the <knowledge trust=...> retrieved-knowledge wrapping; the ## PR scope + ## Evidence manifest section headers; the tool_status rendering). Port the constants VERBATIM (the system prompt is a long multi-line string — reproduce it EXACTLY, including whitespace/markdown).',
  'PORT TO:',
  '- ' + REPO + '/apps/backend/src/backend/llm/review_prompt.ts — REVIEW_SYSTEM_PROMPT (the exact string incl. EPISTEMIC_BOUNDARY_CLAUSE) + REVIEW_TOOL_SCHEMA (the exact tool/function-calling JSON schema — the scope enum, evidence_refs pattern, the finding fields) + any other prompt constants (ARBITRATION_INTENT_TOOL_SCHEMA if it lives here, else note where). Export them.',
  '- ' + REPO + '/apps/backend/src/backend/review/prompt_builder.ts — buildUserMessage(context: ReviewContextV1): string (1:1 with _build_user_message) + renderEvidenceManifest(...) + the topology-manifest renderer (the 3-tier compression, adaptive tier-3 retention of retrieved_knowledge.relative_path cited paths). Use the ported trust_tier_wrapping for the <diff>/<knowledge> tagging. PURE function — NO clock/random/IO.',
  'BYTE-EXACTNESS: every space, newline, markdown header, token-budget truncation, ordering, and number formatting must match Python. Token-counting for the manifest truncation: read how Python counts (a tokenizer? a char/word heuristic?) and replicate it EXACTLY — if it uses a real tokenizer that has no TS equivalent, note it as a divergence risk for the verifier (the truncation boundary is parity-significant).',
  'TIER-1 PARITY: tools/parity/run_review_prompt_ref.py builds several representative ReviewContextV1 (a clean chunk; a chunk WITH retrieved_knowledge + evidence + a multi-file pr_topology_manifest that exercises all 3 compression tiers; a chunk whose evidence manifest EXCEEDS the token budget -> truncation+footer) and dumps {system_prompt, tool_schema, user_message} for each. test/parity/review_prompt_oracle.ts builds the SAME contexts in TS and asserts the system_prompt + tool_schema + user_message are CHAR-FOR-CHAR identical (exact string equality, NOT canonicalized).',
  'Return component="review_prompt", files_written, commands, all_green, notes (the system-prompt + tool-schema port, the topology 3-tier compression, the evidence-manifest token-budget + how token-counting was matched, the trust-tier reuse, and any byte-exactness risk — esp. token counting — for the verifier).',
].join('\n')

const port = await agent(PORT, { label: 'port:review-prompt', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the review prompt builder. REFUTE that the TS prompt (system + tool schema + user message) is BYTE-IDENTICAL to the frozen Python for every ReviewContextV1 shape.',
  STYLE,
  'Built: ' + JSON.stringify(port).slice(0, 600),
  'Independently drive BOTH the frozen Python (' + PY + ': REVIEW_SYSTEM_PROMPT, REVIEW_TOOL_SCHEMA, _build_user_message) and the TS (buildUserMessage + the exported constants) via a throwaway tools/parity/_revprompt_scratch.ts (npx tsx; DELETE after — UNIQUE name). EXACT string equality (the prompt is the LLM input — 1 char drift breaks the dual-run):',
  '1. SYSTEM PROMPT: REVIEW_SYSTEM_PROMPT char-for-char identical (incl. EPISTEMIC_BOUNDARY_CLAUSE, all whitespace/markdown).',
  '2. TOOL SCHEMA: REVIEW_TOOL_SCHEMA JSON identical (the scope enum chunk_observed/cross_chunk/pr_global, the evidence_refs ^ev_[0-9a-f]{16}$ pattern, every field/description).',
  '3. USER MESSAGE — clean chunk: buildUserMessage(simple context) char-for-char matches.',
  '4. USER MESSAGE — full context: a context WITH retrieved_knowledge (<knowledge trust=...> wrapping), retrieved_evidence (## Evidence manifest), and a multi-file pr_topology_manifest exercising all 3 compression tiers (per-path -> file-inventory -> directory-aggregation, with tier-3 adaptive retention of cited paths) -> char-for-char identical. The trust-tier tags + section headers + ordering must match.',
  '5. TRUNCATION: an evidence manifest EXCEEDING MAX_EVIDENCE_MANIFEST_TOKENS=1500 -> the truncation point + footer are byte-identical (this is the subtlest — if Python uses a tokenizer the TS must match the boundary exactly; a different token count = a different truncation = WEAK).',
  'Run (cd ' + REPO + ' && npx vitest run <the prompt tests>) + check_clock_random; tsc clean (delete scratch first). verdict=WEAK if ANY of system/tool-schema/user-message diverges by even one byte for any context; SOUND otherwise. Show the exact diff (offset + the differing bytes) for any failure. Clean up scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:review-prompt', phase: 'Verify', schema: VERIFY_SCHEMA })

return { port, verify }
