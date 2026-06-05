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
// collaborator Protocols with no-op / in-memory defaults so the cassette dual-run is faithful:
//   - CostCap        — pre-call check + post-call record. Default: allow-all in-memory (mirrors the
//                      Python InMemoryCostCapEnforcer the cassette test wires). A pre-call deny still
//                      raises BedrockBudgetExceededError (that IS observable — it short-circuits the
//                      activity into a non-retryable ApplicationFailure), so the enforcer Protocol is
//                      wired, just defaulted to allow-all.
//   - BlobStore      — request/response payload archive. Default: in-memory (mirrors
//                      BlobStoreInMemoryAdapter). The archive BlobRef is the `payload_blob_ref` of the
//                      result, so a default must produce a well-formed BlobRef; bytes are discarded.
//   - ArchiveRedactor — PII/secret redaction of archived payloads. Default: no-op (identity). Archive
//                      content is never read back on the observable path.
//   - telemetry/Langfuse — the Python writes a telemetry.llm_calls row + a fire-and-forget Langfuse
//                      trace. Both are pure side-effects with no return on the observable path, so they
//                      are OMITTED here (no DB in this slice; no Langfuse dep). Tracked as deferred
//                      follow-ups (see notes at the bottom).
//
// Output-safety IS on the observable path (it can BLOCK), so the REAL ported OutputSafetyValidator is
// wired (injected, defaulting to a fresh real validator) and a block raises the REAL ported
// LlmOutputUnsafeError carrying decision + raw_content_blocks + content_text + request_id.
//
// Clock/random discipline (clock_random gate): latency uses the platform Clock.monotonic() seam (the
// Python `time.perf_counter()`); request_id is minted via the platform SystemRandom seam (the Python
// `uuid.uuid4()`). NO raw Date.now / Math.random.

import { type Clock, WallClock } from "#platform/clock.js";
import { SystemRandom } from "#platform/randomness.js";

import { BedrockBudgetExceededError, type CostCapEnforcer } from "#backend/cost/enforcer.js";
import { OutputSafetyValidator } from "#backend/security/output_safety.js";

import { LlmInvocationError, LlmOutputUnsafeError } from "./errors.js";

import type { BlobRef } from "#contracts/blob_ref.v1.js";
import { CostCapDecisionV1 } from "#contracts/cost_cap_decision.v1.js";
import { LlmInvokeResultV1 } from "#contracts/llm_invoke_result.v1.js";
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
 * the client uses — `put` only). Default: an in-memory adapter (mirrors `BlobStoreInMemoryAdapter`).
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
 * Redacts archived payload text before it is stored (mirrors `PiiRedactorPort`). Default: a no-op
 * identity redactor — archive content is never read back on the observable path.
 */
export type ArchiveRedactor = {
  redact(text: string): string;
};

// ─── default no-op / in-memory collaborators ───────────────────────────────────────────────────────

/**
 * Allow-all in-memory cost-cap default (mirrors the Python InMemoryCostCapEnforcer the cassette test
 * wires). check never raises; record is a no-op accumulator-free stub. The production enforcer
 * (PostgresCostCapEnforcer) is a deferred follow-up — see notes.
 */
class AllowAllCostCap implements CostCapEnforcer {
  public async checkOrRaise(): Promise<CostCapDecisionV1> {
    return CostCapDecisionV1.parse({
      allowed: true,
      cents_spent_today_global: 0,
      cents_spent_today_org: 0,
      cents_estimated: 0,
    });
  }

  public async recordCallCost(): Promise<void> {
    // no-op
  }
}

/**
 * In-memory blob store default (mirrors `BlobStoreInMemoryAdapter`). Discards bytes; returns a
 * well-formed BlobRef so the result's `payload_blob_ref` is valid. The production object-store adapter
 * is a deferred follow-up — see notes.
 */
class InMemoryBlobStore implements BlobStore {
  private readonly clock: Clock;

  public constructor(clock: Clock) {
    this.clock = clock;
  }

  public async put(args: {
    installationId: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<BlobRef> {
    return {
      schema_version: 1,
      installation_id: args.installationId,
      key: args.key,
      byte_size: args.body.length,
      content_type: args.contentType,
      created_at: this.clock.now().toISOString(),
    };
  }
}

/** No-op identity redactor default. */
const NOOP_ARCHIVE_REDACTOR: ArchiveRedactor = { redact: (text: string): string => text };

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
  private readonly outputSafety: OutputSafetyValidator;
  private readonly clock: Clock;
  private readonly random: SystemRandom;

  public constructor(args: {
    sdk: LlmSdk;
    costCap?: CostCapEnforcer;
    blobStore?: BlobStore;
    archiveRedactor?: ArchiveRedactor;
    outputSafety?: OutputSafetyValidator;
    clock?: Clock;
  }) {
    this.clock = args.clock ?? new WallClock();
    this.sdk = args.sdk;
    this.costCap = args.costCap ?? new AllowAllCostCap();
    this.blobStore = args.blobStore ?? new InMemoryBlobStore(this.clock);
    this.archiveRedactor = args.archiveRedactor ?? NOOP_ARCHIVE_REDACTOR;
    this.outputSafety = args.outputSafety ?? new OutputSafetyValidator();
    this.random = new SystemRandom();
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
    // deprecated; ignored; platform-scope. Kept for deploy-ordering compatibility (mirrors Python).
    installationId?: string | null;
  }): Promise<LlmInvokeResultV1> {
    const maxTokens = args.maxTokens ?? 1024;
    const purpose = args.purpose ?? "review";
    const tools = args.tools ?? null;
    // installation_id is kept as an optional deprecated param; not forwarded to credentials. Telemetry
    // uses it as a placeholder. The Python TELEMETRY_MISSING_INSTALLATION_ID sentinel substitutes a
    // fixed all-ones UUID; here it only labels the archive key, off the observable path.
    const telemetryIid = args.installationId ?? TELEMETRY_MISSING_INSTALLATION_ID;

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

    // Cost-cap pre-call check (FAIL-CLOSED). The retry-once-on-lock-timeout path is a property of the
    // PostgresCostCapEnforcer; the allow-all / in-memory defaults never raise CostCapLockTimeoutError,
    // so a single check suffices for the cassette dual-run. (The full retry-then-fail-closed branch is
    // a deferred follow-up wired with the production enforcer.)
    const todayForCheck = isoDate(this.clock.now());
    await this.costCap.checkOrRaise({
      installationId: telemetryIid,
      estimatedCents: estimated,
      today: todayForCheck,
    });

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

    const started = this.clock.monotonic();
    let response: Record<string, unknown>;
    try {
      response = await this.sdk.createMessage({
        model,
        messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens,
        tools,
        role: args.role,
      });
    } catch (e) {
      // The Python distinguishes TimeoutError from other exceptions for the telemetry status label
      // only; both map to LlmInvocationError on the observable path. The failure-row write + cost-cap
      // reservation release + Langfuse export are off-path side-effects (deferred follow-ups).
      throw new LlmInvocationError(`bedrock invocation failed: ${formatErr(e)}`);
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

    // record_call_cost (off-path side-effect, but harmless on the in-memory default). Mirrors Python.
    await this.costCap.recordCallCost({
      installationId: telemetryIid,
      costCents: computedFinalCents,
      today: isoDate(this.clock.now()),
      estimatedCents: estimated,
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

  /** Mint a random RFC4122 v4 UUID via the platform randomness seam (the Python `uuid.uuid4()`). */
  private uuid4(): string {
    const b = Buffer.from(this.random.tokenBytes(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
}

// The all-ones UUID placeholder the Python TELEMETRY_MISSING_INSTALLATION_ID sentinel mints. Off the
// observable path (labels the archive key only). Re-export-free local constant.
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
