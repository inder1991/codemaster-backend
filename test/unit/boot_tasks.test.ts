// CS1.1 (cutover-safety plan finding CS1 — audit C7/C9/RC8/C8/RT1): ONE runtime mode
// (CODEMASTER_RUNTIME_MODE = temporal | postgres | shadow) replaces the two independent cutover
// booleans (CODEMASTER_RUN_BACKGROUND_RUNNER + CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS) whose 2×2
// combinations allowed Temporal AND the Postgres runtime to boot TOGETHER (crash-loop /
// double-cron: both runtimes fire the same crons and drain the same outbox). The mode makes the
// two runtimes MUTUALLY EXCLUSIVE BY CONSTRUCTION — resolveBootTasks's branches are disjoint:
//
//   * "temporal" (DEFAULT — unset/"" back-compat): EXACTLY the two Temporal workers; NEVER the
//     background runner.
//   * "postgres": EXACTLY the background runner; NEVER any Temporal task.
//   * "shadow": EXACTLY the background runner, with the mode threaded through to
//     deps.runBackgroundRunner so the runner knows it is shadowing; NEVER any Temporal task.
//   * anything else: REFUSES boot naming the valid values (fail-loud BEFORE the HTTP server binds).
//   * either DEPRECATED boolean still set (any value): REFUSES boot naming the replacement — a
//     set-but-now-IGNORED cutover flag is exactly the hazard class the mode removes; an operator
//     deploying stale env must get a crash-loop naming the migration, never a silent mode.

import { describe, expect, it, vi } from "vitest";

import {
  DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV,
  DEPRECATED_RUN_BACKGROUND_RUNNER_ENV,
  RUNTIME_MODE_ENV,
  parseRuntimeMode,
  resolveBootTasks,
  type BootDeps,
  type BootTaskName,
} from "#backend/boot_tasks.js";

/** The two Temporal task names — the half of the vocabulary that must NEVER co-boot with the
 *  background runner. */
const TEMPORAL_TASKS: ReadonlyArray<BootTaskName> = [
  "temporal-worker",
  "temporal-outbox-dispatcher",
];

/** Injected thunks that EXPLODE if invoked — resolveBootTasks must COMPOSE, never BOOT. */
function explodingDeps(): BootDeps {
  return {
    runWorker: vi.fn(async () => {
      throw new Error("runWorker must not be invoked by resolveBootTasks");
    }),
    runOutboxDispatcherWorker: vi.fn(async () => {
      throw new Error("runOutboxDispatcherWorker must not be invoked by resolveBootTasks");
    }),
    runBackgroundRunner: vi.fn(async () => {
      throw new Error("runBackgroundRunner must not be invoked by resolveBootTasks");
    }),
  };
}

/** Deps whose runner thunk RECORDS the mode it received (the temporal thunks still explode). */
function recordingRunnerDeps(): { deps: BootDeps; receivedModes: Array<string> } {
  const receivedModes: Array<string> = [];
  const base = explodingDeps();
  return {
    deps: {
      ...base,
      runBackgroundRunner: async (mode) => {
        receivedModes.push(mode);
      },
    },
    receivedModes,
  };
}

describe("parseRuntimeMode", () => {
  it("unset → 'temporal' (back-compat: the pre-mode boot shape)", () => {
    expect(parseRuntimeMode({})).toBe("temporal");
  });

  it("empty string → 'temporal' (Helm templating may render empty values)", () => {
    expect(parseRuntimeMode({ [RUNTIME_MODE_ENV]: "" })).toBe("temporal");
  });

  it.each(["temporal", "postgres", "shadow"] as const)("'%s' parses to itself", (mode) => {
    expect(parseRuntimeMode({ [RUNTIME_MODE_ENV]: mode })).toBe(mode);
  });

  it.each(["true", "1", "TEMPORAL", "Postgres", " postgres", "both", "none"])(
    "garbage '%s' REFUSES boot, naming the env var AND the valid values",
    (raw) => {
      expect(() => parseRuntimeMode({ [RUNTIME_MODE_ENV]: raw })).toThrow(
        new RegExp(RUNTIME_MODE_ENV),
      );
      expect(() => parseRuntimeMode({ [RUNTIME_MODE_ENV]: raw })).toThrow(
        /temporal\|postgres\|shadow/,
      );
    },
  );

  it.each(["true", "1", "false", "0", "banana"])(
    "DEPRECATED CODEMASTER_RUN_BACKGROUND_RUNNER='%s' REFUSES boot naming the replacement — even alongside a VALID mode",
    (raw) => {
      const env = { [RUNTIME_MODE_ENV]: "postgres", [DEPRECATED_RUN_BACKGROUND_RUNNER_ENV]: raw };
      expect(() => parseRuntimeMode(env)).toThrow(new RegExp(DEPRECATED_RUN_BACKGROUND_RUNNER_ENV));
      expect(() => parseRuntimeMode(env)).toThrow(new RegExp(RUNTIME_MODE_ENV));
    },
  );

  it.each(["true", "1", "false", "0", "banana"])(
    "DEPRECATED CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS='%s' REFUSES boot naming the replacement",
    (raw) => {
      const env = { [DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV]: raw };
      expect(() => parseRuntimeMode(env)).toThrow(
        new RegExp(DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV),
      );
      expect(() => parseRuntimeMode(env)).toThrow(new RegExp(RUNTIME_MODE_ENV));
    },
  );

  it("deprecated vars unset or empty are tolerated (absent stale config is fine)", () => {
    expect(
      parseRuntimeMode({
        [DEPRECATED_RUN_BACKGROUND_RUNNER_ENV]: "",
        [DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV]: "",
      }),
    ).toBe("temporal");
  });
});

describe("resolveBootTasks", () => {
  it("mode UNSET (the default) → EXACTLY the two Temporal tasks; NO background runner", () => {
    const tasks = resolveBootTasks({}, explodingDeps());
    expect(tasks.map((t) => t.name)).toEqual(["temporal-worker", "temporal-outbox-dispatcher"]);
  });

  it("mode 'temporal' → EXACTLY the two Temporal tasks, thunks BY IDENTITY (no wrapping)", () => {
    const deps = explodingDeps();
    const tasks = resolveBootTasks({ [RUNTIME_MODE_ENV]: "temporal" }, deps);
    expect(tasks.map((t) => t.name)).toEqual(["temporal-worker", "temporal-outbox-dispatcher"]);
    expect(tasks[0]?.run).toBe(deps.runWorker);
    expect(tasks[1]?.run).toBe(deps.runOutboxDispatcherWorker);
  });

  it("mode 'postgres' → EXACTLY [background-runner]; invoking its thunk threads mode='postgres'", async () => {
    const { deps, receivedModes } = recordingRunnerDeps();
    const tasks = resolveBootTasks({ [RUNTIME_MODE_ENV]: "postgres" }, deps);
    expect(tasks.map((t) => t.name)).toEqual(["background-runner"]);
    await tasks[0]!.run();
    expect(receivedModes).toEqual(["postgres"]);
  });

  it("mode 'shadow' → EXACTLY [background-runner]; invoking its thunk threads mode='shadow'", async () => {
    const { deps, receivedModes } = recordingRunnerDeps();
    const tasks = resolveBootTasks({ [RUNTIME_MODE_ENV]: "shadow" }, deps);
    expect(tasks.map((t) => t.name)).toEqual(["background-runner"]);
    await tasks[0]!.run();
    expect(receivedModes).toEqual(["shadow"]);
  });

  it("EXCLUSIVITY INVARIANT: no mode ever boots a Temporal task AND the background runner; no mode boots nothing", () => {
    const envs: ReadonlyArray<NodeJS.ProcessEnv> = [
      {},
      { [RUNTIME_MODE_ENV]: "" },
      { [RUNTIME_MODE_ENV]: "temporal" },
      { [RUNTIME_MODE_ENV]: "postgres" },
      { [RUNTIME_MODE_ENV]: "shadow" },
    ];
    for (const env of envs) {
      const names = resolveBootTasks(env, explodingDeps()).map((t) => t.name);
      const hasTemporal = names.some((n) => TEMPORAL_TASKS.includes(n));
      const hasRunner = names.includes("background-runner");
      expect(hasTemporal && hasRunner).toBe(false); // NEVER both → no double-cron / double-drain
      expect(hasTemporal || hasRunner).toBe(true); // NEVER an empty boot
    }
  });

  it("mode 'temporal' NEVER contains background-runner; 'postgres'/'shadow' NEVER contain a Temporal task", () => {
    const temporalNames = resolveBootTasks({ [RUNTIME_MODE_ENV]: "temporal" }, explodingDeps()).map(
      (t) => t.name,
    );
    expect(temporalNames).not.toContain("background-runner");
    for (const mode of ["postgres", "shadow"]) {
      const names = resolveBootTasks({ [RUNTIME_MODE_ENV]: mode }, explodingDeps()).map(
        (t) => t.name,
      );
      for (const temporalTask of TEMPORAL_TASKS) {
        expect(names).not.toContain(temporalTask);
      }
    }
  });

  it("resolveBootTasks NEVER invokes any dep (composition only — main.ts owns when tasks run)", () => {
    const deps = explodingDeps();
    resolveBootTasks({}, deps);
    resolveBootTasks({ [RUNTIME_MODE_ENV]: "temporal" }, deps);
    resolveBootTasks({ [RUNTIME_MODE_ENV]: "postgres" }, deps);
    resolveBootTasks({ [RUNTIME_MODE_ENV]: "shadow" }, deps);
    expect(deps.runWorker).not.toHaveBeenCalled();
    expect(deps.runOutboxDispatcherWorker).not.toHaveBeenCalled();
    expect(deps.runBackgroundRunner).not.toHaveBeenCalled();
  });

  it("garbage mode value REFUSES boot (fail-loud; a typo'd cutover mode must crash, not default)", () => {
    expect(() => resolveBootTasks({ [RUNTIME_MODE_ENV]: "yes" }, explodingDeps())).toThrow(
      /temporal\|postgres\|shadow/,
    );
  });

  it("the OLD boolean spelling (CODEMASTER_RUN_BACKGROUND_RUNNER=true alone) REFUSES boot — never a silent temporal-only boot, never the old joined boot", () => {
    expect(() =>
      resolveBootTasks({ [DEPRECATED_RUN_BACKGROUND_RUNNER_ENV]: "true" }, explodingDeps()),
    ).toThrow(new RegExp(RUNTIME_MODE_ENV));
    expect(() =>
      resolveBootTasks({ [DEPRECATED_OUTBOX_USE_BACKGROUND_JOBS_ENV]: "true" }, explodingDeps()),
    ).toThrow(new RegExp(RUNTIME_MODE_ENV));
  });
});
