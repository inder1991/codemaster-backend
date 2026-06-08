// LlmClient — 1:1 port of the PARITY-CRITICAL transform of
// vendor/codemaster-py/codemaster/integrations/llm/client.py::LlmClient.invoke_model /
// _invoke_model_impl (lines ~318-584, frozen Python).
//
// SCOPE (replay-seam slice). The OBSERVABLE OUTPUT of bedrock_review_chunk is a DETERMINISTIC pure
// transform of the (cassette) LLM response: content extraction, raw_content_blocks, token usage, stop
// reason, output-safety blocking, and the LlmInvokeResultV1 build. THOSE are ported here in full and
// byte-faithfully (Python lines 491-584).
//
// The production side-effects are NOT on the observable-output path, so they are modeled as INJECTED
// collaborator Protocols. The two REAL production side-effects — cost-cap + blob — are REQUIRED
// constructor args (no in-module default), so there is NO faking stub on the production path:
//   - CostCap        — pre-call check + post-call record. REQUIRED. Production injects the REAL
//                      `PostgresCostCapEnforcer` (the always-on path the frozen worker wires); unit /
//                      cassette tests inject the `InMemoryCostCapEnforcer` test double explicitly. A
//                      pre-call deny raises BedrockBudgetExceededError (that IS observable — it
//                      short-circuits the activity into a non-retryable ApplicationFailure). There is
//                      deliberately no allow-all default: an un-injected cost-cap is a wiring bug, not a
//                      silent fall-through to "spend without a cap".
//   - BlobStore      — request/response payload archive. REQUIRED. Production injects the REAL
//                      `BlobStorePostgresAdapter`; tests inject the in-memory `InMemoryBlobStoreAdapter`
//                      test double explicitly. The archive BlobRef is the `payload_blob_ref` of the
//                      result, so the injected store must produce a well-formed BlobRef.
//   - ArchiveRedactor — PII/secret redaction of archived payloads. Default: the REAL ported
//                      `redactPii` (#backend/redact/pii_redactor.js), wrapping the Python
//                      RegexPiiRedactor the frozen client wires by default — NOT a no-op. The Python
//                      `_archive_redactor or RegexPiiRedactor()` default is the real redactor, so the
//                      TS default matches it (the in-memory cassette path archives redacted bytes too).
//   - telemetry      — the Python writes a telemetry.llm_calls row on BOTH the success and failure
//                      paths (status ok/failed/timeout) so cost telemetry stays accurate even when the
//                      SDK raises. This is now WIRED (de-stub part 2): the REAL
//                      `PostgresLlmCallsTelemetryWriter` (Kysely seam, ADR-0062) INSERTs into
//                      telemetry.llm_calls. The default is a no-op recorder (the cassette dual-run has
//                      no DB and asserts nothing on the row — faithful to the Python cassette test,
//                      which wires an in-memory enforcer and never reads the llm_calls row); the
//                      production `LlmClientCache` injects the real writer (the always-on path).
//   - Langfuse     — the Python's fire-and-forget Langfuse trace. NOW WIRED (de-stub part 4) as an
//                      INJECTED collaborator ({@link LangfuseExporterPort}) defaulting to the
//                      {@link DISABLED_LANGFUSE_EXPORTER} no-op — the structural analogue of the Python
//                      `self._langfuse is None` early-return. The production `LlmClientCache` injects
//                      `LangfuseExporter.fromEnv()`, which is ITSELF env-gated OFF (no POST) until
//                      LANGFUSE_HOST / LANGFUSE_API_KEY are set — faithfully OFF when unconfigured, NOT
//                      a stub. The export is fire-and-forget: it builds a {@link BedrockTraceV1} from the
//                      call params + redacted snippets and calls `exporter.export(...)`, on BOTH the
//                      success (status ok/failed from output-safety) and the SDK-error (failed/timeout)
//                      paths, exactly where the Python `_maybe_export_langfuse_trace` is called. It NEVER
//                      affects the return / raise (the exporter swallows its own errors).
//   - OTel         — the wrapping OTel span is env-gated off unless configured in Python and is
//                      INTENTIONALLY not wired here — faithfully OFF, NOT a stub. A separate workflow.
//
// Output-safety IS on the observable path (it can BLOCK), so the REAL ported OutputSafetyValidator is
// wired (injected, defaulting to a fresh real validator) and a block raises the REAL ported
// LlmOutputUnsafeError carrying decision + raw_content_blocks + content_text + request_id.
//
// Clock/random discipline (clock_random gate): latency uses the platform Clock.monotonic() seam (the
// Python `time.perf_counter()`); request_id is minted via the platform SystemRandom seam (the Python
// `uuid.uuid4()`). NO raw Date.now / Math.random.

import { type Kysely, sql } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { tenantKysely } from "#platform/db/database.js";
import { SystemRandom } from "#platform/randomness.js";

import { BedrockBudgetExceededError, CostCapLockTimeoutError, type CostCapEnforcer } from "#backend/cost/enforcer.js";
import {
  type LangfuseExporterPort,
  DISABLED_LANGFUSE_EXPORTER,
  redactSnippet,
} from "#backend/observability/langfuse_exporter.js";
import { redactPii } from "#backend/redact/pii_redactor.js";
import { OutputSafetyValidator } from "#backend/security/output_safety.js";

import { LlmInvocationError, LlmOutputUnsafeError } from "./errors.js";
import { hashMessagesForLedger, type LlmInvocationLedgerPort } from "./invocation_ledger.js";

import type { BlobRef } from "#contracts/blob_ref.v1.js";
import { LlmInvokeResultV1 } from "#contracts/llm_invoke_result.v1.js";
import { BedrockTraceV1 } from "#contracts/llm_trace.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";

// ─── documented model set (BEDROCK_MODELS) ─────────────────────────────────────────────────────────

/** Documented model set. Adding a model requires an ADR + cost-cap coverage review. */
export const BEDROCK_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;
export type BedrockModel = (typeof BEDROCK_MODELS)[number];

// ─── cost estimation (rough; mirrors the Python module-level tables) ───────────────────────────────

const USD_CENTS_PER_PROMPT_TOKEN: ReadonlyMap<string, number> = new Map([
  ["claude-opus-4-7", 0.0015],
  ["claude-sonnet-4-6", 0.0003],
  ["claude-haiku-4-5-20251001", 0.000025],
]);
const USD_CENTS_PER_COMPLETION_TOKEN: ReadonlyMap<string, number> = new Map([
  ["claude-opus-4-7", 0.0075],
  ["claude-sonnet-4-6", 0.0015],
  ["claude-haiku-4-5-20251001", 0.000125],
]);

/** Coarse pre-call estimate — true cost computed post-response. Mirrors `_estimate_cents_pre_call`. */
function estimateCentsPreCall(model: string, promptChars: number): number {
  // Crude tokenizer proxy: 4 chars/token (Python `prompt_chars // 4`, floor division).
  const estimatedPromptTokens = Math.max(1, Math.floor(promptChars / 4));
  const estimatedCompletionTokens = 1024; // conservative ceiling
  const cents =
    estimatedPromptTokens * (USD_CENTS_PER_PROMPT_TOKEN.get(model) ?? 0.0) +
    estimatedCompletionTokens * (USD_CENTS_PER_COMPLETION_TOKEN.get(model) ?? 0.0);
  return Math.max(1, Math.trunc(cents));
}

/** Post-response final cost. Mirrors `_final_cents`. */
function finalCents(model: string, promptTokens: number, completionTokens: number): number {
  const cents =
    promptTokens * (USD_CENTS_PER_PROMPT_TOKEN.get(model) ?? 0.0) +
    completionTokens * (USD_CENTS_PER_COMPLETION_TOKEN.get(model) ?? 0.0);
  return Math.max(1, Math.trunc(cents));
}

// ─── injected collaborator Protocols ───────────────────────────────────────────────────────────────

/**
 * The minimal interface the client needs from the SDK (mirrors the Python `_AsyncLlmSdk` Protocol).
 * The real SDK is `anthropic.AsyncAnthropicBedrock(...).messages.create(...)`; the cassette stub
 * returns the recorded response dict. NO @anthropic-ai/* import in this slice — the SDK is this
 * Protocol, satisfied by the cassette stub.
 */
export type LlmSdk = {
  createMessage(args: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    tools: Array<Record<string, unknown>> | null;
    role: "primary" | "secondary";
  }): Promise<Record<string, unknown>>;
};

/**
 * The archive store the client writes request/response payloads to (mirrors the slice of `BlobStorePort`
 * the client uses — `put` only). REQUIRED at construction: production injects the REAL
 * `BlobStorePostgresAdapter`; tests inject the in-memory `InMemoryBlobStoreAdapter` double.
 */
export type BlobStore = {
  put(args: {
    installationId: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<BlobRef>;
};

/**
 * Redacts archived payload text before it is stored (mirrors `PiiRedactorPort`). Default: the REAL
 * ported `redactPii` (RegexPiiRedactor), so raw PII / secrets never land in telemetry.llm_payloads —
 * the Python client defaults to `RegexPiiRedactor()`.
 */
export type ArchiveRedactor = {
  redact(text: string): string;
};

/**
 * Persists one `telemetry.llm_calls` row per invocation (mirrors the Python inline INSERT +
 * `_record_failure`). The frozen Python writes this row on BOTH the success and failure paths so cost
 * telemetry stays accurate even when the SDK raises. Default: a no-op recorder (the cassette dual-run
 * has no DB); the production `LlmClientCache` injects {@link PostgresLlmCallsTelemetryWriter}.
 */
export type LlmCallsTelemetryWriter = {
  /**
   * Write one `telemetry.llm_calls` row. The `status` is the validator-aware status on the success path
   * (`ok` / `failed`) and the failure status on the SDK-error path (`failed` / `timeout`). On the
   * failure path `promptTokens` / `completionTokens` / `costUsdCents` are all 0 (tokens were never
   * counted), matching the Python `_record_failure` literal-zero INSERT.
   */
  recordCall(args: {
    installationId: string;
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    costUsdCents: number;
    status: "ok" | "failed" | "timeout";
    createdAt: Date;
  }): Promise<void>;
};

// ─── default collaborators (all REAL or no-op-observability — NO faking stubs) ───────────────────────
//
// Note: cost-cap + blob have NO in-module default — they are REQUIRED constructor args (production
// injects the REAL Postgres-backed implementations; tests inject the in-memory doubles). The defaults
// that remain below are either the REAL ported implementation (archive redactor) or a no-op on a pure
// off-observable-path side-effect the cassette dual-run asserts nothing on (telemetry writer).

/**
 * Default archive redactor: the REAL ported `redactPii` (RegexPiiRedactor). Returns the rewritten text
 * (`[REDACTED:<kind>]` placeholders); the findings are discarded here because the client only stores
 * the redacted body (the Python logs the finding KINDS at INFO — that log is a side-effect off the
 * observable path, intentionally not reproduced). Mirrors the Python `RegexPiiRedactor()` default.
 */
const REAL_ARCHIVE_REDACTOR: ArchiveRedactor = {
  redact: (text: string): string => redactPii(text).rewritten,
};

/**
 * No-op telemetry writer default — the cassette/unit path has no DB and asserts nothing on the
 * llm_calls row (faithful to the Python cassette test, which wires an in-memory enforcer and never
 * reads the row). The production `LlmClientCache` injects {@link PostgresLlmCallsTelemetryWriter}.
 */
const NOOP_TELEMETRY_WRITER: LlmCallsTelemetryWriter = {
  async recordCall(): Promise<void> {
    // no-op
  },
};

/**
 * Production `telemetry.llm_calls` writer — the REAL, ALWAYS-ON path the frozen worker wires. INSERTs
 * one row per invocation over the shared single-pool Kysely seam (ADR-0062). The exact column set
 * mirrors the Python inline INSERT + `_record_failure`:
 *   llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms,
 *   cost_usd_cents, payload_blob_id, status, created_at
 *
 * `llm_call_id` + `payload_blob_id` are minted via the platform randomness seam — `payload_blob_id` is
 * a PLACEHOLDER UUID exactly as in the Python (`"blob": uuid.uuid4(),  # placeholder — Sprint 6 wires
 * real blob_id`); wiring the real archive blob id is a separate follow-up, faithful to the frozen
 * source. Tenancy: `telemetry.llm_calls` carries `installation_id`, which is written explicitly in the
 * INSERT target (the raw-SQL gate's "installation_id token in the SQL" escape hatch).
 */
export class PostgresLlmCallsTelemetryWriter implements LlmCallsTelemetryWriter {
  private readonly db: Kysely<unknown>;
  private readonly random = new SystemRandom();

  public constructor(args: { db: Kysely<unknown> }) {
    this.db = args.db;
  }

  /**
   * Build a writer over the shared single-pool tenant Kysely for `dsn` (ADR-0062 seam). The production
   * `LlmClientCache` uses this to construct the always-on writer from `CODEMASTER_PG_CORE_DSN`.
   */
  public static fromDsn(args: { dsn: string }): PostgresLlmCallsTelemetryWriter {
    return new PostgresLlmCallsTelemetryWriter({ db: tenantKysely<unknown>(args.dsn) });
  }

  public async recordCall(args: {
    installationId: string;
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    costUsdCents: number;
    status: "ok" | "failed" | "timeout";
    createdAt: Date;
  }): Promise<void> {
    // tenancy: filtered on installation_id (the column is written explicitly in the INSERT target).
    await sql`
      INSERT INTO telemetry.llm_calls
        (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens,
         latency_ms, cost_usd_cents, payload_blob_id, status, created_at)
      VALUES (${this.uuid4()}::uuid, ${args.installationId}::uuid, ${args.requestId}::uuid,
              ${args.model}, ${args.promptTokens}, ${args.completionTokens}, ${args.latencyMs},
              ${args.costUsdCents}, ${this.uuid4()}::uuid, ${args.status}, ${args.createdAt})
    `.execute(this.db);
  }

  /** Mint a random RFC4122 v4 UUID via the platform randomness seam (the Python `uuid.uuid4()`). */
  private uuid4(): string {
    const b = Buffer.from(this.random.tokenBytes(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
}

// ─── the client ─────────────────────────────────────────────────────────────────────────────────

/**
 * Wraps an injected LLM SDK with the pure-transform invoke path. Constructed once per role by
 * LlmClientCache (out of scope here — the cassette CacheShim plays that role).
 */
export class LlmClient {
  private readonly sdk: LlmSdk;
  private readonly costCap: CostCapEnforcer;
  private readonly blobStore: BlobStore;
  private readonly archiveRedactor: ArchiveRedactor;
  private readonly telemetry: LlmCallsTelemetryWriter;
  private readonly outputSafety: OutputSafetyValidator;
  private readonly langfuse: LangfuseExporterPort;
  private readonly clock: Clock;
  private readonly random: SystemRandom;
  // TS hardening divergence (ADR-0068) — OPTIONAL LLM-invocation idempotency ledger. The frozen Python
  // has no ledger; absent here means "behave exactly as Python" (invoke, no replay). When present AND an
  // `idempotency` context is passed to invokeModel, a HIT replays the stored provider response and SKIPS
  // the paid SDK call; a MISS stores the raw response BEFORE returning. Platform jobs / unit tests leave
  // it undefined.
  private readonly ledger: LlmInvocationLedgerPort | undefined;

  public constructor(args: {
    sdk: LlmSdk;
    // cost-cap + blob are REQUIRED — no faking-stub default. Production injects the REAL Postgres-backed
    // implementations (the always-on path); unit / cassette tests inject the in-memory doubles.
    costCap: CostCapEnforcer;
    blobStore: BlobStore;
    archiveRedactor?: ArchiveRedactor;
    telemetry?: LlmCallsTelemetryWriter;
    outputSafety?: OutputSafetyValidator;
    // Langfuse trace exporter — defaults to the disabled no-op (the Python `self._langfuse is None`).
    // Production injects `LangfuseExporter.fromEnv()` (itself env-gated OFF until LANGFUSE_HOST/API_KEY
    // are set). Fire-and-forget; never affects the return / raise.
    langfuse?: LangfuseExporterPort;
    clock?: Clock;
    // TS hardening divergence (ADR-0068) — OPTIONAL idempotency ledger. Absent → exactly-as-Python (no
    // replay). Production review wiring injects the REAL Postgres-backed ledger; platform jobs omit it.
    ledger?: LlmInvocationLedgerPort;
  }) {
    this.clock = args.clock ?? new WallClock();
    this.sdk = args.sdk;
    this.costCap = args.costCap;
    this.blobStore = args.blobStore;
    this.archiveRedactor = args.archiveRedactor ?? REAL_ARCHIVE_REDACTOR;
    this.telemetry = args.telemetry ?? NOOP_TELEMETRY_WRITER;
    this.outputSafety = args.outputSafety ?? new OutputSafetyValidator();
    this.langfuse = args.langfuse ?? DISABLED_LANGFUSE_EXPORTER;
    this.random = new SystemRandom();
    this.ledger = args.ledger;
  }

  /**
   * Drive one LLM invocation and return the structured result. 1:1 with the Python
   * `invoke_model` → `_invoke_model_impl`. The OTel span the Python wraps the call in is a pure
   * side-effect with no observable-output effect, so it is omitted (deferred follow-up).
   *
   * @throws BedrockBudgetExceededError  on a pre-call cost-cap deny (observable: short-circuits the
   *   activity into a non-retryable failure).
   * @throws LlmInvocationError          on an SDK error (observable: retryable activity failure).
   * @throws LlmOutputUnsafeError        on an output-safety block (observable: sanitize-and-continue
   *   or non-retryable failure, decided by the activity).
   */
  public async invokeModel(args: {
    role: "primary" | "secondary";
    model: BedrockModel | null;
    messages: Array<LlmMessage>;
    maxTokens?: number;
    purpose?: string;
    tools?: Array<Record<string, unknown>> | null;
    // TS hardening divergence (ADR-0068) — Python keeps `installation_id` an OPTIONAL deprecated/ignored
    // param and substitutes a fixed all-ones sentinel (platform-scope) when omitted. TS makes it a
    // REQUIRED arg so a caller CANNOT silently omit it: the real id flows to the cost-cap (per-org
    // isolation), the blob put (correct attribution), and the telemetry.llm_calls + Langfuse rows
    // (incident-response / billing / SLO attribution). Genuine internal/platform jobs pass
    // {@link PLATFORM_INVOCATION_INSTALLATION_ID} (ZERO_UUID) EXPLICITLY — there is no implicit fallback
    // to the platform sentinel. See the owner rationale captured in ADR-0068.
    installationId: string;
    // TS hardening divergence (ADR-0068) — OPTIONAL idempotency context. When present AND the client
    // was constructed with a `ledger`, the paid SDK call is made idempotent: the key is derived from
    // reviewId + chunkId + role + model + prompt hash + toolSchemaVersion; a HIT replays the stored
    // provider response (the SDK is NOT called again); a MISS calls the SDK then stores the raw response
    // BEFORE returning. When absent (platform jobs / unit tests) the client behaves exactly as the
    // frozen Python (invoke, no ledger). The SDK call is the only non-repeatable, paid edge.
    idempotency?: {
      reviewId: string;
      chunkId: string;
      toolSchemaVersion: string;
    };
  }): Promise<LlmInvokeResultV1> {
    const maxTokens = args.maxTokens ?? 1024;
    const purpose = args.purpose ?? "review";
    const tools = args.tools ?? null;
    // TS hardening divergence (ADR-0068) — Python falls back to TELEMETRY_MISSING_INSTALLATION_ID (the
    // all-ones sentinel) when `installation_id` is None; the required-arg contract above means production
    // never reaches that fallback. The sentinel is retained ONLY as a last-ditch defensive normalization
    // for an empty string (a wiring bug, not a normal path) so a malformed empty value never silently
    // charges spend / archives under an empty key. Genuine platform jobs pass
    // PLATFORM_INVOCATION_INSTALLATION_ID (ZERO_UUID) explicitly — they do NOT hit this branch.
    const telemetryIid = args.installationId === "" ? TELEMETRY_MISSING_INSTALLATION_ID : args.installationId;

    // ADR-0060 A: model selection is resolved upstream and passed explicitly. The client requires one;
    // there is no in-client routing fallback.
    if (args.model === null) {
      throw new TypeError(
        "LlmClient.invokeModel requires an explicit model= " +
          "(routing is resolved upstream via purpose→model; ADR-0060)",
      );
    }
    const model: string = args.model;
    if (!(BEDROCK_MODELS as ReadonlyArray<string>).includes(model)) {
      throw new TypeError(`unsupported model: ${pyReprStr(model)}`);
    }

    const requestId = this.uuid4();
    const promptChars = args.messages.reduce((acc, m) => acc + m.content.length, 0);
    const estimated = estimateCentsPreCall(model, promptChars);

    // TS hardening divergence (ADR-0068, "check the idempotency record FIRST" — owner decision verbatim).
    // Python has NO invocation ledger: it ALWAYS calls the SDK, so a post-call persistence failure + a
    // Temporal retry buys a SECOND paid completion. When this client has a `ledger` AND the caller passed
    // an `idempotency` context, compute the stable key from the deterministic activity inputs (reviewId +
    // chunkId + role + model + prompt hash + toolSchemaVersion) and probe the ledger FIRST — BEFORE the
    // cost-cap reservation and the request archive. On a HIT the call is a PURE READ: the cost was gated +
    // recorded on the first invoke, so checkOrRaise, the request archive, AND recordCallCost (below) are
    // ALL skipped, so a retried chunk does NOT double-count spend in cost_daily. The SDK call is the only
    // non-repeatable, paid edge. The post-call transform + output-safety + telemetry/Langfuse below DO run
    // against the replayed response (owner decision: keep telemetry/Langfuse as replayable observability
    // side effects). When `ledger` / `idempotency` are absent (platform jobs / unit tests) `idempotencyKey`
    // is null, `isReplay` is false, and the path is identical to the frozen Python (invoke, no ledger).
    const idempotencyKey =
      this.ledger !== undefined && args.idempotency !== undefined
        ? this.ledger.computeKey({
            reviewId: args.idempotency.reviewId,
            chunkId: args.idempotency.chunkId,
            role: args.role,
            model,
            promptSha256: hashMessages(args.messages),
            toolSchemaVersion: args.idempotency.toolSchemaVersion,
          })
        : null;

    const started = this.clock.monotonic();
    const replayed =
      this.ledger !== undefined && idempotencyKey !== null
        ? await this.ledger.lookup({ key: idempotencyKey, installationId: telemetryIid })
        : null;
    const isReplay = replayed !== null;
    let response: Record<string, unknown>;

    if (isReplay) {
      // HIT — replay the stored provider response; the paid SDK call, the cost-cap reservation, and the
      // request archive are all SKIPPED (already done on the first invoke). No store (the row exists). The
      // transform + telemetry/Langfuse below run against this replayed response.
      response = replayed;
    } else {
      // MISS — the paid path. Cost-cap pre-call check (FAIL-CLOSED). Retry ONCE on lock-timeout (S14.D
      // edge case 5: the telemetry.cost_daily row lock is contended under `SET LOCAL lock_timeout='2s'` →
      // CostCapLockTimeoutError); a second timeout fails closed via BedrockBudgetExceededError so no LLM
      // invocation proceeds without an atomic cost record. 1:1 with the frozen Python invoke_model.
      const todayForCheck = isoDate(this.clock.now());
      try {
        await this.costCap.checkOrRaise({
          installationId: telemetryIid,
          estimatedCents: estimated,
          today: todayForCheck,
        });
      } catch (e) {
        if (!(e instanceof CostCapLockTimeoutError)) {
          throw e;
        }
        try {
          await this.costCap.checkOrRaise({
            installationId: telemetryIid,
            estimatedCents: estimated,
            today: todayForCheck,
          });
        } catch (retryErr) {
          if (retryErr instanceof CostCapLockTimeoutError) {
            throw new BedrockBudgetExceededError({
              reason:
                "cost-cap row lock timed out twice; failing closed to preserve daily-budget invariant",
              scope: "kill_switch",
            });
          }
          throw retryErr;
        }
      }

      // Archive request payload BEFORE invocation (forensics even if the SDK raises). Off the observable
      // path; the BlobRef is discarded (the result carries the RESPONSE blob ref).
      const redactedMessages = args.messages.map((m) => ({
        role: m.role,
        content: this.archiveRedactor.redact(m.content),
      }));
      await this.blobStore.put({
        installationId: telemetryIid,
        key: `llm-payloads/${requestId}/request.json`,
        body: utf8(
          jsonCompact({
            model,
            messages: redactedMessages,
            max_tokens: maxTokens,
            purpose,
          }),
        ),
        contentType: "application/json",
      });

      try {
        response = await this.sdk.createMessage({
          model,
          messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
          maxTokens,
          tools,
          role: args.role,
        });
      } catch (e) {
        // The Python distinguishes TimeoutError (status='timeout') from any other exception
        // (status='failed') for the telemetry / Langfuse status label; BOTH map to LlmInvocationError on
        // the observable path. The failure-row write (so cost telemetry stays accurate even on failure),
        // the cost-cap reservation release, AND the fire-and-forget Langfuse export ARE on the always-on
        // production path and are reproduced here. Mirrors client.py:421-476 (the two except arms, unified
        // here because the status label is the only thing that differs between them).
        const failedLatencyMs = Math.trunc((this.clock.monotonic() - started) * 1000);
        const failureStatus: "failed" | "timeout" = isTimeoutError(e) ? "timeout" : "failed";
        await this.recordFailure({
          installationId: telemetryIid,
          requestId,
          model,
          latencyMs: failedLatencyMs,
          status: failureStatus,
        });
        await this.releaseCostCapReservation({ installationId: telemetryIid, estimated });
        await this.maybeExportLangfuseTrace({
          requestId,
          installationId: telemetryIid,
          model,
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: failedLatencyMs,
          costUsdCents: 0,
          status: failureStatus,
          promptText: firstMessageContent(args.messages),
          completionText: "",
          routingReason: ROUTING_REASON,
          policyRevision: POLICY_REVISION,
        });
        throw new LlmInvocationError(`bedrock invocation failed: ${formatErr(e)}`);
      }
      // MISS — the paid SDK call succeeded: persist the RAW provider response BEFORE returning, so a
      // future retry replays it instead of buying a second completion. ON CONFLICT DO NOTHING in the
      // ledger makes a racing retry a safe no-op (the key is content-addressable). Guarded so a ledger
      // write failure never masks a successful invocation — but then a retry WOULD re-pay, which is the
      // pre-ADR-0068 (Python) behavior, strictly no worse than before.
      if (this.ledger !== undefined && idempotencyKey !== null && args.idempotency !== undefined) {
        await this.storeInvocation({
          key: idempotencyKey,
          installationId: telemetryIid,
          reviewId: args.idempotency.reviewId,
          chunkId: args.idempotency.chunkId,
          role: args.role,
          model,
          promptSha256: hashMessages(args.messages),
          toolSchemaVersion: args.idempotency.toolSchemaVersion,
          providerResponse: response,
        });
      }
    }
    const latencyMs = Math.trunc((this.clock.monotonic() - started) * 1000);

    // Archive response payload (off the observable path; this BlobRef IS the result's payload_blob_ref).
    const responseBlobRef = await this.blobStore.put({
      installationId: telemetryIid,
      key: `llm-payloads/${requestId}/response.json`,
      body: utf8(jsonCompact(this.redactResponseForArchive(response))),
      contentType: "application/json",
    });

    // ─── PARITY-CRITICAL transform (Python lines 491-584) ───────────────────────────────────────────

    const usage = asRecord(response["usage"]) ?? {};
    const promptTokens = intOrZero(usage["input_tokens"]);
    const completionTokens = intOrZero(usage["output_tokens"]);
    const computedFinalCents = finalCents(model, promptTokens, completionTokens);

    // content_text = first content block's `.text` (empty when missing / not a dict / not present).
    // raw_blocks = ALL content blocks that are dicts, in order. Matches Python's `content or [{}]`
    // fallback for every shape the Anthropic Messages API can return — `content` is ALWAYS a list there
    // (possibly empty): a list / undefined / [] all map identically (Python's None/[] → [{}]). The only
    // shape that would differ is a truthy NON-list `content` (a malformed response the API never emits):
    // Python keeps it then no-ops via `isinstance(list)` → raw_blocks=(), whereas we coerce to [{}]. That
    // edge is both unreachable AND non-observable — the parser ignores the empty `{}` block, so the
    // resulting ReviewChunkResponseV1 is identical either way (proven by the dual-run).
    const contentBlockRaw = response["content"];
    const contentBlock: Array<unknown> =
      Array.isArray(contentBlockRaw) && contentBlockRaw.length > 0 ? contentBlockRaw : [{}];
    let contentText = "";
    let rawBlocks: Array<Record<string, unknown>> = [];
    if (Array.isArray(contentBlock) && contentBlock.length > 0) {
      const first = contentBlock[0];
      if (isRecord(first)) {
        // str(first.get("text", "")) — coerce to string; a missing/None text → "".
        contentText = pyStr(first["text"]);
      }
      rawBlocks = contentBlock.filter((b): b is Record<string, unknown> => isRecord(b));
    }

    // Output safety — validate before declaring success. Tokens were burned regardless of the outcome,
    // so cost-cap accounting still runs (record below). This IS on the observable path.
    const decision = this.outputSafety.validate(contentText);
    const blocked = decision.decision !== "allow";
    // Validator-aware status: a blocked completion is recorded as 'failed' (the tokens were spent, so
    // the row + cost accounting still run). Mirrors the Python `call_status = "ok" if allow else "failed"`.
    const callStatus: "ok" | "failed" = blocked ? "failed" : "ok";

    // Write the telemetry.llm_calls row with the validator-aware status (the always-on production path;
    // a no-op on the default writer). Ordered before record_call_cost, matching client.py:512-543.
    await this.telemetry.recordCall({
      installationId: telemetryIid,
      requestId,
      model,
      promptTokens,
      completionTokens,
      latencyMs,
      costUsdCents: computedFinalCents,
      status: callStatus,
      createdAt: this.clock.now(),
    });

    // record_call_cost (off-path side-effect, but harmless on the in-memory default). Mirrors Python on
    // the paid path. SKIPPED on a replay HIT (ADR-0068 check-first): the spend was already recorded on the
    // first invoke, so re-running it would double-count cost_daily for a single paid completion.
    if (!isReplay) {
      await this.costCap.recordCallCost({
        installationId: telemetryIid,
        costCents: computedFinalCents,
        today: isoDate(this.clock.now()),
        estimatedCents: estimated,
      });
    }

    // Langfuse trace export (fire-and-forget). Carries the validator-aware status so blocked completions
    // surface in observability without leaking the unsafe text (completion_text is "" when blocked).
    // Ordered after record_call_cost + before the block raise — mirrors client.py:548-561.
    await this.maybeExportLangfuseTrace({
      requestId,
      installationId: telemetryIid,
      model,
      promptTokens,
      completionTokens,
      latencyMs,
      costUsdCents: computedFinalCents,
      status: callStatus,
      promptText: firstMessageContent(args.messages),
      completionText: callStatus === "ok" ? contentText : "",
      routingReason: ROUTING_REASON,
      policyRevision: POLICY_REVISION,
    });

    if (blocked) {
      throw new LlmOutputUnsafeError({
        decision,
        rawContentBlocks: rawBlocks,
        contentText,
        requestId,
      });
    }

    return LlmInvokeResultV1.parse({
      request_id: requestId,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: latencyMs,
      cost_usd_cents: computedFinalCents,
      payload_blob_ref: responseBlobRef,
      content: contentText,
      stop_reason: pyStr(response["stop_reason"]),
      raw_content_blocks: rawBlocks,
      provider: "bedrock",
      role: args.role,
    });
  }

  /** Walk the response shape and route every text body through the archive redactor (off-path). */
  private redactResponseForArchive(response: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = { ...response };
    const content = response["content"];
    if (Array.isArray(content)) {
      const newContent: Array<unknown> = [];
      for (const block of content) {
        if (isRecord(block) && typeof block["text"] === "string") {
          newContent.push({ ...block, text: this.archiveRedactor.redact(block["text"]) });
        } else if (isRecord(block)) {
          newContent.push({ ...block });
        } else {
          newContent.push(block);
        }
      }
      redacted["content"] = newContent;
    }
    return redacted;
  }

  /**
   * Write the failure telemetry.llm_calls row (status='failed'|'timeout') with literal-zero tokens +
   * cost — the Python `_record_failure`. Wrapped in a guard so a telemetry write failure NEVER masks
   * the original SDK exception (the Python `except Exception as e: _LOG.warning(...)`), and the
   * LlmInvocationError still propagates to the caller.
   */
  private async recordFailure(args: {
    installationId: string;
    requestId: string;
    model: string;
    latencyMs: number;
    status: "failed" | "timeout";
  }): Promise<void> {
    try {
      await this.telemetry.recordCall({
        installationId: args.installationId,
        requestId: args.requestId,
        model: args.model,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: args.latencyMs,
        costUsdCents: 0,
        status: args.status,
        createdAt: this.clock.now(),
      });
    } catch {
      // Last-ditch: a telemetry write failure must not mask the SDK error. Mirrors the Python
      // `_record_failure` swallow (`_LOG.warning("failed to record llm_calls failure row: %s", e)`).
    }
  }

  /**
   * Release the optimistic `estimated` reservation made by the pre-call check after the SDK call
   * failed — modeled as cost_cents=0 so the diff `0 - estimated` walks the daily total back. Wrapped in
   * a guard so a release failure never masks the original SDK exception. Mirrors the Python
   * `_release_cost_cap_reservation`. (A no-op on the AllowAll default; meaningful on the atomic
   * PostgresCostCapEnforcer.)
   */
  private async releaseCostCapReservation(args: {
    installationId: string;
    estimated: number;
  }): Promise<void> {
    try {
      await this.costCap.recordCallCost({
        installationId: args.installationId,
        costCents: 0,
        today: isoDate(this.clock.now()),
        estimatedCents: args.estimated,
      });
    } catch {
      // Defense in depth — a release failure may over-count the daily total by `estimated` for this
      // call, but must not mask the original SDK error. Mirrors the Python warning-and-continue.
    }
  }

  /**
   * TS hardening divergence (ADR-0068) — persist the raw provider response to the idempotency ledger
   * AFTER a successful (MISS) SDK call and BEFORE returning, so a future Temporal retry replays it
   * instead of buying a second paid completion. Guarded so a ledger write failure NEVER masks a
   * successful invocation — but then a retry would re-pay (the pre-ADR-0068 Python behavior, strictly no
   * worse). No-op when the client has no ledger (platform jobs / unit tests). Python has no analogue.
   */
  private async storeInvocation(args: {
    key: string;
    installationId: string;
    reviewId: string;
    chunkId: string;
    role: string;
    model: string;
    promptSha256: string;
    toolSchemaVersion: string;
    providerResponse: Record<string, unknown>;
  }): Promise<void> {
    if (this.ledger === undefined) {
      return;
    }
    try {
      await this.ledger.store({
        key: args.key,
        entry: {
          installationId: args.installationId,
          reviewId: args.reviewId,
          chunkId: args.chunkId,
          role: args.role,
          model: args.model,
          promptSha256: args.promptSha256,
          toolSchemaVersion: args.toolSchemaVersion,
          providerResponse: args.providerResponse,
        },
      });
    } catch {
      // Defense in depth — a ledger write failure must not mask a successful invocation. A subsequent
      // retry would then re-pay (the pre-ADR-0068 Python behavior), which is strictly no worse.
    }
  }

  /**
   * Build a {@link BedrockTraceV1} from the call params + redacted snippets and hand it to the injected
   * Langfuse exporter. 1:1 with the Python `_maybe_export_langfuse_trace`.
   *
   * No-op when the disabled default is wired (the Python `if self._langfuse is None: return`; here the
   * {@link DISABLED_LANGFUSE_EXPORTER}'s `export` is itself a no-op). Fire-and-forget: the exporter
   * swallows its own transport errors, and this method additionally guards the trace BUILD (a validation
   * failure must never mask the caller's return / raise — the Python `except Exception as e:
   * _LOG.warning(...)` defense-in-depth). The snippets are redacted + truncated to 200 via
   * {@link redactSnippet}.
   */
  private async maybeExportLangfuseTrace(args: {
    requestId: string;
    installationId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    costUsdCents: number;
    status: "ok" | "failed" | "timeout";
    promptText: string;
    completionText: string;
    routingReason: string;
    policyRevision: number;
  }): Promise<void> {
    try {
      const trace = BedrockTraceV1.parse({
        request_id: args.requestId,
        installation_id: args.installationId,
        model: args.model,
        prompt_tokens: args.promptTokens,
        completion_tokens: args.completionTokens,
        latency_ms: args.latencyMs,
        cost_usd_cents: args.costUsdCents,
        status: args.status,
        prompt_redacted_snippet: redactSnippet(args.promptText),
        completion_redacted_snippet: redactSnippet(args.completionText),
        routing_reason: args.routingReason,
        policy_revision: args.policyRevision,
      });
      await this.langfuse.export(trace);
    } catch {
      // Defense in depth — a trace build / export failure must never mask the caller's return or raise.
      // Mirrors the Python `_maybe_export_langfuse_trace` outer `except Exception` warn-and-continue.
    }
  }

  /** Mint a random RFC4122 v4 UUID via the platform randomness seam (the Python `uuid.uuid4()`). */
  private uuid4(): string {
    const b = Buffer.from(this.random.tokenBytes(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
}

// ADR-0060 A: the ModelRouter was retired — model selection is resolved upstream and passed explicitly,
// so `routing_reason` / `policy_revision` are fixed call-frame locals on every invocation (the Python
// `routing_reason = "explicit"; policy_revision = 0`). Threaded into the trace; NOT instance state (two
// concurrent invocations would race on instance attributes — the Sprint-15 S15.E fix).
const ROUTING_REASON = "explicit";
const POLICY_REVISION = 0;

/**
 * Return the content of the first user / system message for tracing — the Python
 * `_first_message_content`. Falls back to the first message's content, then to "" when there are no
 * messages at all.
 */
function firstMessageContent(messages: Array<LlmMessage>): string {
  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      return m.content;
    }
  }
  return messages.length > 0 ? messages[0]!.content : "";
}

/**
 * TS hardening divergence (ADR-0068) — SHA-256 hex of the serialized request messages: the prompt-hash
 * component of the idempotency key. Delegates to {@link hashMessagesForLedger} so the hash is
 * single-sourced with the ledger module. Stable across retries because the messages are a deterministic
 * transform of the activity input. Python has no analogue (no ledger, no prompt hash).
 */
function hashMessages(messages: ReadonlyArray<LlmMessage>): string {
  return hashMessagesForLedger(messages.map((m) => ({ role: m.role, content: m.content })));
}

/**
 * True iff `e` should be recorded as a `timeout` (vs `failed`) telemetry status — the Python
 * `except TimeoutError` branch. Python's `LlmTimeoutError` subclasses `LlmInvocationError(Exception)`,
 * NOT the builtin `TimeoutError`, and the SDK adapter maps every provider timeout to `LlmTimeoutError`; so
 * an SDK-mapped timeout is caught by `except Exception` and recorded `status="failed"`. ONLY a RAW (unmapped)
 * timeout — an error whose `name` is `TimeoutError` (e.g. a transport abort) — reaches the
 * `except TimeoutError` arm. Everything else, INCLUDING `LlmTimeoutError`, is `failed`.
 */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

/**
 * The explicit platform-scope sentinel for genuine internal / platform jobs (housekeeping, walkthrough,
 * eval, any non-tenant review-LLM call). Equal to the cost-cap's global-scope sentinel
 * (`ZERO_UUID = "00000000-0000-0000-0000-000000000000"`, `postgres_enforcer.ts`), which routes spend to
 * the global cap and skips the per-org row.
 *
 * TS hardening divergence (ADR-0068) — Python lets NORMAL review calls omit `installation_id` and fall
 * back to a platform/all-ones sentinel implicitly. TS forbids that: a platform job must OPT IN to
 * platform-scope by passing THIS constant explicitly, so normal per-installation review calls can never
 * accidentally charge their spend / blob / telemetry / Langfuse attribution to the platform sentinel.
 */
export const PLATFORM_INVOCATION_INSTALLATION_ID = "00000000-0000-0000-0000-000000000000";

// The all-ones UUID placeholder the Python TELEMETRY_MISSING_INSTALLATION_ID sentinel mints. Retained
// ONLY as a defensive last-resort normalization for an empty-string installationId (a wiring bug) so a
// malformed empty value never charges spend / archives under an empty key — production never hits it
// (invokeModel requires a non-empty id, and platform jobs pass PLATFORM_INVOCATION_INSTALLATION_ID).
const TELEMETRY_MISSING_INSTALLATION_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// ─── small helpers (no external deps) ──────────────────────────────────────────────────────────────

/** True iff `v` is a plain JSON object (the Python `isinstance(x, dict)` check). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `isRecord` narrowed to a return value (for `usage`). */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

/** Python `int(x or 0)` for a token-usage field: None/0/missing → 0; numeric/str → truncated int. */
function intOrZero(v: unknown): number {
  if (v === null || v === undefined || v === 0 || v === false || v === "") {
    return 0;
  }
  if (typeof v === "number") {
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/**
 * Python `str(x)` for the content-text / stop-reason extraction: a missing/None value → "" (the
 * Python `first.get("text", "")` default is the empty string; `str("")` → ""), a str passes through,
 * and any other scalar is stringified the way the cassette path would never actually hit (text/stop
 * are always strings in real responses, so this only guards the missing/None case → "").
 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  return typeof v === "string" ? v : String(v);
}

/** JSON with tight separators (the Python `separators=(",", ":")`). Off-path; archive bytes only. */
function jsonCompact(value: unknown): string {
  return JSON.stringify(value);
}

/** UTF-8 encode (the Python `.encode("utf-8")`). */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** YYYY-MM-DD of the wall instant (the Python `self._clock.now().date()`). UTC date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Format a thrown value for the LlmInvocationError message (the Python `format_exception(e)`). */
function formatErr(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message === "" ? "<empty>" : e.message}`;
  }
  return String(e);
}

/** Python `repr()` of a str: single-quoted, `\`→`\\`, `'`→`\'`. */
function pyReprStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Re-export the budget error so callers `import { BedrockBudgetExceededError } from "./client.js"` —
// it is raised on the observable path by the pre-call cost-cap check.
export { BedrockBudgetExceededError };
