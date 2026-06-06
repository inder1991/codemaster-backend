/**
 * VaultHttpPort — 1:1 port of `codemaster/adapters/vault_http.py`
 * (frozen Python, Sprint 5 / S5.1.1; later S19.F.NS clock seam).
 *
 * Production HTTP adapter for the Sprint-0 {@link VaultPort} type (defined in `./vault_port.ts`).
 * Reads the Vault Agent token from disk on EVERY call (Vault Agent rotates the token on disk),
 * issues HTTP requests via the injected transport (production: global `fetch`/undici), retries
 * transport errors and 5xx with exponential backoff through the injected {@link Clock} seam, and
 * surfaces the typed errors from `./vault_port.ts`.
 *
 * --- Token redaction ---
 * The token NEVER appears in a log line. Every log line carries only `{ attempt, method, path,
 * status }`. The token-file path is also kept out of error messages ("vault token file unreadable"
 * is sterile) so logs cannot leak which mount the token lives on.
 *
 * --- Injected seams (everything non-deterministic is injected) ---
 *   - `http`: the HTTP transport. Production passes {@link FetchVaultHttpClient} (a thin
 *     `globalThis.fetch` wrapper). Tests pass a programmable in-memory stub satisfying
 *     {@link VaultHttpClient}.
 *   - `clock`: ALL timing (the retry backoff sleep) goes through the injected {@link Clock}
 *     (`clock.sleep`), NEVER `setTimeout`/`Date` — the check_clock_random gate enforces this and
 *     tests assert the recorded sleep durations via `FakeClock.recordedSleeps()`.
 *
 * Port-fidelity notes vs the Python:
 *   - httpx → fetch: the HTTP EXECUTION differs, but every retry / backoff / status-mapping DECISION
 *     is preserved 1:1. `httpx.HTTPError` (network errors, timeouts) → a thrown transport error the
 *     retry loop catches; `AbortSignal.timeout` arms the same retryable-timeout behaviour.
 *   - `bytes` → `Uint8Array`: Transit `transitDecrypt` returns `Uint8Array` (the VaultPort shape);
 *     `transitEncrypt` base64-encodes the input `Uint8Array` exactly as Python base64-encodes bytes.
 *   - keyword args → a single args-object per public method (the repo's args-object convention).
 */

import { readFileSync } from "node:fs";

import { type Clock, WallClock } from "#platform/clock.js";
import { transportAbortSignal } from "#platform/transport_timeout.js";

import {
  type VaultPort,
  VaultCasMismatch,
  VaultConnectivityError,
  VaultPathNotFound,
} from "./vault_port.js";

// ─── Constants (1:1 with the frozen Python module constants) ──────────────────────────────────

/** Path the Vault Agent Injector renders the token to on every renewal. */
export const DEFAULT_TOKEN_PATH = "/var/run/secrets/vault/token";
/** Per-request transport timeout, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 5.0;
/** Total attempts per request (initial + retries) before surfacing a connectivity error. */
export const MAX_RETRIES = 3;
/** First backoff sleep; DOUBLES after every retried attempt (0.5 → 1.0 → …; NO jitter). */
export const INITIAL_BACKOFF_SECONDS = 0.5;

// HTTP status sentinels (module-scope, mirroring the Python comparisons).
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CLIENT_ERROR_FLOOR = 400;
const HTTP_SERVER_ERROR_FLOOR = 500;
const HTTP_SERVER_ERROR_CEIL = 600;

// ─── Injected HTTP-transport seam (mirror GitHubHttpClient in integrations/github/api_client.ts) ─

/** The HTTP response shape this adapter consumes. */
export type VaultHttpResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

/** Arguments to one HTTP request. */
export type VaultHttpRequestArgs = {
  method: string;
  url: string;
  headers: Record<string, string>;
  jsonBody?: unknown;
};

/**
 * The injected HTTP transport. Production: {@link FetchVaultHttpClient}. Tests: a programmable
 * in-memory stub whose `request` signature + return shape are a structural match.
 */
export type VaultHttpClient = {
  request(args: VaultHttpRequestArgs): Promise<VaultHttpResponse>;
};

/**
 * Thrown by {@link FetchVaultHttpClient} when the underlying `fetch` fails at the transport level
 * (network error, DNS failure, connection reset, or an `AbortSignal.timeout` firing). The retry
 * loop in {@link VaultHttpPort} catches this and retries — the 1:1 analogue of the Python
 * `except httpx.HTTPError` arm.
 */
export class VaultTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VaultTransportError";
  }
}

/**
 * Production HTTP transport: a thin wrapper over Node's built-in global `fetch` (undici). NO new
 * dependency. NO replay-sensitive timing here (the adapter's backoff lives in the retry loop via the
 * injected Clock), so this file's only timer is the abort-timeout, armed via `AbortSignal.timeout`.
 *
 * A timeout/abort surfaces as a {@link VaultTransportError} — i.e. it is RETRYABLE, mirroring
 * httpx's `TimeoutException` being a subclass of `httpx.HTTPError`.
 */
export class FetchVaultHttpClient implements VaultHttpClient {
  private readonly timeoutMs: number;

  public constructor({
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  }: { timeoutSeconds?: number } = {}) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  public async request(args: VaultHttpRequestArgs): Promise<VaultHttpResponse> {
    const headers: Record<string, string> = { ...args.headers };
    const init: RequestInit = {
      method: args.method,
      headers,
      // Transport timeout via the sanctioned seam (gate-clean; a fired timeout rejects fetch).
      signal: transportAbortSignal(this.timeoutMs),
    };
    if (args.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(args.jsonBody);
    }
    let resp: Response;
    try {
      resp = await fetch(args.url, init);
    } catch (e) {
      // Network failure, DNS failure, connection reset, or AbortSignal.timeout firing — all map to
      // a retryable transport error (httpx.HTTPError analogue). NO token in the message: `args` is
      // never interpolated here.
      throw new VaultTransportError(
        `vault transport error: ${e instanceof Error ? e.name : "unknown"}`,
      );
    }
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });
    const bodyText = await resp.text();
    return { status: resp.status, headers: respHeaders, bodyText };
  }
}

// ─── The adapter ──────────────────────────────────────────────────────────────────────────────

export type VaultHttpPortOptions = {
  addr: string;
  tokenPath?: string;
  token?: string;
  kvMount?: string;
  transitMount?: string;
  timeoutSeconds?: number;
  http?: VaultHttpClient;
  clock?: Clock;
};

/** Decode a JSON body into an `unknown` we narrow at each call site. */
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** Narrow `value.data` to an object, or return undefined if the shape is wrong. */
function dataObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (typeof data !== "object" || data === null) return undefined;
  return data as Record<string, unknown>;
}

/**
 * Production HTTP adapter implementing every method on {@link VaultPort}.
 */
export class VaultHttpPort implements VaultPort {
  private readonly addr: string;
  private readonly tokenPath: string;
  private readonly token: string | undefined;
  private readonly kvMount: string;
  private readonly transitMount: string;
  private readonly http: VaultHttpClient;
  private readonly clock: Clock;

  public constructor({
    addr,
    tokenPath = DEFAULT_TOKEN_PATH,
    token,
    kvMount = "secret",
    transitMount = "transit",
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    http,
    clock,
  }: VaultHttpPortOptions) {
    this.addr = addr.replace(/\/+$/, "");
    this.tokenPath = tokenPath;
    this.token = token;
    this.kvMount = kvMount;
    this.transitMount = transitMount;
    this.http = http ?? new FetchVaultHttpClient({ timeoutSeconds });
    // Clock injected for retry-backoff sleeps; see CLAUDE.md "Clock and Random Protocols".
    this.clock = clock ?? new WallClock();
  }

  /**
   * Construct from env vars. Token resolution order:
   * 1. `VAULT_TOKEN` env var (dev/kind path; mirrors the official `vault` CLI convention).
   * 2. File at `VAULT_AGENT_TOKEN_PATH` (production: the Vault Agent Injector renders the token here
   *    on every renewal), defaulting to {@link DEFAULT_TOKEN_PATH}.
   */
  public static fromEnv(): VaultHttpPort {
    const addr = process.env["VAULT_ADDR"];
    if (!addr) {
      throw new VaultConnectivityError("VAULT_ADDR env var unset; cannot construct VaultHttpPort");
    }
    const tokenEnv = process.env["VAULT_TOKEN"];
    if (tokenEnv) {
      return new VaultHttpPort({ addr, token: tokenEnv });
    }
    const tokenPath = process.env["VAULT_AGENT_TOKEN_PATH"] ?? DEFAULT_TOKEN_PATH;
    return new VaultHttpPort({ addr, tokenPath });
  }

  /**
   * `fetch` owns no long-lived resource (no connection pool we allocated), so this is a no-op — kept
   * for parity with the Python `aclose()` so callers can dispose uniformly across adapters.
   */
  public async aclose(): Promise<void> {
    // No-op: the global-fetch transport holds nothing to release.
  }

  // ─── Internals ────────────────────────────────────────────────────────────────────────────

  /**
   * Read the Vault token. Direct-token path returns the injected token. Otherwise the token FILE is
   * re-read and trimmed — re-read on EVERY request attempt because Vault Agent rotates the token on
   * disk. On read failure: a STERILE {@link VaultConnectivityError} that names NEITHER the path NOR
   * any token.
   */
  private readToken(): string {
    if (this.token !== undefined) {
      return this.token;
    }
    try {
      return readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      // Do not include the token path in the error message to keep logs sterile.
      throw new VaultConnectivityError("vault token file unreadable");
    }
  }

  /**
   * The 1:1 port of Python `_request`. Drives the retry / backoff decision loop; returns the
   * {@link VaultHttpResponse} (any status; per-method status mapping happens at the call site) or
   * raises {@link VaultConnectivityError} once retries are exhausted.
   *
   * The token is re-read at the TOP of EACH attempt (per-attempt rotation safety). Log lines carry
   * ONLY `{ attempt, method, path, status }` — never the token.
   */
  private async request(
    method: string,
    path: string,
    jsonBody?: unknown,
  ): Promise<VaultHttpResponse> {
    const url = `${this.addr}${path}`;
    let backoff = INITIAL_BACKOFF_SECONDS;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const token = this.readToken();
      const args: VaultHttpRequestArgs = {
        method,
        url,
        headers: { "X-Vault-Token": token },
      };
      if (jsonBody !== undefined) args.jsonBody = jsonBody;

      let resp: VaultHttpResponse;
      try {
        resp = await this.http.request(args);
      } catch {
        // Transport error (network / timeout) — retry with backoff, or surface on the last attempt.
        // Redaction: the log line carries only the bounded fields, NEVER the token.
        logVaultEvent({ attempt: attempt + 1, method, path });
        if (attempt < MAX_RETRIES - 1) {
          await this.clock.sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw new VaultConnectivityError(`vault transport error after ${MAX_RETRIES} attempts`);
      }

      if (resp.status >= HTTP_SERVER_ERROR_FLOOR && resp.status < HTTP_SERVER_ERROR_CEIL) {
        logVaultEvent({ attempt: attempt + 1, method, path, status: resp.status });
        if (attempt < MAX_RETRIES - 1) {
          await this.clock.sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw new VaultConnectivityError(`vault ${resp.status} after ${MAX_RETRIES} attempts`);
      }

      return resp;
    }

    // Unreachable: the loop above either returns or raises.
    throw new VaultConnectivityError(`vault ${method} ${path} exhausted retries`);
  }

  // ─── KV-v2 ──────────────────────────────────────────────────────────────────────────────────

  public async kvRead(args: { path: string; version?: number }): Promise<Record<string, string>> {
    const suffix = args.version ? `?version=${args.version}` : "";
    const resp = await this.request("GET", `/v1/${this.kvMount}/data/${args.path}${suffix}`);
    if (resp.status === HTTP_NOT_FOUND) {
      throw new VaultPathNotFound(args.path);
    }
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new VaultConnectivityError(`kv_read ${args.path} returned ${resp.status}`);
    }
    const data = dataObject(parseJson(resp.bodyText));
    const inner = data?.["data"];
    if (typeof inner !== "object" || inner === null) {
      throw new VaultConnectivityError(`kv_read ${args.path}: unexpected response shape`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inner as Record<string, unknown>)) {
      out[k] = String(v);
    }
    return out;
  }

  /**
   * Read a KV secret WITHOUT coercing values to strings — preserves nested objects (unlike {@link kvRead},
   * which `String()`s every value, turning a nested object into "[object Object]"). Required for payloads
   * like the field-encryption keyset (`{current_version, keys: {vN: base64}}`). Mirrors the Python
   * `VaultPort.kv_read`'s `dict[str, Any]` return.
   */
  public async kvReadRaw(args: {
    path: string;
    version?: number;
  }): Promise<Record<string, unknown>> {
    const suffix = args.version ? `?version=${args.version}` : "";
    const resp = await this.request("GET", `/v1/${this.kvMount}/data/${args.path}${suffix}`);
    if (resp.status === HTTP_NOT_FOUND) {
      throw new VaultPathNotFound(args.path);
    }
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new VaultConnectivityError(`kv_read ${args.path} returned ${resp.status}`);
    }
    const data = dataObject(parseJson(resp.bodyText));
    const inner = data?.["data"];
    if (typeof inner !== "object" || inner === null) {
      throw new VaultConnectivityError(`kv_read ${args.path}: unexpected response shape`);
    }
    return inner as Record<string, unknown>;
  }

  public async kvWrite(args: {
    path: string;
    data: Record<string, string>;
    cas?: number;
  }): Promise<number> {
    const payload: Record<string, unknown> = { data: args.data };
    if (args.cas !== undefined) {
      payload["options"] = { cas: args.cas };
    }
    const resp = await this.request("POST", `/v1/${this.kvMount}/data/${args.path}`, payload);
    if (resp.status === HTTP_BAD_REQUEST && args.cas !== undefined) {
      // CAS mismatch is reported as 400 with a specific message; surface as the typed error.
      throw new VaultCasMismatch(`cas mismatch on ${args.path}`);
    }
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new VaultConnectivityError(`kv_write ${args.path} returned ${resp.status}`);
    }
    const data = dataObject(parseJson(resp.bodyText));
    const version = data?.["version"];
    if (typeof version !== "number" || !Number.isFinite(version)) {
      throw new VaultConnectivityError(`kv_write ${args.path}: unexpected response shape`);
    }
    return Math.trunc(version);
  }

  public async kvDelete(args: { path: string }): Promise<void> {
    const resp = await this.request("DELETE", `/v1/${this.kvMount}/metadata/${args.path}`);
    if (resp.status === HTTP_OK || resp.status === HTTP_NO_CONTENT || resp.status === HTTP_NOT_FOUND) {
      // 200/204 = deleted; 404 = already absent (idempotent).
      return;
    }
    throw new VaultConnectivityError(`kv_delete ${args.path} returned ${resp.status}`);
  }

  public async kvCurrentVersion(args: { path: string }): Promise<number> {
    // The Python wraps the request in try/except VaultPathNotFound -> return 0. `request()` itself
    // never raises VaultPathNotFound (only kvRead maps 404 → that error), so this is defensive; we
    // replicate it harmlessly by mapping the 404 status below.
    let resp: VaultHttpResponse;
    try {
      resp = await this.request("GET", `/v1/${this.kvMount}/metadata/${args.path}`);
    } catch (e) {
      if (e instanceof VaultPathNotFound) return 0;
      throw e;
    }
    if (resp.status === HTTP_NOT_FOUND) {
      return 0;
    }
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new VaultConnectivityError(`kv_current_version ${args.path} returned ${resp.status}`);
    }
    const data = dataObject(parseJson(resp.bodyText));
    const current = data?.["current_version"];
    if (typeof current !== "number" || !Number.isFinite(current)) {
      throw new VaultConnectivityError(`kv_current_version ${args.path}: unexpected response shape`);
    }
    return Math.trunc(current);
  }

  // ─── Transit ────────────────────────────────────────────────────────────────────────────────

  public async transitEncrypt(args: { keyName: string; plaintext: Uint8Array }): Promise<string> {
    const resp = await this.request("POST", `/v1/${this.transitMount}/encrypt/${args.keyName}`, {
      plaintext: Buffer.from(args.plaintext).toString("base64"),
    });
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new VaultConnectivityError(`transit_encrypt ${args.keyName} returned ${resp.status}`);
    }
    const data = dataObject(parseJson(resp.bodyText));
    const ciphertext = data?.["ciphertext"];
    if (typeof ciphertext !== "string") {
      throw new VaultConnectivityError(`transit_encrypt ${args.keyName}: unexpected response shape`);
    }
    return ciphertext;
  }

  public async transitDecrypt(args: {
    keyName: string;
    ciphertext: string;
  }): Promise<Uint8Array> {
    const resp = await this.request("POST", `/v1/${this.transitMount}/decrypt/${args.keyName}`, {
      ciphertext: args.ciphertext,
    });
    if (resp.status >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new VaultConnectivityError(`transit_decrypt ${args.keyName} returned ${resp.status}`);
    }
    const data = dataObject(parseJson(resp.bodyText));
    const plaintext = data?.["plaintext"];
    if (typeof plaintext !== "string") {
      throw new VaultConnectivityError(`transit_decrypt ${args.keyName}: unexpected response shape`);
    }
    return new Uint8Array(Buffer.from(plaintext, "base64"));
  }
}

/**
 * Emit a single redacted observability line. The fields are BOUNDED and the token is structurally
 * absent — there is no parameter through which a token could reach this function, so a future edit
 * cannot accidentally leak it. We keep it to a minimal `console.info`; a structured logger seam can
 * replace this verbatim later.
 */
function logVaultEvent(fields: {
  attempt: number;
  method: string;
  path: string;
  status?: number;
}): void {
  console.info("vault request event", fields);
}
