export const meta = {
  name: 'phase2-token-provider',
  description: 'Phase 2: GitHubAppTokenProvider — production _TokenProvider (Vault-loaded key, LRU cache, refresh-at-0.8, negative cache, single-flight, 401-once + 5xx backoff, github.token.mint span)',
  phases: [
    { title: 'Port', detail: 'A: response contract + formatException + tracer seam ; B: GitHubAppTokenProvider' },
    { title: 'Verify', detail: 'adversarial 3-lens: cache+from_env parity, exchange retry/401/backoff/error-mapping, single-flight+span+formatException+contract' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_TP = REPO + '/vendor/codemaster-py/codemaster/integrations/github/token_provider.py'
const SRC_CONTRACT = REPO + '/vendor/codemaster-py/contracts/integrations/github_app/v1.py'
const SRC_ERRORS = REPO + '/vendor/codemaster-py/codemaster/infra/errors.py'

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
  'TS STYLE (ENFORCED by validate-fast = gates -> lint -> typecheck -> test): ESM .js import specifiers; "type" alias not "interface"; Array<T> not T[]; NO "any" (use unknown + narrowing); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase methods/vars (kvRead, signAppJwt convention).',
  'IMPORTS: Node subpath aliases #contracts/* (libs/contracts/src), #platform/* (libs/platform/src), #backend/* (apps/backend/src/backend); same-dir is relative ./x.js.',
  'EXISTING SEAMS to REUSE (do NOT re-implement): #platform/clock.js (Clock: now(): Date, monotonic(): number seconds, sleep(seconds): Promise<void>; FakeClock test impl with advance({seconds}) advancing BOTH wall+monotonic, set({now}) wall-only, recordedSleeps()). #backend/integrations/github/app_jwt.js (signAppJwt({appId, privateKeyPem, clock}): string + GitHubPrivateKeyMalformed error). #backend/adapters/vault_port.js (VaultPort type with kvRead({path}), VaultPathNotFound). #backend/integrations/github/api_client.js (GitHubHttpClient type: request({method,url,headers,...}) -> {status, headers, bodyText}; FetchGitHubHttpClient prod impl — REUSE this as the injected HTTP seam). #backend/integrations/github/installation_token.js (KeyedMutex — the per-key single-flight lock built in Task 2.8; REUSE for per-installation coalescence).',
  'GATE: apps/backend/src/backend/** AND libs/**/src/** scanned by scripts/gates/check_clock_random.ts (ERROR-mode) — NO Date.now / new Date() (zero-arg) / Math.random / setTimeout-for-timing. ALL time via the injected Clock (clock.now / clock.monotonic / clock.sleep).',
  'NO NEW DEPS. @opentelemetry/api is ALREADY a dep (see libs/platform/src/observability/metrics.ts which re-exports getMeter); the trace API (trace.getTracer, span.setAttribute, span.end, startActiveSpan) ships in the SAME package. The frozen Python is READ-ONLY at vendor/codemaster-py (venv at ' + PY + ').',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add / commit; NO live network. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (every one must pass; report all_green:false otherwise): (cd ' + REPO + ' && npx vitest run <your test files>) ; (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean ; (cd ' + REPO + ' && npx eslint <your .ts files>) ; (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts) 0 violations.',
].join('\n')

phase('Port')

const PORT_A = [
  'Port the THREE foundational pieces the GitHubAppTokenProvider depends on (Task token-provider, part A of 2): the GitHub-App response contract, the formatException helper, and a tracer seam.',
  STYLE,
  '1) RESPONSE CONTRACT. READ ' + SRC_CONTRACT + '. Port InstallationAccessTokenResponseV1 to ' + REPO + '/libs/contracts/src/installation_access_token_response.v1.ts as a Zod schema (mirror a sibling like installation_token.v1.ts):',
  '   - schema_version: int default 1 ; token: string min(1) ; expires_at: datetime (mirror how installation_token.v1.ts canonicalizes datetime) ; permissions: Record<string,string> default {} ; repository_selection: enum ["all","selected"] nullable, default null.',
  '   - Pydantic model_config is extra="ignore" (DROP unknown keys) + frozen — Zod default .strip() already DROPS unknowns (do NOT use .strict() which rejects, nor .passthrough() which keeps). Export the inferred type. Add a parity test ' + REPO + '/test/contracts/installation_access_token_response.v1.parity.test.ts (mirror a sibling parity test): assert a representative GitHub response payload (with EXTRA unknown keys like single_file_paths) validates identically and the extra keys are dropped in BOTH Pydantic (driven via ' + PY + ') and Zod; assert defaults (permissions {}, repository_selection null, schema_version 1); assert token min(1) rejects "".',
  '2) FORMAT EXCEPTION. READ ' + SRC_ERRORS + ' (format_exception + _format_one). Port to ' + REPO + '/libs/platform/src/errors.ts as formatException(err: unknown, opts?: { includeCause?: boolean }): string. Semantics 1:1: returns "<TypeName>: <message>" and, when includeCause (default true) AND the error has a cause, appends " [caused by <CauseType>: <causemsg>]" — ONE level only (do NOT walk deeper). TypeName = the error constructor name (err.name ?? err.constructor.name; for non-Error throws use the JS type). message = String(err.message) for Errors, else String(err); DEFEND against String() throwing (wrap in try/catch -> "<__str__ raised>" analogue, e.g. "<toString raised>"). Cause = the ES2022 `err.cause` (the analogue of Python __cause__ set by `raise X from Y`). Match the exact format string. Add test ' + REPO + '/test/unit/platform/errors.test.ts: plain error -> "Error: boom"; custom-named error; error with cause -> "Outer: outer [caused by Inner: inner]"; includeCause:false drops the cause; a thrown non-Error (e.g. a string or an object with a throwing toString) is handled defensively; no cause -> no "[caused by ...]".',
  '3) TRACER SEAM. Mirror libs/platform/src/observability/metrics.ts (which re-exports getMeter from @opentelemetry/api). Create ' + REPO + '/libs/platform/src/observability/tracing.ts exporting getTracer(name: string): Tracer (return trace.getTracer(name)) and re-exporting the Span / Tracer / SpanStatusCode types from @opentelemetry/api. Document (mirroring the metrics.ts comment) that trace.getTracer ALWAYS returns a Tracer — a no-op Tracer when no TracerProvider is registered — so subsystem code can emit spans unconditionally. No test needed for the pass-through itself (it is exercised by the provider test in Part B), but ensure tsc + eslint + the clock gate are clean.',
  'Return component="tp_foundations", files_written, commands, all_green, notes (the contract extra-ignore mapping to Zod .strip(), the formatException format string + cause handling, the tracer seam).',
].join('\n')

const portA = await agent(PORT_A, { label: 'port:tp-foundations', phase: 'Port', schema: BUILD_SCHEMA })

const PORT_B = [
  'Port GitHubAppTokenProvider 1:1 to TypeScript (Task token-provider, part B of 2) — the PRODUCTION _TokenProvider the worker wires into the GitHub API client (async __call__(installation_id) -> token string).',
  STYLE,
  'Part A landed: ' + JSON.stringify(portA).slice(0, 400),
  'READ FULLY: ' + SRC_TP + ' (373 lines). Port EVERY symbol. Constants (export, 1:1): GITHUB_BASE_URL="https://api.github.com"; TOKEN_EXCHANGE_PATH="/app/installations/{installation_id}/access_tokens"; DEFAULT_REFRESH_FRACTION=0.8; DEFAULT_MAX_CACHE_ENTRIES=1000; NEGATIVE_CACHE_TTL_SECONDS=60; MAX_5XX_RETRIES=3; INITIAL_BACKOFF_SECONDS=0.5; VAULT_KV_PATH="codemaster/github/app".',
  'PORT TO ' + REPO + '/apps/backend/src/backend/integrations/github/token_provider.ts:',
  'ERRORS: TokenProviderError (extends Error), PermanentTokenError (extends TokenProviderError; non-retryable: bad app id / expired key / deleted installation / malformed response / suspended), TransientTokenError (extends TokenProviderError; retryable: 5xx / network / rate-limit). Set this.name on each.',
  'CACHE ENVELOPE: a CachedToken type { token: string; expiresAt: Date; mintedAt: Date } (process-local; distinct from the wire envelope; carries mintedAt for the precise refresh-at-fraction check).',
  'CLASS GitHubAppTokenProvider with constructor opts { appId: number; privateKeyPem: string; http: GitHubHttpClient; clock: Clock; refreshAtFraction?: number; maxCacheEntries?: number; baseUrl?: string } and the EXACT validation: appId<=0 -> throw (RangeError/Error "app_id must be >= 1, got <n>"); refreshAtFraction NOT in [0.1, 0.95] -> throw; maxCacheEntries<1 -> throw. baseUrl right-trim trailing "/". State: an LRU cache (use a Map<number, CachedToken> with explicit move-to-end on hit AND on put, evict-oldest on overflow — the JS analogue of Python OrderedDict.move_to_end / popitem(last=False)); per-installation single-flight locks (REUSE KeyedMutex from #backend/integrations/github/installation_token.js); a negative cache Map<number, { error: PermanentTokenError; expiresMonotonic: number }>.',
  'static async fromEnv({ vault, http, clock }: { vault: VaultPort; http: GitHubHttpClient; clock: Clock }): Promise<GitHubAppTokenProvider> — secret = await vault.kvRead({ path: VAULT_KV_PATH }); if missing "app_id" or "private_key_pem" -> throw PermanentTokenError (message lists expected app_id, private_key_pem + the sorted got-keys, 1:1 with Python); else construct with appId=Number(secret.app_id), privateKeyPem=secret.private_key_pem. (Vault read failures like VaultPathNotFound PROPAGATE — fail-closed at deployment; do NOT catch.)',
  'async __call__ equivalent — name it getToken(installationId: number): Promise<string> AND make instances callable is NOT required; expose getToken (the GitHubApiClient TokenProvider type is (installationId)=>Promise<string>, so also export a bound helper or document that `provider.getToken.bind(provider)` satisfies it). Semantics 1:1: installationId<=0 -> throw; negative-cache fast-path (if a non-expired PermanentTokenError is cached, THROW it); positive-cache fast-path (cacheLookup hit -> return); else single-flight: acquire the per-installation lock, RE-CHECK the cache inside the lock, else mint.',
  'private mint(installationId): OTel span "github.token.mint" via getTracer (Part A) — startActiveSpan; setAttribute installation_id, cache_hit=false; try exchangeWithRetry -> setAttribute outcome="success" return token; catch PermanentTokenError -> setAttribute outcome="permanent", negativeCache.set(id, { error, expiresMonotonic: clock.monotonic()+NEGATIVE_CACHE_TTL_SECONDS }), rethrow; catch TransientTokenError -> setAttribute outcome="transient", rethrow; FINALLY span.end(). The span is emitted ONLY on actual mints (NOT cache hits).',
  'private async exchangeWithRetry(installationId): sign the JWT via signAppJwt({appId: String(this.appId), privateKeyPem, clock}); a GitHubPrivateKeyMalformed (or ANY signing throw — the Python also catches PyJWTError) -> wrap as PermanentTokenError("private key in Vault is malformed: "+formatException(e)) (use formatException from Part A). Then the retry loop EXACTLY: attempt401Consumed=false; backoff=INITIAL_BACKOFF_SECONDS; url=baseUrl+TOKEN_EXCHANGE_PATH-with-id; for attempt in 0..MAX_5XX_RETRIES INCLUSIVE (i.e. range(MAX_5XX_RETRIES+1) = 4 attempts): try http.request({method:"POST", url, headers:{Accept:"application/vnd.github+json", Authorization:"Bearer "+jwt, "X-GitHub-Api-Version":"2022-11-28"}}); a THROWN transport/network error (httpx.RequestError analogue) -> if attempt<MAX_5XX_RETRIES: await clock.sleep(backoff); backoff*=2; continue; else throw TransientTokenError("network error after <MAX> retries: ..."). On the response status: 401 && !attempt401Consumed -> attempt401Consumed=true, RE-SIGN a fresh JWT, continue (NO sleep, NO backoff change — but it DOES consume a loop iteration); 401 (second) -> PermanentTokenError("...401 twice..."); 403 or 404 -> PermanentTokenError; 500<=status<600 -> if attempt<MAX_5XX_RETRIES: sleep(backoff); backoff*=2; continue; else TransientTokenError("GitHub <status> after <MAX> retries"); status>=400 -> PermanentTokenError; 2xx -> parse JSON.parse(resp.bodyText) through InstallationAccessTokenResponseV1 (Part A) — a validation/parse error -> PermanentTokenError("malformed token-exchange response: ..."); cachePut(id, envelope); return envelope.token. CRITICAL backoff parity: a pure-5xx run sleeps [0.5, 1.0, 2.0] across attempts 0,1,2 then RAISES on attempt 3 (NO sleep on the final). A 401-first run BURNS attempt 0 with no sleep, so a 401-then-5xx-5xx-5xx run raises on attempt 3 having slept [0.5, 1.0].',
  'private cacheLookup(installationId): string | null — Map.get; null if absent; ttlSeconds=(expiresAt-mintedAt) in SECONDS; elapsed=(clock.now()-mintedAt) in SECONDS; if elapsed >= ttlSeconds*refreshAtFraction return null (past refresh boundary -> re-mint); else move-to-end (LRU touch) and return token.',
  'private cachePut(installationId, envelope): build CachedToken{token, expiresAt: envelope.expiresAt, mintedAt: clock.now()}; set + move-to-end; evict oldest (Map insertion-order first key) while size>maxCacheEntries, and on eviction ALSO drop that id from the locks map (memory hygiene — the Python pops self._locks[evicted_id]; if KeyedMutex self-cleans idle keys, document that and replicate the OBSERVABLE no-unbounded-growth).',
  'private checkNegativeCache(installationId): PermanentTokenError | null — get; null if absent; if clock.monotonic() < expiresMonotonic return the stored error; else delete + return null (past TTL -> force re-attempt).',
  'aclose(): Promise<void> — close the injected http if it exposes aclose (idempotent); else no-op.',
  'TEST ' + REPO + '/test/unit/integrations/github/token_provider.test.ts (no DB, no network; FakeClock + a recording stub GitHubHttpClient that scripts a queue of responses/throws and COUNTS requests + a stub VaultPort + a test RSA key or a signAppJwt that the real impl accepts — reuse whatever app_jwt.test.ts uses). Cover: constructor validation (appId<=0, refreshAtFraction out of [0.1,0.95], maxCacheEntries<1); fromEnv reads Vault + missing-keys -> PermanentTokenError + VaultPathNotFound propagates; happy mint caches + second call is a cache HIT (stub request count stays 1, NO second span); refresh-at-fraction (advance FakeClock to just before 0.8*ttl -> hit; at/after 0.8*ttl -> re-mint); LRU eviction (maxCacheEntries=2, mint 3 ids -> oldest evicted, its re-request re-mints); negative cache (a 404 -> PermanentTokenError; immediate retry returns the SAME cached error WITHOUT a new HTTP request; advance monotonic past 60s -> re-attempts); 401-then-200 (re-signs once, succeeds, request count 2); 401-twice -> PermanentTokenError; 403/404 -> PermanentTokenError; 5xx x4 -> TransientTokenError with recordedSleeps [0.5,1.0,2.0]; network-throw then 200 -> retried; malformed 2xx body -> PermanentTokenError; single-flight (fire 10 concurrent getToken for the SAME id against a slow stub -> EXACTLY 1 HTTP request + 1 span; two different ids -> 2); span github.token.mint emitted on mint with outcome attribute (use a hand-rolled recording TracerProvider via trace.setGlobalTracerProvider — minimal getTracer->tracer->startActiveSpan recording {name,attributes}; restore the previous provider in afterEach; NO new deps).',
  'Return component="token_provider", files_written, commands, all_green, notes (the 4-attempt loop + the 401-burns-a-slot subtlety, backoff [0.5,1.0,2.0], the LRU+lock-eviction approach, KeyedMutex reuse, the negative-cache monotonic TTL, the span-recording test approach, and any TS-vs-Python divergence).',
].join('\n')

const portB = await agent(PORT_B, { label: 'port:token-provider', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const BUILT = 'BUILT: foundations=' + JSON.stringify(portA).slice(0, 250) + ' | provider=' + JSON.stringify(portB).slice(0, 350)
const VERIFY_COMMON = [
  STYLE,
  BUILT,
  'You are an ADVERSARIAL verifier — try to REFUTE parity with the frozen Python at ' + SRC_TP + ' (and ' + SRC_CONTRACT + ' / ' + SRC_ERRORS + '). Drive the TS via a throwaway scratch under ' + REPO + '/tools/parity/ (run with npx tsx; DELETE when done; NEVER git-add). Read the frozen Python yourself for ground truth; drive Python via ' + PY + ' where useful. Do NOT run "tsc -p tsconfig.json" (the parent runs whole-project typecheck in validate-fast; your scratch would pollute it) — run check_clock_random + the relevant author test + your tsx scratch.',
].join('\n')

const V1 = [
  'LENS 1 — cache + fromEnv parity. REFUTE that the LRU eviction order, the refresh-at-0.8 boundary, the LRU touch-on-hit, the negative-cache 60s TTL (monotonic), and fromEnv match the frozen Python.',
  VERIFY_COMMON,
  '1. REFRESH-AT-FRACTION: a token minted with ttl T (expiresAt-mintedAt). With refreshAtFraction=0.8: at elapsed = 0.8*T - epsilon -> cache HIT (returns token, no re-mint); at elapsed = 0.8*T exactly -> MISS (re-mint, the >= boundary); at 0.8*T + epsilon -> MISS. Drive via FakeClock.advance. Confirm the boundary is INCLUSIVE (>=) exactly like Python `elapsed >= ttl_seconds * fraction`.',
  '2. LRU EVICTION ORDER: maxCacheEntries=2. Mint id=1, id=2 (cache [1,2]); READ id=1 (LRU touch -> order [2,1]); mint id=3 -> evicts the OLDEST which is now 2 (NOT 1, because the read touched 1). Confirm id=2 re-mints (HTTP) while id=1 is still cached. This proves move-to-end fires on BOTH hit and put, matching OrderedDict.',
  '3. NEGATIVE CACHE: a 404 -> PermanentTokenError cached for 60s keyed by monotonic. Immediately calling again returns the SAME error object/type WITHOUT a new HTTP request (stub request count unchanged). advance monotonic by 59s -> still suppressed; advance to 60s+ -> re-attempts (new HTTP). Confirm it uses clock.monotonic() NOT clock.now() (so a wall-clock jump does not prematurely expire it).',
  '4. FROM_ENV: stub VaultPort.kvRead returns {app_id:"12345", private_key_pem:"..."} -> constructs (appId numeric 12345). Missing either key -> PermanentTokenError naming the expected keys + the sorted present keys. A VaultPathNotFound from kvRead PROPAGATES (not swallowed, fail-closed).',
  'verdict=WEAK if the refresh boundary, the eviction order, the touch-on-hit, the negative-cache axis (monotonic vs wall) / TTL, or fromEnv diverges from Python; SOUND otherwise. Exact diverging sequence for any failure. Run (cd ' + REPO + ' && npx vitest run test/unit/integrations/github/token_provider.test.ts) and (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts). Clean up scratch.',
].join('\n')

const V2 = [
  'LENS 2 — exchangeWithRetry value-for-value vs the frozen Python retry loop. REFUTE the attempt count, backoff sequence, 401-once, and status->error mapping.',
  VERIFY_COMMON,
  'Ground truth: ' + SRC_TP + ' exchange_with_retry (range(MAX_5XX_RETRIES+1) = 4 attempts; INITIAL_BACKOFF 0.5 doubling; the 401 branch re-signs + continues WITHOUT sleeping but BURNS an attempt; 403/404 permanent; 5xx exhaustion transient; >=400 permanent; network error transient-after-retries; malformed 2xx permanent). Drive the TS via scratch with a scripted stub GitHubHttpClient + FakeClock.',
  '1. PURE 5xx: stub returns 500 on every attempt -> TransientTokenError AND FakeClock.recordedSleeps() === [0.5, 1.0, 2.0] (sleeps on attempts 0,1,2; attempt 3 raises with NO sleep). 4 HTTP requests total.',
  '2. 5xx-then-200: [500,500,200] -> success; recordedSleeps === [0.5, 1.0].',
  '3. 401-ONCE: [401,200] -> success, JWT re-signed exactly once, 2 HTTP requests, NO sleep recorded (401 path does not sleep). [401,401] -> PermanentTokenError ("401 twice"). 401-BURNS-A-SLOT: [401,500,500,500] -> TransientTokenError, recordedSleeps === [0.5, 1.0] (attempt0=401 no sleep, attempt1=500 sleep 0.5, attempt2=500 sleep 1.0, attempt3=500 raises). Confirm this exact interaction — it is the subtlest parity point.',
  '4. STATUS MAPPING: 403 -> PermanentTokenError (1 request, no retry); 404 -> PermanentTokenError; 400 -> PermanentTokenError; a 2xx with a malformed/empty body (fails InstallationAccessTokenResponseV1) -> PermanentTokenError("malformed token-exchange response"). A thrown network error on every attempt -> TransientTokenError after the retries (recordedSleeps [0.5,1.0,2.0]).',
  '5. JWT SIGNING ERROR: make signAppJwt throw GitHubPrivateKeyMalformed (e.g. a bogus private_key_pem) -> PermanentTokenError whose message starts "private key in Vault is malformed:" and includes the formatException rendering. No HTTP request is made.',
  'verdict=WEAK if the attempt count, the backoff sequence (including the 401-burns-a-slot case), the 401-once latch, or any status->error class diverges from Python; SOUND otherwise. Exact scripted-response sequence + observed vs expected for any failure. Run the author test + check_clock_random. Clean up scratch.',
].join('\n')

const V3 = [
  'LENS 3 — single-flight coalescence + OTel mint span + formatException + contract parity. REFUTE that concurrency, span emission, the error formatter, and the Zod contract match Python.',
  VERIFY_COMMON,
  '1. SINGLE-FLIGHT: fire N=12 concurrent getToken for the SAME installationId against a stub whose response resolves only after all 12 are in-flight (a deferred promise) -> EXACTLY 1 HTTP request and EXACTLY 1 github.token.mint span; all 12 resolve to the same token. Two DIFFERENT ids concurrently -> 2 requests / 2 spans (independent locks). If >1 request fires for one id, the single-flight lock + in-lock cache re-check is broken -> WEAK.',
  '2. SPAN: github.token.mint is emitted on an ACTUAL mint with attributes installation_id + cache_hit=false + outcome in {success, permanent, transient} (success on 2xx; permanent on 404; transient on 5xx-exhaustion). A CACHE HIT emits NO span (Python only spans inside _mint). Use a recording TracerProvider (trace.setGlobalTracerProvider) to capture span names+attributes; restore afterwards.',
  '3. FORMAT EXCEPTION (libs/platform/src/errors.ts) vs ' + SRC_ERRORS + ': plain Error("boom") -> "Error: boom"; chained (outer.cause = inner) -> "<Outer>: outer [caused by <Inner>: inner]" (ONE level only — a 3-deep chain shows only the first cause); includeCause:false -> head only; a value whose toString throws -> the defensive marker, no crash. Diff a few cases against Python format_exception driven via ' + PY + '.',
  '4. CONTRACT (installation_access_token_response.v1.ts) vs ' + SRC_CONTRACT + ': a full GitHub payload with EXTRA keys (single_file_paths, has_multiple_single_files) validates in BOTH and DROPS the extras (Zod .strip() == Pydantic extra="ignore"); permissions defaults to {}, repository_selection defaults to null, schema_version to 1; token="" rejected in BOTH; repository_selection="bogus" rejected in BOTH (Literal["all","selected"]).',
  'verdict=WEAK if concurrent same-id calls produce >1 mint, the span is emitted on cache hits or omits attributes or is missing on mint, formatException diverges, or the contract keeps/rejects differently from Pydantic; SOUND otherwise. Exact reproduction for any failure. Run (cd ' + REPO + ' && npx vitest run test/unit/integrations/github/token_provider.test.ts test/contracts/installation_access_token_response.v1.parity.test.ts test/unit/platform/errors.test.ts) and check_clock_random. Clean up scratch.',
].join('\n')

const verifications = await parallel([
  () => agent(V1, { label: 'verify:cache-fromenv', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V2, { label: 'verify:exchange-retry', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V3, { label: 'verify:singleflight-span-contract', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

return { portA, portB, verify: { cacheFromEnv: verifications[0], exchangeRetry: verifications[1], singleflightSpanContract: verifications[2] } }
