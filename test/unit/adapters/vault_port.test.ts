/**
 * Unit tests for {@link InMemoryVault} — 1:1 behavioural parity with the frozen Python
 * `codemaster/adapters/vault_port.py` InMemoryVault test double.
 *
 * No DB, no network: this is a pure in-memory test double. Every assertion below was written with
 * watch-it-fail discipline — each test names the specific Python semantic it pins, so a regression
 * in the port (off-by-one on the 1-indexed version map, a missing copy-on-read, a swallowed cas
 * check) fails a NAMED test rather than slipping through.
 *
 * Port-fidelity axes exercised here:
 *   - 1-indexed versions: version N lives at array index N-1; kvWrite returns the NEW length.
 *   - cas check-and-set: cas === current writes; cas !== current throws VaultCasMismatch.
 *   - copy semantics: mutating a returned record does NOT change a subsequent read.
 *   - bytes -> Uint8Array: transit round-trips the EXACT bytes; compared via Buffer.compare.
 *   - unreachable toggle: simulateUnreachable(true) makes EVERY method throw; (false) restores.
 */

import { describe, it, expect } from "vitest";

import {
  InMemoryVault,
  VaultCasMismatch,
  VaultPathNotFound,
  VaultConnectivityError,
} from "#backend/adapters/vault_port.js";

/** Exact-bytes equality helper (the task's prescribed Buffer.compare idiom). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

describe("InMemoryVault — kv write/read versioning", () => {
  it("should return v1 then v2 (monotonic versions) on successive writes", async () => {
    const vault = new InMemoryVault();

    const v1 = await vault.kvWrite({ path: "secret/app", data: { token: "a" } });
    const v2 = await vault.kvWrite({ path: "secret/app", data: { token: "b" } });

    expect(v1).toBe(1);
    expect(v2).toBe(2);
  });

  it("should read the latest version when version is omitted", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } });
    await vault.kvWrite({ path: "secret/app", data: { token: "b" } });

    const latest = await vault.kvRead({ path: "secret/app" });

    expect(latest).toEqual({ token: "b" });
  });

  it("should read an explicit historical version (1-indexed -> array index N-1)", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } }); // version 1
    await vault.kvWrite({ path: "secret/app", data: { token: "b" } }); // version 2

    const v1 = await vault.kvRead({ path: "secret/app", version: 1 });
    const v2 = await vault.kvRead({ path: "secret/app", version: 2 });

    expect(v1).toEqual({ token: "a" });
    expect(v2).toEqual({ token: "b" });
  });

  it("should throw VaultPathNotFound when reading a path that was never written", async () => {
    const vault = new InMemoryVault();

    await expect(vault.kvRead({ path: "secret/missing" })).rejects.toThrow(VaultPathNotFound);
  });

  it("should treat version 0 as latest (Python `(version or len)`; Vault convention 0=current)", async () => {
    // Parity: Python kv_read computes `idx = (version or len) - 1`, so version=0 (falsy) reads the
    // LATEST version — it does NOT raise. The HTTP adapter agrees (`?version=` suffix is appended
    // only `if version`, so 0 -> no suffix -> latest). The InMemoryVault must match both. This is
    // the regression guard for the `??`-vs-`||` bug the adversarial parity check caught: `??` does
    // not coalesce 0, so it wrongly mapped version 0 -> idx -1 -> VaultPathNotFound.
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "v1" } });
    await vault.kvWrite({ path: "secret/app", data: { token: "v2" } });

    await expect(vault.kvRead({ path: "secret/app", version: 0 })).resolves.toEqual({ token: "v2" });
  });

  it("should throw VaultPathNotFound when reading a version above the latest", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } }); // only version 1 exists

    await expect(vault.kvRead({ path: "secret/app", version: 2 })).rejects.toThrow(
      VaultPathNotFound,
    );
  });
});

describe("InMemoryVault — check-and-set (cas)", () => {
  it("should write when cas matches the current version (cas=0 on first write)", async () => {
    const vault = new InMemoryVault();

    const v1 = await vault.kvWrite({ path: "secret/app", data: { token: "a" }, cas: 0 });
    const v2 = await vault.kvWrite({ path: "secret/app", data: { token: "b" }, cas: 1 });

    expect(v1).toBe(1);
    expect(v2).toBe(2);
  });

  it("should throw VaultCasMismatch when cas does not equal the current version", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } }); // current is now 1

    // cas=0 but current=1 → conflict.
    await expect(
      vault.kvWrite({ path: "secret/app", data: { token: "b" }, cas: 0 }),
    ).rejects.toThrow(VaultCasMismatch);
  });

  it("should NOT have written when a cas mismatch is thrown (version stays put)", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } });

    await expect(
      vault.kvWrite({ path: "secret/app", data: { token: "b" }, cas: 99 }),
    ).rejects.toThrow(VaultCasMismatch);

    expect(await vault.kvCurrentVersion({ path: "secret/app" })).toBe(1);
  });
});

describe("InMemoryVault — kvCurrentVersion", () => {
  it("should return 0 for an absent path then increment per write", async () => {
    const vault = new InMemoryVault();

    expect(await vault.kvCurrentVersion({ path: "secret/app" })).toBe(0);

    await vault.kvWrite({ path: "secret/app", data: { token: "a" } });
    expect(await vault.kvCurrentVersion({ path: "secret/app" })).toBe(1);

    await vault.kvWrite({ path: "secret/app", data: { token: "b" } });
    expect(await vault.kvCurrentVersion({ path: "secret/app" })).toBe(2);
  });
});

describe("InMemoryVault — kvDelete", () => {
  it("should make a subsequent read throw VaultPathNotFound after delete", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } });

    await vault.kvDelete({ path: "secret/app" });

    await expect(vault.kvRead({ path: "secret/app" })).rejects.toThrow(VaultPathNotFound);
    expect(await vault.kvCurrentVersion({ path: "secret/app" })).toBe(0);
  });

  it("should be idempotent — deleting an absent path does not throw", async () => {
    const vault = new InMemoryVault();

    await expect(vault.kvDelete({ path: "secret/never-existed" })).resolves.toBeUndefined();
  });
});

describe("InMemoryVault — transit encrypt/decrypt", () => {
  it("should round-trip the EXACT bytes on encrypt then decrypt", async () => {
    const vault = new InMemoryVault();
    const plaintext = new Uint8Array([0, 1, 2, 250, 255, 128]);

    const ciphertext = await vault.transitEncrypt({ keyName: "k1", plaintext });
    const recovered = await vault.transitDecrypt({ keyName: "k1", ciphertext });

    expect(bytesEqual(recovered, plaintext)).toBe(true);
    expect([...recovered]).toEqual([0, 1, 2, 250, 255, 128]);
  });

  it("should yield DIFFERENT ciphertext blobs for two encrypts of the SAME plaintext (counter)", async () => {
    const vault = new InMemoryVault();
    const plaintext = new Uint8Array([42]);

    const c1 = await vault.transitEncrypt({ keyName: "k1", plaintext });
    const c2 = await vault.transitEncrypt({ keyName: "k1", plaintext });

    expect(c1).not.toBe(c2);
    expect(c1).toBe("vault:v1:k1:1");
    expect(c2).toBe("vault:v1:k1:2");
    // Both must still decrypt back to the same bytes.
    expect(bytesEqual(await vault.transitDecrypt({ keyName: "k1", ciphertext: c1 }), plaintext)).toBe(
      true,
    );
    expect(bytesEqual(await vault.transitDecrypt({ keyName: "k1", ciphertext: c2 }), plaintext)).toBe(
      true,
    );
  });
});

describe("InMemoryVault — simulateUnreachable", () => {
  it("should make EVERY method throw VaultConnectivityError when unreachable, then restore", async () => {
    const vault = new InMemoryVault();
    // Seed some state while reachable so the read/delete paths have something to hit.
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } });
    const ciphertext = await vault.transitEncrypt({
      keyName: "k1",
      plaintext: new Uint8Array([1]),
    });

    vault.simulateUnreachable(true);

    await expect(vault.kvWrite({ path: "secret/app", data: { token: "b" } })).rejects.toThrow(
      VaultConnectivityError,
    );
    await expect(vault.kvRead({ path: "secret/app" })).rejects.toThrow(VaultConnectivityError);
    await expect(vault.kvCurrentVersion({ path: "secret/app" })).rejects.toThrow(
      VaultConnectivityError,
    );
    await expect(vault.kvDelete({ path: "secret/app" })).rejects.toThrow(VaultConnectivityError);
    await expect(
      vault.transitEncrypt({ keyName: "k1", plaintext: new Uint8Array([2]) }),
    ).rejects.toThrow(VaultConnectivityError);
    await expect(vault.transitDecrypt({ keyName: "k1", ciphertext })).rejects.toThrow(
      VaultConnectivityError,
    );

    // Flip back — operations resume normally and prior state survived.
    vault.simulateUnreachable(false);

    expect(await vault.kvCurrentVersion({ path: "secret/app" })).toBe(1);
    expect(await vault.kvRead({ path: "secret/app" })).toEqual({ token: "a" });
    expect(
      bytesEqual(await vault.transitDecrypt({ keyName: "k1", ciphertext }), new Uint8Array([1])),
    ).toBe(true);
  });

  it("should default the value arg to true (simulateUnreachable() with no arg)", async () => {
    const vault = new InMemoryVault();

    vault.simulateUnreachable();

    await expect(vault.kvCurrentVersion({ path: "secret/app" })).rejects.toThrow(
      VaultConnectivityError,
    );
  });
});

describe("InMemoryVault — copy semantics (no shared mutable state)", () => {
  it("should NOT reflect mutations to the returned record on a subsequent read (copy-on-read)", async () => {
    const vault = new InMemoryVault();
    await vault.kvWrite({ path: "secret/app", data: { token: "a" } });

    const first = await vault.kvRead({ path: "secret/app" });
    first["token"] = "TAMPERED";
    first["extra"] = "injected";

    const second = await vault.kvRead({ path: "secret/app" });
    expect(second).toEqual({ token: "a" });
  });

  it("should NOT reflect post-write mutations of the caller's input object (copy-on-write)", async () => {
    const vault = new InMemoryVault();
    const input: Record<string, string> = { token: "a" };

    await vault.kvWrite({ path: "secret/app", data: input });
    input["token"] = "TAMPERED"; // mutate AFTER the write returns

    const read = await vault.kvRead({ path: "secret/app" });
    expect(read).toEqual({ token: "a" });
  });
});
