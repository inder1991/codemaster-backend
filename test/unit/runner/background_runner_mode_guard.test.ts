// CS1.1 defense-in-depth: runBackgroundRunner itself REFUSES to boot under mode 'temporal' —
// mutual exclusivity is enforced at the runner boundary too, not only in resolveBootTasks, so a
// future caller (or a direct `node background_runner_main.js` invocation) can never boot the
// Postgres runtime while the Temporal runtime owns the crons/outbox. The guard fires BEFORE any
// config resolution / DB construction (proven by stubbing a DSN that would otherwise let the boot
// proceed toward real I/O).

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBackgroundRunner } from "#backend/runner/background_runner_main.js";

describe("runBackgroundRunner mode guard (CS1.1 mutual exclusivity)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mode 'temporal' rejects naming the exclusivity — BEFORE config/DB are ever touched", async () => {
    // A DSN is present: if the guard failed to fire first, the boot would proceed toward the pool /
    // sink wiring instead of this specific refusal.
    vi.stubEnv("CODEMASTER_PG_CORE_DSN", "postgresql://guard-must-fire-first:5432/never");
    await expect(runBackgroundRunner("temporal" as never)).rejects.toThrow(/mutually exclusive/);
    await expect(runBackgroundRunner("temporal" as never)).rejects.toThrow(/postgres|shadow/);
  });

  it("a VALID mode passes the guard and hits the ordinary fail-loud config (missing DSN)", async () => {
    vi.stubEnv("CODEMASTER_PG_CORE_DSN", "");
    await expect(runBackgroundRunner("postgres")).rejects.toThrow(/CODEMASTER_PG_CORE_DSN/);
    await expect(runBackgroundRunner("shadow")).rejects.toThrow(/CODEMASTER_PG_CORE_DSN/);
  });
});
