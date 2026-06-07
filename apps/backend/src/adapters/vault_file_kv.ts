// FileKvReader — the Vault Agent file-injection KV read adapter (ADR-0071).
//
// The Vault Agent Injector renders each KV secret's data map to a memory-backed (tmpfs) file as
// `.Data.data | toJSON`. This reader satisfies the same narrow `kvRead` surface the consumers depend on
// (structurally compatible with VaultKvReadPort + VaultPort.kvRead), reading + JSON-parsing the rendered
// file instead of calling the Vault KV API — so the app holds no Vault token for static-secret reads and
// is decoupled from Vault API availability for them. Transit + KV writes stay on VaultHttpPort (online
// operations a file cannot represent). See ADR-0071.

import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

import { VaultConnectivityError, VaultError, VaultPathNotFound } from "./vault_port.js";

/** Default mount point the Vault Agent Injector renders secrets under. */
export const DEFAULT_VAULT_SECRETS_DIR = "/vault/secrets";

/** Map a Vault KV path to the rendered filename: every non-alphanumeric char → `_`
 *  (`codemaster/github/app` → `codemaster_github_app`). The deploy-side Agent annotation MUST render the
 *  secret to `<secretsDir>/<this>` (ADR-0071 — the filename is the Agent↔app contract). */
export function sanitizeVaultPathToFilename(path: string): string {
  return path.replace(/[^a-z0-9]/gi, "_");
}

export class FileKvReader {
  readonly #secretsDir: string;
  readonly #readFile: (p: string) => Promise<string>;

  public constructor(
    args: { secretsDir?: string; readFile?: (p: string) => Promise<string> } = {},
  ) {
    this.#secretsDir =
      args.secretsDir ?? process.env["CODEMASTER_VAULT_SECRETS_DIR"] ?? DEFAULT_VAULT_SECRETS_DIR;
    this.#readFile = args.readFile ?? ((p) => fsReadFile(p, "utf-8"));
  }

  /** Read the Agent-rendered KV data map for `path`. Re-reads the file on every call (the Agent
   *  re-renders on rotation, so the next read is always current — matching the no-cache token convention).
   *  Returns the same `Record<string,string>` shape `VaultPort.kvRead` returns. */
  public async kvRead(args: { path: string; version?: number }): Promise<Record<string, string>> {
    // The Agent renders only the LATEST version; undefined / 0 mean "latest" (Vault's convention), any
    // specific version >= 1 cannot be served from a file.
    if (args.version !== undefined && args.version !== 0) {
      throw new VaultError(
        `FileKvReader: versioned reads are not supported in agent-file mode (path=${args.path} ` +
          `version=${args.version}); the Vault Agent renders only the latest version`,
      );
    }

    const file = join(this.#secretsDir, sanitizeVaultPathToFilename(args.path));

    let raw: string;
    try {
      raw = await this.#readFile(file);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") {
        throw new VaultPathNotFound(
          `${args.path} (no rendered secret file at ${file}; check the Vault Agent inject annotations)`,
        );
      }
      throw new VaultConnectivityError(
        `reading rendered secret file for ${args.path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VaultError(
        `rendered secret file for ${args.path} is not valid JSON (expected the Agent template ` +
          `'.Data.data | toJSON')`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new VaultError(`rendered secret file for ${args.path} is not a JSON object`);
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (typeof value !== "string") {
        throw new VaultError(
          `rendered secret file for ${args.path} has a non-string value for key '${key}' ` +
            `(Vault KV secret material must be strings)`,
        );
      }
    }
    // All values validated as strings; rebuild via fromEntries (no dynamic-key assignment sink).
    return Object.fromEntries(entries) as Record<string, string>;
  }
}
