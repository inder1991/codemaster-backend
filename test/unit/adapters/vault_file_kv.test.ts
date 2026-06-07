// Unit tests for FileKvReader — the Vault Agent file-injection KV read adapter (ADR-0071). Reads the
// Agent-rendered secret file (a JSON data map) for a sanitized KV path; an injected readFile stub stands
// in for the filesystem so no real files are needed.

import { describe, expect, it, vi } from "vitest";

import { FileKvReader, sanitizeVaultPathToFilename } from "#backend/adapters/vault_file_kv.js";
import { VaultConnectivityError, VaultError, VaultPathNotFound } from "#backend/adapters/vault_port.js";

function reader(opts: { files?: Record<string, string>; throwErr?: Error; secretsDir?: string }): {
  r: FileKvReader;
  readFile: ReturnType<typeof vi.fn>;
} {
  const files = opts.files ?? {};
  const readFile = vi.fn(async (p: string): Promise<string> => {
    if (opts.throwErr) throw opts.throwErr;
    const content = files[p];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    }
    return content;
  });
  return { r: new FileKvReader({ secretsDir: opts.secretsDir ?? "/vault/secrets", readFile }), readFile };
}

describe("sanitizeVaultPathToFilename", () => {
  it("replaces every non-alphanumeric char with _", () => {
    expect(sanitizeVaultPathToFilename("codemaster/github/app")).toBe("codemaster_github_app");
    expect(sanitizeVaultPathToFilename("codemaster/field-encryption/keys")).toBe(
      "codemaster_field_encryption_keys",
    );
  });
});

describe("FileKvReader.kvRead", () => {
  it("reads + JSON-parses the rendered file for the sanitized path and returns the data map", async () => {
    const { r, readFile } = reader({
      files: {
        "/vault/secrets/codemaster_github_app": JSON.stringify({ webhook_secret: "whsec", app_id: "123" }),
      },
    });
    const data = await r.kvRead({ path: "codemaster/github/app" });
    expect(data).toEqual({ webhook_secret: "whsec", app_id: "123" });
    expect(readFile).toHaveBeenCalledWith("/vault/secrets/codemaster_github_app");
  });

  it("throws VaultPathNotFound when the secret file is absent (not rendered by the Agent)", async () => {
    const { r } = reader({ files: {} });
    await expect(r.kvRead({ path: "codemaster/github/app" })).rejects.toBeInstanceOf(VaultPathNotFound);
  });

  it("throws VaultConnectivityError on a non-ENOENT read error", async () => {
    const { r } = reader({ throwErr: Object.assign(new Error("EACCES"), { code: "EACCES" }) });
    await expect(r.kvRead({ path: "codemaster/github/app" })).rejects.toBeInstanceOf(
      VaultConnectivityError,
    );
  });

  it("throws VaultError when the file is not valid JSON", async () => {
    const { r } = reader({ files: { "/vault/secrets/p": "not-json{" } });
    const err = await r.kvRead({ path: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err).not.toBeInstanceOf(VaultPathNotFound);
  });

  it("throws VaultError when a value is not a string (KV secret material must be strings)", async () => {
    const { r } = reader({ files: { "/vault/secrets/p": JSON.stringify({ a: 123 }) } });
    const err = await r.kvRead({ path: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err).not.toBeInstanceOf(VaultConnectivityError);
  });

  it("throws VaultError when the JSON is not an object (array/scalar)", async () => {
    const { r } = reader({ files: { "/vault/secrets/p": JSON.stringify(["a", "b"]) } });
    await expect(r.kvRead({ path: "p" })).rejects.toBeInstanceOf(VaultError);
  });

  it("rejects a specific versioned read (the Agent only renders latest), but allows undefined/0 (latest)", async () => {
    const { r } = reader({ files: { "/vault/secrets/p": JSON.stringify({ a: "b" }) } });
    await expect(r.kvRead({ path: "p", version: 2 })).rejects.toBeInstanceOf(VaultError);
    await expect(r.kvRead({ path: "p", version: 0 })).resolves.toEqual({ a: "b" });
    await expect(r.kvRead({ path: "p" })).resolves.toEqual({ a: "b" });
  });
});
