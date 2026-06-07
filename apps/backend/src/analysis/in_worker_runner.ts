/**
 * InWorkerRunner — 1:1 port of `vendor/codemaster-py/codemaster/analysis/in_worker_runner.py`
 * (Sprint 9 / S9.1.2a+b+c).
 *
 * Base class for subprocess-driven static-analysis runners that live inside the worker pod (ESLint,
 * Ruff, Gitleaks). Runs a CLI tool with `cwd=workspace`, captures stdout / stderr / exit-code /
 * wall-ms, and enforces a wall-clock timeout with a SIGTERM-then-SIGKILL grace that reaps the WHOLE
 * process group (so a misbehaving tool that forks descendants can't outlive the budget).
 *
 * Process-group reaping in Node
 * -----------------------------
 * Python uses `os.setsid()` in a `preexec_fn` + `os.killpg(pid, sig)`. Node's `spawn` exposes
 * `detached: true`, which calls `setsid()` for us → the child becomes the leader of a new process
 * group whose PGID equals its PID. There is no `os.killpg` in Node; the POSIX idiom is
 * `process.kill(-pid, signal)` — a NEGATIVE pid signals the entire process group. That reaps any
 * grandchildren the tool spawned, matching the Python `killpg` semantics exactly.
 *
 * The Python seccomp + prlimit + capability-drop `preexec_fn` hardening (S9.1.2b) is pod/OS-level
 * sandboxing that has no Node analogue and is owner-provided worker-image infra (NetworkPolicy +
 * the OpenShift securityContext); it is intentionally NOT reproduced here. The behavioral contract
 * the orchestrator depends on — timeout, kill-the-group, fail-open-on-missing-binary — IS reproduced.
 *
 * Determinism / seams
 * -------------------
 *   - {@link SpawnFn}: the subprocess factory (default `node:child_process.spawn`). Tests inject a
 *     recorder, mirroring the Python tests monkeypatching `asyncio.create_subprocess_exec`.
 *   - Timeout + grace timers are armed via the transport-timeout seam
 *     (`#platform/transport_timeout.ts::transportAbortSignal`) — NOT raw `setTimeout` /
 *     `AbortSignal.timeout`, which the `check_clock_random` gate bans outside the seam. Identical to
 *     `apps/backend/src/integrations/git/cloner.ts`.
 *
 * Runtime context: activities run in the NORMAL Node runtime, NOT the workflow V8-isolate sandbox —
 * `child_process` is permitted here (it would be forbidden in the workflow body).
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

import { type Clock, WallClock } from "#platform/clock.js";
import { transportAbortSignal } from "#platform/transport_timeout.js";

/** Default wall-clock budget for one tool invocation (S9.1.2c). */
const DEFAULT_TIMEOUT_SECONDS = 60;

/** Grace between SIGTERM and SIGKILL — long enough for a clean flush + exit, short enough that a
 *  misbehaving tool doesn't keep the worker pinned past the budget (mirrors `_SIGTERM_GRACE_SECONDS`). */
const DEFAULT_SIGTERM_GRACE_SECONDS = 5;

/**
 * The subprocess factory seam. Mirrors `node:child_process.spawn`'s shape so the default impl is
 * `spawn` itself; tests inject a recorder. The returned object needs only the surface this base
 * touches: `pid`, the `stdout`/`stderr` streams, the `error` + `close` events, and `kill`.
 */
export type SpawnFn = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess;

/** Captured outcome of one subprocess invocation. 1:1 with the Python `SubprocessResultV1`. */
export type SubprocessResultV1 = {
  readonly exit_code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly wall_ms: number;
};

/**
 * Raised when the subprocess binary is missing on `$PATH` (ENOENT) or otherwise unspawnable — any
 * launch failure that is NOT the binary's own exit behaviour. The orchestrator translates this to a
 * `failed_startup` {@link import("#contracts/tool_status.v1.js").ToolStatusV1}. 1:1 with the Python
 * `SubprocessLaunchError`.
 */
export class SubprocessLaunchError extends Error {
  public readonly command: ReadonlyArray<string>;
  public readonly reason: string;

  public constructor({ command, reason }: { command: ReadonlyArray<string>; reason: string }) {
    super(`failed to launch ${formatCommand(command)}: ${reason}`);
    this.name = "SubprocessLaunchError";
    this.command = [...command];
    this.reason = reason;
  }
}

/**
 * Raised when the subprocess exceeds the timeout. By the time this fires the runner has SIGKILLed
 * the entire process group, so no orphaned children remain. Carries the elapsed wall-ms. The
 * orchestrator translates this to a `failed_runtime` (or `timed_out`) status. 1:1 with the Python
 * `SubprocessTimeoutError`.
 */
export class SubprocessTimeoutError extends Error {
  public readonly command: ReadonlyArray<string>;
  public readonly wall_ms: number;

  public constructor({ command, wallMs }: { command: ReadonlyArray<string>; wallMs: number }) {
    super(`subprocess ${formatCommand(command)} exceeded timeout (wall_ms=${wallMs})`);
    this.name = "SubprocessTimeoutError";
    this.command = [...command];
    this.wall_ms = wallMs;
  }
}

/** `repr`-style quoting so the error message mirrors Python's `{command!r}` (tuple of strings). */
function formatCommand(command: ReadonlyArray<string>): string {
  return `(${command.map((c) => `'${c}'`).join(", ")})`;
}

type InWorkerRunnerOptions = {
  readonly command: ReadonlyArray<string>;
  readonly workspace: string;
  readonly timeoutSeconds?: number;
  readonly sigtermGraceSeconds?: number;
  /** Injected for tests; defaults to `node:child_process.spawn`. */
  readonly spawnFn?: SpawnFn;
  /** Clock seam for the wall-ms measurement (`time.perf_counter()` analogue). Defaults to WallClock. */
  readonly clock?: Clock;
  /**
   * External cancellation signal (the orchestrator's soft-barrier deadline). When it fires, the
   * runner tears down the subprocess group exactly as on its own timeout and raises
   * {@link SubprocessTimeoutError}. Independent of the per-tool `timeoutSeconds` safety guard.
   */
  readonly signal?: AbortSignal;
};

/**
 * Run a CLI tool as a subprocess inside the worker pod.
 *
 * A non-zero exit code is NOT an error here — many linters exit 1 when they find issues. Specialised
 * runners decide what to do with the exit code in their own `_parseOutput`.
 */
export class InWorkerRunner {
  private readonly command: ReadonlyArray<string>;
  private readonly workspace: string;
  private readonly timeoutSeconds: number;
  private readonly sigtermGraceSeconds: number;
  private readonly spawnFn: SpawnFn;
  private readonly clock: Clock;
  private readonly signal: AbortSignal | undefined;

  public constructor({
    command,
    workspace,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    sigtermGraceSeconds = DEFAULT_SIGTERM_GRACE_SECONDS,
    spawnFn = nodeSpawn,
    clock = new WallClock(),
    signal,
  }: InWorkerRunnerOptions) {
    if (command.length === 0) throw new Error("command must be non-empty");
    if (!workspace) throw new Error("workspace path must be set");
    this.command = [...command];
    this.workspace = workspace;
    this.timeoutSeconds = timeoutSeconds;
    this.sigtermGraceSeconds = sigtermGraceSeconds;
    this.spawnFn = spawnFn;
    this.clock = clock;
    this.signal = signal;
  }

  /**
   * Spawn the subprocess; capture stdout / stderr / exit / wall-ms.
   *
   * On timeout the runner sends SIGTERM to the child's process group (`-pid`), waits up to the grace
   * window, then SIGKILLs the group to reap any descendants. {@link SubprocessTimeoutError} is raised
   * AFTER cleanup completes — by the time it fires, no process from the spawn remains. A missing
   * binary (ENOENT) or any other launch failure raises {@link SubprocessLaunchError}.
   */
  public async runSubprocess(): Promise<SubprocessResultV1> {
    // perf_counter() analogue: monotonic SECONDS from the clock seam (×1000 for ms). Observability-
    // only; never parity-checked by value.
    const startedSeconds = this.clock.monotonic();

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(this.command[0]!, this.command.slice(1), {
        cwd: this.workspace,
        // detached:true → the child leads a new process group (PGID == PID); we kill(-pid) the group.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // Synchronous spawn failures (e.g. EACCES on some platforms) surface here.
      throw new SubprocessLaunchError({ command: this.command, reason: errorReason(e) });
    }

    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];
    proc.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    // The `error` event fires for async spawn failures — ENOENT (missing binary) being the one that
    // matters most for fail-open. We surface it as a rejected `launchError` racing against `closed`.
    let launchError: Error | undefined;
    const launchFailed = new Promise<"error">((resolve) => {
      proc.once("error", (err: Error) => {
        launchError = err;
        resolve("error");
      });
    });

    const closed = new Promise<number>((resolve) => {
      // `close` fires after stdio flush + exit; code is the exit code, or null when killed by signal.
      proc.once("close", (code) => resolve(code ?? -1));
    });

    const timedOut = abortAfter(this.timeoutSeconds);
    const externalAbort = onAbort(this.signal);

    const winner = await Promise.race([
      closed.then(() => "closed" as const),
      launchFailed.then(() => "launch" as const),
      timedOut.then(() => "timeout" as const),
      externalAbort.then(() => "timeout" as const),
    ]);

    if (winner === "launch") {
      throw new SubprocessLaunchError({ command: this.command, reason: errorReason(launchError) });
    }

    if (winner === "timeout") {
      await this.killProcessGroup(proc, closed);
      const wallMs = Math.round((this.clock.monotonic() - startedSeconds) * 1000);
      throw new SubprocessTimeoutError({ command: this.command, wallMs });
    }

    const exitCode = await closed;
    const wallMs = Math.round((this.clock.monotonic() - startedSeconds) * 1000);
    return {
      exit_code: exitCode,
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      wall_ms: wallMs,
    };
  }

  /**
   * SIGTERM the child's process group, wait up to the grace window, then SIGKILL anything still
   * alive. Relies on `detached: true` having given the child its own process group (PGID == PID), so
   * `process.kill(-pid, sig)` signals the whole group — the Node analogue of Python's `os.killpg`.
   */
  private async killProcessGroup(proc: ChildProcess, closed: Promise<number>): Promise<void> {
    const pid = proc.pid;
    if (pid === undefined) return; // never spawned cleanly; nothing to reap.

    // SIGTERM the group. Swallow ESRCH (already dead) — mirrors Python's `except ProcessLookupError`.
    if (!signalGroup(pid, "SIGTERM")) return;

    const exitedAfterTerm = await Promise.race([
      closed.then(() => true),
      abortAfter(this.sigtermGraceSeconds).then(() => false),
    ]);
    if (exitedAfterTerm) return;

    // Still alive after the grace → SIGKILL the whole group, then wait for the final reap.
    signalGroup(pid, "SIGKILL");
    await Promise.race([
      closed.then(() => true),
      abortAfter(this.sigtermGraceSeconds).then(() => false),
    ]);
    // If it's STILL stuck the OS reaper will clean up; we proceed to raise.
  }
}

/**
 * Signal an entire process group (`-pid`). Returns false (and swallows) when the group is already
 * gone (ESRCH) — the Node analogue of Python's `except ProcessLookupError: return`.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Any other error (EPERM etc.) — best-effort; do not let cleanup mask the timeout outcome.
    return false;
  }
}

/** Extract a stable reason string from an unknown thrown value (mirrors Python `str(e)`). */
function errorReason(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Resolve after `seconds`, driven by the transport-timeout seam's `AbortSignal`. The seam owns the
 * underlying timer (the gate allow-lists `AbortSignal.timeout` only inside it); here we just observe
 * the signal firing — listening to a signal, not creating a timer, keeps this file gate-clean.
 * Identical to `cloner.ts::abortAfter`.
 */
function abortAfter(seconds: number): Promise<void> {
  const signal = transportAbortSignal(seconds * 1000);
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Resolve when an EXTERNAL signal aborts; a never-settling promise when there is no signal (so it
 *  loses every `Promise.race` it joins). The orchestrator's soft-barrier deadline drives this. */
function onAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise<void>(() => {});
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
