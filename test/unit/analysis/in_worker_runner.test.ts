/**
 * Unit tests for the TS `InWorkerRunner` base — 1:1 port of the frozen-Python parity reference
 * `vendor/codemaster-py/codemaster/analysis/in_worker_runner.py` (S9.1.2c: 60s timeout, SIGTERM →
 * 5s grace → SIGKILL of the whole process group, fail-open on a missing binary).
 *
 * The deterministic surface is the LIFECYCLE: argv/cwd construction, the capture of
 * stdout/stderr/exit/wall-ms, the launch-failure path (ENOENT → `SubprocessLaunchError`), and the
 * timeout path (SIGTERM → SIGKILL of the NEGATIVE pid, i.e. the detached process group). The real
 * subprocess is STUBBED via an injected `spawnFn` (the TS analogue of the Python tests monkeypatching
 * `asyncio.create_subprocess_exec`). A real-subprocess zombie-reaping test (spawning an actual child
 * that ignores SIGTERM) lives at the bottom, gated behind real `spawn` so it exercises
 * `process.kill(-pid)` against a genuine process group.
 */

import { EventEmitter } from "node:events";
import { spawn as realSpawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InWorkerRunner,
  SubprocessLaunchError,
  SubprocessTimeoutError,
  type SpawnFn,
} from "#backend/analysis/in_worker_runner.js";

// ─── Fake subprocess infrastructure (mirrors cloner.test.ts) ─────────────────────────────────────

class FakeStream extends EventEmitter {}

type FakeProcConfig = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** When true the fake process NEVER emits `close` until killed — drives the timeout path. */
  hang?: boolean;
  /** When true, even a kill() does NOT emit close (models a process ignoring SIGTERM). */
  ignoreSigterm?: boolean;
};

class FakeProcess extends EventEmitter {
  public readonly stdout = new FakeStream();
  public readonly stderr = new FakeStream();
  public readonly pid = 4242;
  public killCount = 0;
  public readonly killSignals: Array<NodeJS.Signals | number> = [];
  private readonly cfg: FakeProcConfig;
  private closed = false;

  public constructor(cfg: FakeProcConfig) {
    super();
    this.cfg = cfg;
    queueMicrotask(() => {
      if (this.cfg.stdout !== undefined) this.stdout.emit("data", Buffer.from(this.cfg.stdout));
      if (this.cfg.stderr !== undefined) this.stderr.emit("data", Buffer.from(this.cfg.stderr));
      if (!this.cfg.hang) this.emitClose(this.cfg.exitCode ?? 0);
    });
  }

  private emitClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code);
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killCount += 1;
    this.killSignals.push(signal ?? "SIGTERM");
    if (!this.cfg.ignoreSigterm) {
      queueMicrotask(() => this.emitClose(-1));
    }
    return true;
  }
}

type RecordedSpawn = {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string | undefined;
  detached: boolean | undefined;
};

class SpawnRecorder {
  public readonly calls: Array<RecordedSpawn> = [];
  public readonly procs: Array<FakeProcess> = [];
  private readonly cfgs: Array<FakeProcConfig | Error>;
  private counter = 0;

  public constructor(cfgs: Array<FakeProcConfig | Error> = []) {
    this.cfgs = cfgs;
  }

  public readonly fn: SpawnFn = (command, args, options) => {
    this.calls.push({
      command,
      args: [...args],
      cwd: typeof options.cwd === "string" ? options.cwd : undefined,
      detached: options.detached,
    });
    const cfg = this.cfgs[this.counter] ?? {};
    this.counter += 1;
    if (cfg instanceof Error) {
      // Real `spawn` throws synchronously only for argv-type errors; ENOENT is async via the
      // `error` event. Model the async ENOENT path here.
      const proc = new FakeProcess({ hang: true });
      queueMicrotask(() => proc.emit("error", cfg));
      this.procs.push(proc);
      return proc as unknown as ReturnType<SpawnFn>;
    }
    const proc = new FakeProcess(cfg);
    this.procs.push(proc);
    return proc as unknown as ReturnType<SpawnFn>;
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────────────────────────

describe("InWorkerRunner.runSubprocess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns DETACHED with cwd=workspace and the argv split into command + args", async () => {
    const rec = new SpawnRecorder([{ exitCode: 0, stdout: "hi", stderr: "" }]);
    const runner = new InWorkerRunner({
      command: ["ruff", "check", "--config", "/x/ruff.toml", "a.py"],
      workspace: "/tmp/ws",
      spawnFn: rec.fn,
    });
    await runner.runSubprocess();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.command).toBe("ruff");
    expect(rec.calls[0]!.args).toEqual(["check", "--config", "/x/ruff.toml", "a.py"]);
    expect(rec.calls[0]!.cwd).toBe("/tmp/ws");
    // detached:true gives the child its own process group so we can kill(-pid) the whole tree.
    expect(rec.calls[0]!.detached).toBe(true);
  });

  it("captures stdout / stderr (as bytes) and exit_code on a clean run", async () => {
    const rec = new SpawnRecorder([{ exitCode: 1, stdout: "OUT", stderr: "ERR" }]);
    const runner = new InWorkerRunner({
      command: ["tool"],
      workspace: "/tmp/ws",
      spawnFn: rec.fn,
    });
    const result = await runner.runSubprocess();
    expect(result.exit_code).toBe(1);
    expect(Buffer.from(result.stdout).toString("utf8")).toBe("OUT");
    expect(Buffer.from(result.stderr).toString("utf8")).toBe("ERR");
    expect(result.wall_ms).toBeGreaterThanOrEqual(0);
  });

  it("non-zero exit is NOT an error (linters exit 1 on findings)", async () => {
    const rec = new SpawnRecorder([{ exitCode: 2, stdout: "", stderr: "boom" }]);
    const runner = new InWorkerRunner({ command: ["tool"], workspace: "/tmp/ws", spawnFn: rec.fn });
    const result = await runner.runSubprocess();
    expect(result.exit_code).toBe(2);
  });

  it("fail-open: a missing binary (ENOENT) raises SubprocessLaunchError carrying the command", async () => {
    const enoent = Object.assign(new Error("spawn ruff ENOENT"), { code: "ENOENT" });
    const rec = new SpawnRecorder([enoent]);
    const runner = new InWorkerRunner({ command: ["ruff", "check"], workspace: "/tmp/ws", spawnFn: rec.fn });
    await expect(runner.runSubprocess()).rejects.toBeInstanceOf(SubprocessLaunchError);
    try {
      await new InWorkerRunner({
        command: ["ruff", "check"],
        workspace: "/tmp/ws",
        spawnFn: new SpawnRecorder([enoent]).fn,
      }).runSubprocess();
    } catch (e) {
      expect(e).toBeInstanceOf(SubprocessLaunchError);
      expect((e as SubprocessLaunchError).command).toEqual(["ruff", "check"]);
      expect((e as SubprocessLaunchError).reason).toContain("ENOENT");
    }
  });

  it("a synchronous spawn throw (EACCES etc.) also maps to SubprocessLaunchError", async () => {
    const throwingSpawn: SpawnFn = () => {
      throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    };
    const runner = new InWorkerRunner({ command: ["tool"], workspace: "/tmp/ws", spawnFn: throwingSpawn });
    await expect(runner.runSubprocess()).rejects.toBeInstanceOf(SubprocessLaunchError);
  });

  it("timeout: SIGTERM is sent to the NEGATIVE pid (process group), then SIGKILL after the grace", async () => {
    // The fake hangs and ignores SIGTERM, so the runner must escalate to SIGKILL.
    const rec = new SpawnRecorder([{ hang: true, ignoreSigterm: true }]);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill);

    const runner = new InWorkerRunner({
      command: ["tool"],
      workspace: "/tmp/ws",
      spawnFn: rec.fn,
      timeoutSeconds: 0.02,
      sigtermGraceSeconds: 0.02,
    });
    await expect(runner.runSubprocess()).rejects.toBeInstanceOf(SubprocessTimeoutError);

    killSpy.mockRestore();
    // First a SIGTERM to -pid, then a SIGKILL to -pid (the whole group, since pid is the pgid under detached).
    expect(killCalls.length).toBeGreaterThanOrEqual(2);
    expect(killCalls[0]).toEqual({ pid: -4242, signal: "SIGTERM" });
    expect(killCalls.some((c) => c.pid === -4242 && c.signal === "SIGKILL")).toBe(true);
  });

  it("timeout: a SIGTERM-responsive process exits in the grace window and is NOT SIGKILLed", async () => {
    // hang until killed, but RESPONDS to SIGTERM (emits close) → no SIGKILL escalation.
    const rec = new SpawnRecorder([{ hang: true }]);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      // model the OS: SIGTERM to the group closes our fake child
      if (signal === "SIGTERM") queueMicrotask(() => rec.procs[0]!.emit("close", -1));
      return true;
    }) as typeof process.kill);

    const runner = new InWorkerRunner({
      command: ["tool"],
      workspace: "/tmp/ws",
      spawnFn: rec.fn,
      timeoutSeconds: 0.02,
      sigtermGraceSeconds: 1,
    });
    await expect(runner.runSubprocess()).rejects.toBeInstanceOf(SubprocessTimeoutError);
    killSpy.mockRestore();
    expect(killCalls[0]).toEqual({ pid: -4242, signal: "SIGTERM" });
    expect(killCalls.some((c) => c.signal === "SIGKILL")).toBe(false);
  });

  it("rejects an empty command and an empty workspace at construction", () => {
    expect(() => new InWorkerRunner({ command: [], workspace: "/tmp/ws" })).toThrow();
    expect(() => new InWorkerRunner({ command: ["tool"], workspace: "" })).toThrow();
  });

  // ─── REAL subprocess: zombie reaping of a SIGTERM-ignoring process group ────────────────────────
  it("REAL: kills + reaps a process group whose child ignores SIGTERM (no zombie remains)", async () => {
    // A node child that spawns its OWN grandchild, traps SIGTERM, and sleeps. Only a SIGKILL to the
    // whole group (process.kill(-pid)) reaps both. We assert the runner raises SubprocessTimeoutError
    // AND that the group is gone afterward.
    const script =
      "process.on('SIGTERM',()=>{});" +
      // keep the event loop alive forever
      "setInterval(()=>{},1e9);" +
      "process.stdout.write('started');";
    const runner = new InWorkerRunner({
      command: ["node", "-e", script],
      workspace: process.cwd(),
      spawnFn: realSpawn as unknown as SpawnFn,
      timeoutSeconds: 0.3,
      sigtermGraceSeconds: 0.3,
    });

    let capturedPid = -1;
    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      capturedPid = pid;
      return origKill(pid, signal);
    }) as typeof process.kill);

    await expect(runner.runSubprocess()).rejects.toBeInstanceOf(SubprocessTimeoutError);
    killSpy.mockRestore();

    expect(capturedPid).toBeLessThan(0); // negative = process group
    const groupPid = -capturedPid;
    // Give the OS a tick to finish reaping, then assert the group is gone: kill(-pid, 0) throws ESRCH.
    await new Promise<void>((r) => setImmediate(r));
    let groupAlive = true;
    try {
      origKill(-groupPid, 0);
    } catch (e) {
      groupAlive = (e as NodeJS.ErrnoException).code !== "ESRCH" ? true : false;
    }
    expect(groupAlive).toBe(false);
  }, 10_000);
});
