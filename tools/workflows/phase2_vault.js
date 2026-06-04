export const meta = {
  name: 'phase2-vault',
  description: 'Phase 2.13: Vault KV-v2 + Transit adapter — VaultPort + InMemoryVault + VaultHttpPort (CAS, versioned read, retry/backoff, token-on-every-call, redaction)',
  phases: [
    { title: 'Port', detail: 'vault_port.ts (Protocol+errors+InMemoryVault) then vault_http.ts (VaultHttpPort + injected fetch transport)' },
    { title: 'Verify', detail: 'adversarial 3-lens: InMemoryVault parity vs Python, HTTP request-shape+error-mapping, retry/backoff/Clock + token-rotation + redaction' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const SRC_PORT = REPO + '/vendor/codemaster-py/codemaster/adapters/vault_port.py'
const SRC_HTTP = REPO + '/vendor/codemaster-py/codemaster/adapters/vault_http.py'

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
  'TS STYLE (ENFORCED by validate-fast = gates -> lint -> typecheck -> test): ESM .js import specifiers; "type" alias not "interface"; Array<T> not T[]; NO "any" (use unknown + narrowing); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES but camelCase methods/vars (mirror the repo: GitHubApiClient.getPr, acquirePrReviewMutex).',
  'IMPORTS: Node subpath aliases #contracts/*, #platform/*, #backend/* for cross-dir; same-dir is relative ./x.js. The Clock seam is #platform/clock.js (Clock type: now(): Date, sleep(seconds): Promise<void>, monotonic(): number; WallClock prod; FakeClock test with recordedSleeps(): ReadonlyArray<number>).',
  'GATE: apps/backend/src/backend/** is scanned by scripts/gates/check_clock_random.ts (ERROR-mode) — NO Date.now / new Date() (zero-arg) / Math.random / setTimeout for timing. ALL backoff sleeps go through the injected #platform Clock (clock.sleep). fs reads are allowed.',
  'NO NEW DEPS. NO DATABASE (this adapter is HTTP+in-memory only). Production HTTP uses Node global fetch (undici); tests inject a stub transport. The frozen Python is READ-ONLY at vendor/codemaster-py (venv at ' + PY + ').',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add / commit; NO live network. You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (every one must pass; report all_green:false otherwise): (cd ' + REPO + ' && npx vitest run <your test file>) ; (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean ; (cd ' + REPO + ' && npx eslint <your .ts files>) ; (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts) 0 violations.',
].join('\n')

phase('Port')

const PORT_A = [
  'Port the Vault adapter PORT + in-memory fake 1:1 to TypeScript (Task 2.13, part A of 2). This is the typed interface + test double the whole secrets layer depends on.',
  STYLE,
  'READ FULLY: ' + SRC_PORT + ' (155 lines). It contains: the VaultPort Protocol (6 async methods), 4 typed exceptions, and InMemoryVault (the test impl).',
  'PORT TO ' + REPO + '/apps/backend/src/backend/adapters/vault_port.ts (create the adapters/ dir — it mirrors the Python codemaster/adapters/ package; it does not exist yet):',
  '1. VaultPort type alias (NOT interface) with 6 methods, camelCase, args-object style, EXACT semantics from the docstrings:',
  '   - kvWrite(args: { path: string; data: Record<string,string>; cas?: number }): Promise<number> — writes secret material, returns the NEW version int. If cas is provided, write succeeds only if current version === cas (Vault check-and-set), else throws VaultCasMismatch.',
  '   - kvRead(args: { path: string; version?: number }): Promise<Record<string,string>> — version undefined => latest.',
  '   - kvCurrentVersion(args: { path: string }): Promise<number> — 0 if path absent.',
  '   - kvDelete(args: { path: string }): Promise<void> — deletes ALL versions; idempotent (deleting absent path is a no-op); a subsequent read throws VaultPathNotFound.',
  '   - transitEncrypt(args: { keyName: string; plaintext: Uint8Array }): Promise<string> — returns ciphertext blob.',
  '   - transitDecrypt(args: { keyName: string; ciphertext: string }): Promise<Uint8Array>.',
  '2. Error classes (each extends Error, set this.name; mirror the GitHub errors in apps/backend/src/backend/integrations/github/api_client.ts for the idiom): VaultError (base), VaultCasMismatch, VaultPathNotFound, VaultConnectivityError — all extend VaultError except VaultError extends Error. Keep the docstring meanings (VaultConnectivityError = unreachable, retryable by caller).',
  '3. InMemoryVault class implementing VaultPort, EXACT semantics 1:1 with the Python:',
  '   - state: a Map<string, Array<Record<string,string>>> for kv (versions are 1-indexed in the public API: version N is array index N-1); a transit fixture (Map<keyName, Map<ciphertext, Uint8Array>>); a transit counter; an unreachable flag.',
  '   - kvWrite: if unreachable throw VaultConnectivityError("simulated connectivity failure"); current = versions.length; if cas !== undefined && cas !== current throw VaultCasMismatch (message like "cas=<cas> but current=<current>"); push a COPY of data; return new length.',
  '   - kvRead: unreachable -> throw; path absent or empty array -> throw VaultPathNotFound(path); idx = (version ?? length) - 1; idx<0 or idx>=length -> throw VaultPathNotFound("<path> version=<version>"); return a COPY of the stored record.',
  '   - kvCurrentVersion: unreachable -> throw; return versions.length (0 if absent).',
  '   - kvDelete: unreachable -> throw; delete the map entry (idempotent).',
  '   - transitEncrypt: unreachable -> throw; counter += 1; ciphertext = "vault:v1:" + keyName + ":" + counter; store plaintext under (keyName, ciphertext); return ciphertext.',
  '   - transitDecrypt: unreachable -> throw; look up (keyName, ciphertext) and return the bytes (throw if absent, mirroring Python KeyError -> let it surface; an out-of-fixture decrypt is a test-programming error).',
  '   - simulateUnreachable(value = true): void — toggles the unreachable flag (test-only API; Python simulate_unreachable).',
  'IMPORTANT: bytes. Python transit uses bytes; in TS use Uint8Array. Comparisons in tests use Buffer.compare or [...a] equality. Preserve copy-on-read/copy-on-write so callers cannot mutate stored state (Python does dict(data) / dict(...)).',
  'TEST ' + REPO + '/test/unit/adapters/vault_port.test.ts (no DB, no network; pure InMemoryVault). Cover, with watch-it-fail discipline noted in comments: write returns v1 then v2 (monotonic versions); read latest vs read explicit version; read missing path -> VaultPathNotFound; read out-of-range version -> VaultPathNotFound; cas matches current -> writes; cas mismatch -> VaultCasMismatch; kvCurrentVersion 0 for absent then increments; delete then read -> VaultPathNotFound; delete absent path -> no throw (idempotent); transit encrypt then decrypt round-trips the exact bytes; two encrypts of the SAME plaintext yield DIFFERENT ciphertext blobs (counter); simulateUnreachable(true) makes EVERY method throw VaultConnectivityError, simulateUnreachable(false) restores; stored data is copied (mutating the returned record does not change a subsequent read).',
  'Return component="vault_port", files_written, commands (each with passed + detail), all_green, notes (any TS-vs-Python divergence — e.g. bytes->Uint8Array, the 1-indexed version mapping, copy semantics).',
].join('\n')

const portA = await agent(PORT_A, { label: 'port:vault-port', phase: 'Port', schema: BUILD_SCHEMA })

const PORT_B = [
  'Port the Vault production HTTP adapter 1:1 to TypeScript (Task 2.13, part B of 2). It implements the VaultPort interface over real HTTP (KV-v2 + Transit), with token-from-disk-on-every-call, retry/backoff via the Clock seam, and strict token redaction.',
  STYLE,
  'Part A already landed apps/backend/src/backend/adapters/vault_port.ts: ' + JSON.stringify(portA).slice(0, 500),
  'IMPORT the error classes + VaultPort type from ./vault_port.js (same dir, relative).',
  'READ FULLY: ' + SRC_HTTP + ' (274 lines). Constants (port EXACTLY): DEFAULT_TOKEN_PATH = "/var/run/secrets/vault/token"; DEFAULT_TIMEOUT_SECONDS = 5.0; MAX_RETRIES = 3; INITIAL_BACKOFF_SECONDS = 0.5.',
  'PORT TO ' + REPO + '/apps/backend/src/backend/adapters/vault_http.ts:',
  'A) An INJECTED HTTP transport seam (mirror GitHubHttpClient in integrations/github/api_client.ts): export type VaultHttpResponse = { status: number; headers: Record<string,string>; bodyText: string }; export type VaultHttpRequestArgs = { method: string; url: string; headers: Record<string,string>; jsonBody?: unknown }; export type VaultHttpClient = { request(args: VaultHttpRequestArgs): Promise<VaultHttpResponse> }. Production impl FetchVaultHttpClient implements VaultHttpClient using global fetch: JSON.stringify(jsonBody) as body + Content-Type application/json when jsonBody is present; map fetch network errors to a thrown transport error the retry loop catches (mirror httpx.HTTPError handling). Honor the timeout (AbortSignal.timeout(timeoutSeconds*1000)) — a timeout/abort is a transport error (retryable).',
  'B) VaultHttpPort class implementing VaultPort. Constructor opts: { addr: string; tokenPath?: string; token?: string; kvMount?: string; transitMount?: string; timeoutSeconds?: number; http?: VaultHttpClient; clock?: Clock } with defaults kvMount="secret", transitMount="transit", timeoutSeconds=DEFAULT_TIMEOUT_SECONDS, tokenPath=DEFAULT_TOKEN_PATH, http=new FetchVaultHttpClient({timeoutSeconds}), clock=new WallClock(). addr is right-trimmed of trailing "/".',
  'C) static fromEnv(): VaultHttpPort — VAULT_ADDR required (throw VaultConnectivityError("VAULT_ADDR env var unset; cannot construct VaultHttpPort") if unset); if VAULT_TOKEN set -> direct token; else tokenPath = VAULT_AGENT_TOKEN_PATH ?? DEFAULT_TOKEN_PATH.',
  'D) private readToken(): string (or Promise<string>) — if a direct token was provided return it; else read the token FILE and .trim() it. Use fs (await fs.promises.readFile(tokenPath, "utf8")).trim() OR readFileSync — but it MUST be re-read on EVERY request attempt (Vault Agent rotates the token on disk; Python reads it at the TOP OF EACH retry attempt inside the loop). On read failure throw VaultConnectivityError("vault token file unreadable") — NEVER include the token path or token in the message (sterile logs).',
  'E) private request(method, path, jsonBody?): Promise<VaultHttpResponse> — the retry loop EXACTLY like Python: backoff starts at INITIAL_BACKOFF_SECONDS; for attempt in 0..MAX_RETRIES-1: read the token (per-attempt), call http.request({ method, url: addr+path, headers: { "X-Vault-Token": token }, jsonBody }); on transport error -> if not last attempt: await clock.sleep(backoff); backoff *= 2; continue; else throw VaultConnectivityError; on 5xx (500<=status<600) -> same retry-then-throw; otherwise return resp. Token-redaction: any log line MUST carry only { attempt, method, path, status } — NEVER the token. If the repo has a logger seam use it; else a minimal console.info with NO token is fine (but prefer no logging over risky logging).',
  'F) The six VaultPort methods with EXACT URL shapes + status mapping (read the Python precisely):',
  '   - kvRead: GET /v1/<kvMount>/data/<path> with ?version=<v> appended ONLY when version is truthy. 404 -> VaultPathNotFound(path); status>=400 -> VaultConnectivityError; parse JSON body.data.data -> Record; missing/non-object -> VaultConnectivityError("kv_read <path>: unexpected response shape").',
  '   - kvWrite: POST /v1/<kvMount>/data/<path> jsonBody { data } plus { options: { cas } } ONLY when cas !== undefined. status===400 AND cas provided -> VaultCasMismatch("cas mismatch on <path>"); status>=400 -> VaultConnectivityError; return int(body.data.version); unparseable -> VaultConnectivityError unexpected-shape.',
  '   - kvDelete: DELETE /v1/<kvMount>/metadata/<path>. status in {200,204,404} -> return (idempotent); else VaultConnectivityError.',
  '   - kvCurrentVersion: GET /v1/<kvMount>/metadata/<path>. (Python wraps the request in try/except VaultPathNotFound -> return 0; request() itself never raises VaultPathNotFound, so this is defensive — replicate it harmlessly.) status===404 -> 0; status>=400 -> VaultConnectivityError; return int(body.data.current_version).',
  '   - transitEncrypt: POST /v1/<transitMount>/encrypt/<keyName> jsonBody { plaintext: base64(plaintext) } (Buffer.from(plaintext).toString("base64")). status>=400 -> VaultConnectivityError; return body.data.ciphertext (string).',
  '   - transitDecrypt: POST /v1/<transitMount>/decrypt/<keyName> jsonBody { ciphertext }. status>=400 -> VaultConnectivityError; return base64-decode body.data.plaintext (Buffer.from(b64, "base64") -> Uint8Array).',
  'G) aclose()/dispose if FetchVaultHttpClient owns anything (fetch does not, so likely a no-op; only add if you allocate a resource).',
  'TEST ' + REPO + '/test/unit/adapters/vault_http.test.ts using a programmable in-memory stub VaultHttpClient (records requests; returns scripted responses) + FakeClock + temp token files (os.tmpdir):',
  '   - kvRead happy: stub returns 200 { data: { data: { k: "v" } } } -> returns { k: "v" }; asserts the recorded request was GET /v1/secret/data/foo with X-Vault-Token header; version=2 appends ?version=2.',
  '   - kvRead 404 -> VaultPathNotFound; kvRead 500 (after exhausting retries) -> VaultConnectivityError; kvRead 200 with wrong shape -> VaultConnectivityError unexpected-shape.',
  '   - kvWrite happy: 200 { data: { version: 3 } } -> 3; recorded POST body { data: {...} }; with cas=2 the body has options.cas=2; status 400 WITH cas -> VaultCasMismatch; status 400 WITHOUT cas -> VaultConnectivityError; status 403 -> VaultConnectivityError.',
  '   - kvDelete: 204 -> ok; 200 -> ok; 404 -> ok (idempotent); 500 (after retries) -> VaultConnectivityError; recorded DELETE /v1/secret/metadata/foo.',
  '   - kvCurrentVersion: 200 { data: { current_version: 5 } } -> 5; 404 -> 0.',
  '   - transitEncrypt: 200 { data: { ciphertext: "vault:v1:..." } } -> that string; recorded body.plaintext is base64 of the input bytes. transitDecrypt: 200 { data: { plaintext: base64("hello") } } -> bytes of "hello".',
  '   - RETRY/BACKOFF: stub returns 500,500,200 -> succeeds; FakeClock.recordedSleeps() === [0.5, 1.0]. stub returns 500,500,500 -> VaultConnectivityError; recordedSleeps === [0.5, 1.0] (no sleep on the final failed attempt). A transport error then 200 -> retried.',
  '   - TOKEN ON EVERY ATTEMPT: with a token FILE (not direct token), point tokenPath at a temp file containing "tok-1"; on a 500-then-200 sequence, REWRITE the file to "tok-2" before the retry (use the stub callback) and assert attempt 1 sent X-Vault-Token tok-1 and attempt 2 sent tok-2 (per-attempt re-read). Also: missing token file -> VaultConnectivityError("vault token file unreadable") and the message contains NEITHER the path NOR a token.',
  '   - TOKEN REDACTION: capture all console output during a multi-attempt request; assert the token string NEVER appears in any captured log line.',
  'Return component="vault_http", files_written, commands, all_green, notes (constants confirmed, the per-attempt token re-read, the backoff progression [0.5,1.0], the status->error mapping table, the redaction approach, fetch-timeout handling).',
].join('\n')

const portB = await agent(PORT_B, { label: 'port:vault-http', phase: 'Port', schema: BUILD_SCHEMA })

phase('Verify')

const BUILT = 'BUILT: vault_port=' + JSON.stringify(portA).slice(0, 300) + ' | vault_http=' + JSON.stringify(portB).slice(0, 400)

const VERIFY_COMMON = [
  STYLE,
  BUILT,
  'You are an ADVERSARIAL verifier — try to REFUTE parity with the frozen Python, do not just re-run the author tests. Drive the TS via a throwaway scratch under ' + REPO + '/tools/parity/ (RUN it with npx tsx so per-file transpile is lenient; DELETE it when done; NEVER git-add). Read the frozen Python yourself for ground truth. Do NOT run "tsc -p tsconfig.json" (the parent runs whole-project typecheck in validate-fast and your scratch would pollute it) — instead run check_clock_random + the relevant author test + your tsx scratch.',
].join('\n')

const V1 = [
  'LENS 1 — InMemoryVault behavioral parity vs the frozen Python InMemoryVault. REFUTE that the CAS / versioning / not-found / transit / unreachable semantics match value-for-value.',
  VERIFY_COMMON,
  'Ground truth: ' + SRC_PORT + ' (the InMemoryVault class). Drive Python via ' + PY + ' -c "..." importing codemaster.adapters.vault_port (asyncio.run an async sequence).',
  'Run the SAME operation sequence against BOTH Python InMemoryVault and the TS InMemoryVault (scratch tools/parity/_vault_mem_scratch.ts) and assert identical observable results:',
  '1. write(path, {a:1}) -> 1; write(path, {a:2}) -> 2; write(path, {a:3}) -> 3 (monotonic versions, same in both).',
  '2. read(path) === {a:3} (latest); read(path, version=1) === {a:1}; read(path, version=2) === {a:2}.',
  '3. read(missing) -> VaultPathNotFound in BOTH; read(path, version=99) -> VaultPathNotFound in BOTH; read(path, version=0) -> VaultPathNotFound in BOTH (idx becomes -1).',
  '4. CAS: currentVersion(p2)=0 -> write(p2,{x:1},cas=0) -> 1 -> write(p2,{x:2},cas=1) -> 2 -> write(p2,{x:9},cas=0) -> VaultCasMismatch in BOTH (cas=0 but current=2). After the mismatch, currentVersion still 2 (no phantom write).',
  '5. delete(path) then read(path) -> VaultPathNotFound; delete(absent) -> no error (idempotent) in BOTH.',
  '6. transit: encrypt(k, b"hello") then decrypt -> b"hello"; encrypt the SAME bytes twice -> two DISTINCT ciphertext blobs (counter increments) in BOTH; the ciphertext format "vault:v1:<key>:<n>" matches.',
  '7. simulateUnreachable(true): EVERY method (write/read/currentVersion/delete/encrypt/decrypt) raises VaultConnectivityError in BOTH; simulateUnreachable(false) restores normal behavior.',
  'verdict=WEAK if ANY version number, error type, or transit behavior diverges between Python and TS; SOUND if they match value-for-value. Give exact diverging inputs+outputs for any failure. Run (cd ' + REPO + ' && npx vitest run test/unit/adapters/vault_port.test.ts) and (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts). Clean up scratch.',
].join('\n')

const V2 = [
  'LENS 2 — VaultHttpPort HTTP request-shape + status->error mapping parity vs the frozen Python. REFUTE that the URLs, JSON bodies, headers, and error mapping match.',
  VERIFY_COMMON,
  'Ground truth: ' + SRC_HTTP + ' (the KV-v2 + Transit methods + the 400/404/>=400 mapping). Drive the TS VaultHttpPort via scratch tools/parity/_vault_http_scratch.ts with a RECORDING stub VaultHttpClient (captures every {method,url,headers,jsonBody} and returns scripted responses).',
  'Assert EXACT request shapes (kvMount=secret, transitMount=transit, addr="https://vault.example:8200"):',
  '1. kvRead({path:"a/b"}) -> GET https://vault.example:8200/v1/secret/data/a/b (NO ?version when undefined). kvRead({path:"a/b", version:3}) -> ...?version=3. Header X-Vault-Token present. 200 {data:{data:{k:"v"}}} -> {k:"v"}.',
  '2. kvWrite({path:"a/b", data:{k:"v"}}) -> POST /v1/secret/data/a/b jsonBody EXACTLY {data:{k:"v"}} (NO options). With cas:2 -> jsonBody {data:{k:"v"}, options:{cas:2}}. 200 {data:{version:7}} -> 7.',
  '3. kvDelete({path:"a/b"}) -> DELETE /v1/secret/metadata/a/b. kvCurrentVersion({path:"a/b"}) -> GET /v1/secret/metadata/a/b ; 200 {data:{current_version:4}} -> 4.',
  '4. transitEncrypt({keyName:"k", plaintext: bytes("hi")}) -> POST /v1/transit/encrypt/k jsonBody {plaintext: base64("hi")="aGk="}. transitDecrypt({keyName:"k", ciphertext:"CT"}) -> POST /v1/transit/decrypt/k jsonBody {ciphertext:"CT"}; 200 {data:{plaintext: base64("hi")}} -> bytes("hi").',
  'Assert the STATUS->ERROR mapping table value-for-value with Python: kvRead 404->VaultPathNotFound, kvRead 401/403/422->VaultConnectivityError, kvRead 200-wrong-shape->VaultConnectivityError(unexpected shape); kvWrite 400+cas->VaultCasMismatch, kvWrite 400-no-cas->VaultConnectivityError, kvWrite 403->VaultConnectivityError; kvDelete 200/204/404->OK, kvDelete 500->VaultConnectivityError(after retries), kvDelete 403->VaultConnectivityError; kvCurrentVersion 404->0, 403->VaultConnectivityError; transit*>=400->VaultConnectivityError. Also confirm addr trailing "/" is trimmed (construct with addr="https://vault.example:8200/" and assert URLs have no double slash).',
  'verdict=WEAK if any URL path, JSON body shape, header, base64 encoding, or status->error mapping diverges from Python; SOUND otherwise. Exact diverging request/response for any failure. Run (cd ' + REPO + ' && npx vitest run test/unit/adapters/vault_http.test.ts) and (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts). Clean up scratch.',
].join('\n')

const V3 = [
  'LENS 3 — retry/backoff + Clock seam + token-on-every-attempt + token redaction. REFUTE that the timing, the per-attempt token re-read, and the no-token-in-logs discipline match the frozen Python.',
  VERIFY_COMMON,
  'Ground truth: ' + SRC_HTTP + ' (the _request retry loop, _read_token, the logging.extra fields). Drive the TS via scratch tools/parity/_vault_retry_scratch.ts with a scripted stub + FakeClock + temp token files (node:os tmpdir + node:fs).',
  '1. BACKOFF: constants MAX_RETRIES=3, INITIAL_BACKOFF_SECONDS=0.5, pure doubling. stub [500,500,200] -> success AND FakeClock.recordedSleeps() === [0.5, 1.0] EXACTLY. stub [500,500,500] -> VaultConnectivityError AND recordedSleeps() === [0.5, 1.0] (the final failed attempt does NOT sleep). A transport error (thrown by the stub) on attempt 0 then 200 -> retried (sleep [0.5]).',
  '2. CLOCK SEAM: (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts) reports 0 violations — confirm vault_http.ts contains NO setTimeout / Date.now / new Date() (zero-arg) for timing; ALL sleeps go through clock.sleep. Grep the file to be sure.',
  '3. TOKEN ON EVERY ATTEMPT: construct with tokenPath pointing at a temp file (NOT a direct token). File starts "tok-1". Script the stub so that on attempt 0 it returns 500 (and your stub callback REWRITES the file to "tok-2" before resolving), attempt 1 returns 200. Assert attempt 0 sent X-Vault-Token=tok-1 and attempt 1 sent X-Vault-Token=tok-2 (per-attempt re-read, mirroring Python reading the token at the top of each loop iteration). If the token is read once and cached, that is WEAK.',
  '4. TOKEN FILE UNREADABLE: missing token file -> VaultConnectivityError whose message is EXACTLY "vault token file unreadable" and contains NEITHER the file path NOR any token substring.',
  '5. REDACTION: capture ALL console output (monkeypatch console.info/warn/error/log) across a [500,500,200] request whose token is a recognizable sentinel like "SUPERSECRET-TOKEN-XYZ". Assert that sentinel NEVER appears in ANY captured log line. (Python asserts test_no_token_in_logs.)',
  'verdict=WEAK if the backoff sequence diverges, timing bypasses the Clock, the token is cached instead of re-read per attempt, the unreadable-file message leaks the path/token, or the token appears in any log; SOUND otherwise. Exact reproduction for any failure. Run (cd ' + REPO + ' && npx vitest run test/unit/adapters/vault_http.test.ts) too. Clean up scratch.',
].join('\n')

const verifications = await parallel([
  () => agent(V1, { label: 'verify:inmemory-parity', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V2, { label: 'verify:http-shape', phase: 'Verify', schema: VERIFY_SCHEMA }),
  () => agent(V3, { label: 'verify:retry-token-redaction', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

return { portA, portB, verify: { inmemory: verifications[0], httpShape: verifications[1], retryToken: verifications[2] } }
