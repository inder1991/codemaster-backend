/**
 * Unit tests for {@link VaultHttpPort} — 1:1 behavioural parity with the frozen Python
 * `codemaster/adapters/vault_http.py`.
 *
 * No DB, no live network: a programmable in-memory {@link StubVaultHttpClient} records every request
 * and returns scripted responses; a {@link FakeClock} captures backoff sleeps without real waiting;
 * token files live in `os.tmpdir()` so the per-attempt re-read path is exercised against real fs.
 *
 * Each test names the specific Python semantic it pins — a regression in the port (a swapped status
 * mapping, a dropped per-attempt token re-read, a missing backoff double, a token leaking into a log
 * line) fails a NAMED test rather than slipping through.
 *
 * Axes exercised here:
 *   - URL shapes + status mapping per method (kvRead/kvWrite/kvDelete/kvCurrentVersion/transit*).
 *   - retry/backoff: 5xx and transport errors retry; recordedSleeps() === [0.5, 1.0]; no sleep on the
 *     final failed attempt.
 *   - per-attempt token re-read: a token FILE rewritten between attempts sends the NEW token on the
 *     retry.
 *   - token redaction: the token NEVER appears in any captured console line.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FetchVaultHttpClient,
  VaultHttpPort,
  type VaultHttpClient,
  type VaultHttpRequestArgs,
  type VaultHttpResponse,
} from "#backend/adapters/vault_http.js";
import {
  VaultCasMismatch,
  VaultConnectivityError,
  VaultPathNotFound,
} from "#backend/adapters/vault_port.js";
import { FakeClock } from "#platform/clock.js";

// ─── A programmable in-memory HTTP transport stub ──────────────────────────────────────────────

/** A scripted response, OR the sentinel "throw a transport error" (to drive the catch arm). */
type ScriptedResponse = VaultHttpResponse | "transport-error";

/**
 * Records every request and returns scripted responses in order. An optional `onRequest` callback
 * fires BEFORE each scripted response is popped — used to rewrite the token file between attempts.
 */
class StubVaultHttpClient implements VaultHttpClient {
  public readonly requests: Array<VaultHttpRequestArgs> = [];
  private readonly scripted: Array<ScriptedResponse>;
  private readonly onRequest: ((index: number) => void) | undefined;
  private index = 0;

  public constructor(
    scripted: Array<ScriptedResponse>,
    onRequest?: (index: number) => void,
  ) {
    this.scripted = scripted;
    this.onRequest = onRequest;
  }

  public async request(args: VaultHttpRequestArgs): Promise<VaultHttpResponse> {
    const currentIndex = this.index;
    this.onRequest?.(currentIndex);
    this.requests.push(args);
    const next = this.scripted[this.index];
    this.index += 1;
    if (next === undefined) {
      throw new Error(`StubVaultHttpClient: no scripted response for request #${currentIndex}`);
    }
    if (next === "transport-error") {
      throw new Error("simulated transport failure");
    }
    return next;
  }
}

/** Build a JSON response with default empty headers. */
function jsonResponse(status: number, body: unknown): VaultHttpResponse {
  return { status, headers: {}, bodyText: JSON.stringify(body) };
}

/** A VaultHttpPort backed by a direct token (no fs), the given transport, and a FakeClock. */
function portWith(
  http: VaultHttpClient,
  clock: FakeClock,
  opts: { token?: string } = {},
): VaultHttpPort {
  return new VaultHttpPort({
    addr: "https://vault.internal:8200/",
    token: opts.token ?? "test-token",
    http,
    clock,
  });
}

// ─── KV read ───────────────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort — kvRead", () => {
  it("should return data.data and issue GET /v1/secret/data/<path> with the token header", async () => {
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { data: { k: "v" } } })]);
    const port = portWith(http, new FakeClock(), { token: "tok-A" });

    const result = await port.kvRead({ path: "foo" });

    expect(result).toEqual({ k: "v" });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe("GET");
    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/secret/data/foo");
    expect(http.requests[0]!.headers["X-Vault-Token"]).toBe("tok-A");
  });

  it("should append ?version=2 only when version is provided", async () => {
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { data: { k: "v" } } })]);
    const port = portWith(http, new FakeClock());

    await port.kvRead({ path: "foo", version: 2 });

    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/secret/data/foo?version=2");
  });

  it("should throw VaultPathNotFound on 404", async () => {
    const http = new StubVaultHttpClient([jsonResponse(404, { errors: ["not found"] })]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvRead({ path: "missing" })).rejects.toThrow(VaultPathNotFound);
  });

  it("should throw VaultConnectivityError after retries are exhausted on 500", async () => {
    const http = new StubVaultHttpClient([
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(500, {}),
    ]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvRead({ path: "foo" })).rejects.toThrow(VaultConnectivityError);
    expect(http.requests).toHaveLength(3);
  });

  it("should throw VaultConnectivityError (unexpected-shape) on a 200 with the wrong shape", async () => {
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { notdata: 1 } })]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvRead({ path: "foo" })).rejects.toThrow(/unexpected response shape/);
  });
});

// ─── KV write ──────────────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort — kvWrite", () => {
  it("should return the new version and POST { data } to /v1/secret/data/<path>", async () => {
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { version: 3 } })]);
    const port = portWith(http, new FakeClock());

    const version = await port.kvWrite({ path: "foo", data: { k: "v" } });

    expect(version).toBe(3);
    expect(http.requests[0]!.method).toBe("POST");
    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/secret/data/foo");
    expect(http.requests[0]!.jsonBody).toEqual({ data: { k: "v" } });
  });

  it("should include options.cas only when cas is provided", async () => {
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { version: 4 } })]);
    const port = portWith(http, new FakeClock());

    await port.kvWrite({ path: "foo", data: { k: "v" }, cas: 2 });

    expect(http.requests[0]!.jsonBody).toEqual({ data: { k: "v" }, options: { cas: 2 } });
  });

  it("should throw VaultCasMismatch on 400 WHEN cas was provided", async () => {
    const http = new StubVaultHttpClient([jsonResponse(400, { errors: ["check-and-set"] })]);
    const port = portWith(http, new FakeClock());

    await expect(
      port.kvWrite({ path: "foo", data: { k: "v" }, cas: 2 }),
    ).rejects.toThrow(VaultCasMismatch);
  });

  it("should throw VaultConnectivityError on 400 WITHOUT cas", async () => {
    const http = new StubVaultHttpClient([jsonResponse(400, { errors: ["bad request"] })]);
    const port = portWith(http, new FakeClock());

    const err = await port.kvWrite({ path: "foo", data: { k: "v" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultConnectivityError);
    expect(err).not.toBeInstanceOf(VaultCasMismatch);
  });

  it("should throw VaultConnectivityError on 403", async () => {
    const http = new StubVaultHttpClient([jsonResponse(403, { errors: ["permission denied"] })]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvWrite({ path: "foo", data: { k: "v" } })).rejects.toThrow(
      VaultConnectivityError,
    );
  });
});

// ─── KV delete ──────────────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort — kvDelete", () => {
  it("should DELETE /v1/secret/metadata/<path> and resolve on 204", async () => {
    const http = new StubVaultHttpClient([{ status: 204, headers: {}, bodyText: "" }]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvDelete({ path: "foo" })).resolves.toBeUndefined();
    expect(http.requests[0]!.method).toBe("DELETE");
    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/secret/metadata/foo");
  });

  it("should resolve on 200", async () => {
    const http = new StubVaultHttpClient([{ status: 200, headers: {}, bodyText: "" }]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvDelete({ path: "foo" })).resolves.toBeUndefined();
  });

  it("should resolve on 404 (idempotent)", async () => {
    const http = new StubVaultHttpClient([{ status: 404, headers: {}, bodyText: "" }]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvDelete({ path: "foo" })).resolves.toBeUndefined();
  });

  it("should throw VaultConnectivityError on 500 after retries", async () => {
    const http = new StubVaultHttpClient([
      { status: 500, headers: {}, bodyText: "" },
      { status: 500, headers: {}, bodyText: "" },
      { status: 500, headers: {}, bodyText: "" },
    ]);
    const port = portWith(http, new FakeClock());

    await expect(port.kvDelete({ path: "foo" })).rejects.toThrow(VaultConnectivityError);
    expect(http.requests).toHaveLength(3);
  });
});

// ─── KV current version ──────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort — kvCurrentVersion", () => {
  it("should return current_version on 200 (GET /v1/secret/metadata/<path>)", async () => {
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { current_version: 5 } })]);
    const port = portWith(http, new FakeClock());

    const version = await port.kvCurrentVersion({ path: "foo" });

    expect(version).toBe(5);
    expect(http.requests[0]!.method).toBe("GET");
    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/secret/metadata/foo");
  });

  it("should return 0 on 404", async () => {
    const http = new StubVaultHttpClient([{ status: 404, headers: {}, bodyText: "" }]);
    const port = portWith(http, new FakeClock());

    expect(await port.kvCurrentVersion({ path: "foo" })).toBe(0);
  });
});

// ─── Transit ──────────────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort — transit", () => {
  it("should base64-encode plaintext on encrypt and return the ciphertext", async () => {
    const http = new StubVaultHttpClient([
      jsonResponse(200, { data: { ciphertext: "vault:v1:abc" } }),
    ]);
    const port = portWith(http, new FakeClock());
    const plaintext = new Uint8Array([104, 101, 108, 108, 111]); // "hello"

    const ciphertext = await port.transitEncrypt({ keyName: "k1", plaintext });

    expect(ciphertext).toBe("vault:v1:abc");
    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/transit/encrypt/k1");
    expect(http.requests[0]!.jsonBody).toEqual({
      plaintext: Buffer.from(plaintext).toString("base64"),
    });
  });

  it("should base64-decode plaintext on decrypt and return the bytes", async () => {
    const b64hello = Buffer.from("hello").toString("base64");
    const http = new StubVaultHttpClient([
      jsonResponse(200, { data: { plaintext: b64hello } }),
    ]);
    const port = portWith(http, new FakeClock());

    const bytes = await port.transitDecrypt({ keyName: "k1", ciphertext: "vault:v1:abc" });

    expect(http.requests[0]!.url).toBe("https://vault.internal:8200/v1/transit/decrypt/k1");
    expect(http.requests[0]!.jsonBody).toEqual({ ciphertext: "vault:v1:abc" });
    expect(Buffer.from(bytes).toString("utf8")).toBe("hello");
  });

  it("should throw VaultConnectivityError on a transit 400", async () => {
    const http = new StubVaultHttpClient([jsonResponse(400, { errors: ["nope"] })]);
    const port = portWith(http, new FakeClock());

    await expect(
      port.transitEncrypt({ keyName: "k1", plaintext: new Uint8Array([1]) }),
    ).rejects.toThrow(VaultConnectivityError);
  });
});

// ─── Retry / backoff ─────────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort — retry/backoff", () => {
  it("should retry 500,500,200 and sleep [0.5, 1.0]", async () => {
    const http = new StubVaultHttpClient([
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(200, { data: { data: { k: "v" } } }),
    ]);
    const clock = new FakeClock();
    const port = portWith(http, clock);

    const result = await port.kvRead({ path: "foo" });

    expect(result).toEqual({ k: "v" });
    expect(clock.recordedSleeps()).toEqual([0.5, 1.0]);
  });

  it("should sleep [0.5, 1.0] then fail on 500,500,500 (no sleep on the final attempt)", async () => {
    const http = new StubVaultHttpClient([
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(500, {}),
    ]);
    const clock = new FakeClock();
    const port = portWith(http, clock);

    await expect(port.kvRead({ path: "foo" })).rejects.toThrow(VaultConnectivityError);
    expect(clock.recordedSleeps()).toEqual([0.5, 1.0]);
  });

  it("should retry a transport error then succeed on 200", async () => {
    const http = new StubVaultHttpClient([
      "transport-error",
      jsonResponse(200, { data: { data: { k: "v" } } }),
    ]);
    const clock = new FakeClock();
    const port = portWith(http, clock);

    const result = await port.kvRead({ path: "foo" });

    expect(result).toEqual({ k: "v" });
    expect(clock.recordedSleeps()).toEqual([0.5]);
  });

  it("should throw VaultConnectivityError after three transport errors", async () => {
    const http = new StubVaultHttpClient([
      "transport-error",
      "transport-error",
      "transport-error",
    ]);
    const clock = new FakeClock();
    const port = portWith(http, clock);

    await expect(port.kvRead({ path: "foo" })).rejects.toThrow(VaultConnectivityError);
    expect(clock.recordedSleeps()).toEqual([0.5, 1.0]);
  });
});

// ─── Per-attempt token re-read (token FILE, not direct token) ──────────────────────────────────────

describe("VaultHttpPort — token from disk, re-read every attempt", () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-http-test-"));
    tokenPath = join(dir, "token");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should re-read the token file on the retry and send the rotated token", async () => {
    writeFileSync(tokenPath, "tok-1\n");

    // Rewrite the file to "tok-2" while the FIRST request (index 0) is being served, so the rotated
    // token is on disk by the time the adapter re-reads it at the TOP of the second attempt. (The
    // adapter reads the token BEFORE calling http.request, so rewriting at index 1 would be too
    // late — proving the per-attempt re-read happens before each dispatch.)
    const http = new StubVaultHttpClient(
      [jsonResponse(500, {}), jsonResponse(200, { data: { data: { k: "v" } } })],
      (index) => {
        if (index === 0) writeFileSync(tokenPath, "tok-2\n");
      },
    );
    const clock = new FakeClock();
    const port = new VaultHttpPort({
      addr: "https://vault.internal:8200",
      tokenPath,
      http,
      clock,
    });

    await port.kvRead({ path: "foo" });

    expect(http.requests[0]!.headers["X-Vault-Token"]).toBe("tok-1");
    expect(http.requests[1]!.headers["X-Vault-Token"]).toBe("tok-2");
  });

  it("should throw a STERILE VaultConnectivityError when the token file is missing", async () => {
    // tokenPath was never written.
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { data: { k: "v" } } })]);
    const port = new VaultHttpPort({
      addr: "https://vault.internal:8200",
      tokenPath,
      http,
      clock: new FakeClock(),
    });

    const err = await port.kvRead({ path: "foo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultConnectivityError);
    expect((err as Error).message).toBe("vault token file unreadable");
    // The message leaks NEITHER the path NOR a token.
    expect((err as Error).message).not.toContain(tokenPath);
    expect((err as Error).message).not.toContain(dir);
  });

  it("should trim whitespace from the token file contents", async () => {
    writeFileSync(tokenPath, "  tok-trimmed  \n");
    const http = new StubVaultHttpClient([jsonResponse(200, { data: { data: { k: "v" } } })]);
    const port = new VaultHttpPort({
      addr: "https://vault.internal:8200",
      tokenPath,
      http,
      clock: new FakeClock(),
    });

    await port.kvRead({ path: "foo" });

    expect(http.requests[0]!.headers["X-Vault-Token"]).toBe("tok-trimmed");
  });
});

// ─── Token redaction in logs ───────────────────────────────────────────────────────────────────

describe("VaultHttpPort — token redaction", () => {
  it("should never write the token into any console line across a multi-attempt request", async () => {
    const secretToken = "s3cr3t-token-DO-NOT-LEAK";
    const lines: Array<string> = [];
    const capture = (...args: Array<unknown>): void => {
      lines.push(args.map((a) => JSON.stringify(a)).join(" "));
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(capture);
    const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(capture);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(capture);

    try {
      const http = new StubVaultHttpClient([
        jsonResponse(500, {}),
        jsonResponse(500, {}),
        jsonResponse(200, { data: { data: { k: "v" } } }),
      ]);
      const port = portWith(http, new FakeClock(), { token: secretToken });

      await port.kvRead({ path: "foo" });
    } finally {
      infoSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // We DID log something (the redacted retry events) but never the token.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(secretToken);
    }
  });
});

// ─── fromEnv ───────────────────────────────────────────────────────────────────────────────────

describe("VaultHttpPort.fromEnv", () => {
  const saved = {
    addr: process.env["VAULT_ADDR"],
    token: process.env["VAULT_TOKEN"],
    agentPath: process.env["VAULT_AGENT_TOKEN_PATH"],
  };

  afterEach(() => {
    restoreEnv("VAULT_ADDR", saved.addr);
    restoreEnv("VAULT_TOKEN", saved.token);
    restoreEnv("VAULT_AGENT_TOKEN_PATH", saved.agentPath);
  });

  it("should throw VaultConnectivityError when VAULT_ADDR is unset", () => {
    delete process.env["VAULT_ADDR"];
    delete process.env["VAULT_TOKEN"];

    expect(() => VaultHttpPort.fromEnv()).toThrow(VaultConnectivityError);
  });

  it("should construct with a direct token when VAULT_TOKEN is set", () => {
    process.env["VAULT_ADDR"] = "https://vault.internal:8200";
    process.env["VAULT_TOKEN"] = "env-token";

    expect(VaultHttpPort.fromEnv()).toBeInstanceOf(VaultHttpPort);
  });

  it("should construct from the agent token path when VAULT_TOKEN is unset", () => {
    process.env["VAULT_ADDR"] = "https://vault.internal:8200";
    delete process.env["VAULT_TOKEN"];
    process.env["VAULT_AGENT_TOKEN_PATH"] = "/var/run/secrets/vault/token";

    expect(VaultHttpPort.fromEnv()).toBeInstanceOf(VaultHttpPort);
  });
});

/** Restore an env var to a saved value, deleting it if the saved value was undefined. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// ─── FetchVaultHttpClient (transport seam) — exercised without live network ──────────────────────

describe("FetchVaultHttpClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should set Content-Type + JSON body when jsonBody is present", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      async (url: string, init: RequestInit): Promise<Response> => {
        captured.url = url;
        captured.init = init;
        return new Response("{}", { status: 200 });
      },
    );
    const client = new FetchVaultHttpClient({ timeoutSeconds: 5 });

    const resp = await client.request({
      method: "POST",
      url: "https://vault.internal/v1/secret/data/foo",
      headers: { "X-Vault-Token": "tok" },
      jsonBody: { data: { k: "v" } },
    });

    expect(resp.status).toBe(200);
    const headers = captured.init!.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(captured.init!.body).toBe(JSON.stringify({ data: { k: "v" } }));
  });

  it("should NOT set a body for a GET (no jsonBody)", async () => {
    const captured: { init?: RequestInit } = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit): Promise<Response> => {
      captured.init = init;
      return new Response("{}", { status: 200 });
    });
    const client = new FetchVaultHttpClient({ timeoutSeconds: 5 });

    await client.request({
      method: "GET",
      url: "https://vault.internal/v1/secret/data/foo",
      headers: { "X-Vault-Token": "tok" },
    });

    expect(captured.init!.body).toBeUndefined();
  });

  it("should map a fetch network error to a thrown transport error (retryable)", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => {
      throw new TypeError("network down");
    });
    const client = new FetchVaultHttpClient({ timeoutSeconds: 5 });

    await expect(
      client.request({ method: "GET", url: "https://vault.internal/x", headers: {} }),
    ).rejects.toThrow();
  });
});
