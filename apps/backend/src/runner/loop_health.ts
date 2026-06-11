import type { Clock } from "#platform/clock.js";

// CS3.1 (cutover-safety plan, finding CS3 — audit C5/H7/XH11/RT2): the QUERYABLE loop-liveness
// registry the supervised runtime loops feed (background_runner_main.ts::runSupervisedLoops).
//
// Pre-CS3.1 a crashed loop's ONLY trace was the codemaster_runner_loop_crashed_total counter +
// an ERROR log. The counter is emitted through the fail-safe Meter seam — a NO-OP Meter when no
// MeterProvider is wired — and /readyz is hardcoded ready, so a pod whose runner / scheduler /
// outbox / review loop had died kept reporting ready FOREVER: the degradation was invisible to
// the platform and self-healing structurally could not trigger. This registry makes "a required
// loop is dead" an in-process, queryable fact: the composition root registers every supervised
// loop BEFORE start (initially "up"), the supervisor's crash boundary marks the crashed loop
// down (in ADDITION to the existing metric + log — never instead of), and the readiness consumer
// (CS3.2: api/dependency_checks.ts::makeRuntimeLoopsCheck, the 'runtime-loops' /readyz dependency
// over main.ts's SHARED registry) asks {@link LoopHealthRegistry.allRequiredUp}.
//
// Design notes:
//   * REQUIRED-ness is DECLARED by register(), never assumed — shadow mode omits the review loop
//     from the composition entirely (CS2.1), so it is simply never registered and never required.
//   * A GRACEFULLY-STOPPED loop stays "up": stop() is the process-exit path (SIGINT/SIGTERM), not
//     a degradation — readiness of a terminating pod is governed by the pod lifecycle.
//   * FAIL-LOUD wiring: duplicate register() and markDown()/markUp() on an unregistered name
//     throw — a typo'd loop name must surface as a crash at the wiring site, never silently mint
//     a health entry the readiness aggregate then keys on.
//   * Clock seam: every transition instant comes from the injected {@link Clock} (no raw
//     `new Date()` — the repo-wide clock gate), so tests pin `since` exactly with a FakeClock.

/** One loop's health: "up" since an instant, or "down" since an instant with the crash reason. */
export type LoopHealth =
  | { status: "up"; since: Date }
  | { status: "down"; reason: string; since: Date };

/** Point-in-time copy of every registered loop's health, keyed by loop name. */
export type LoopHealthSnapshot = Record<string, LoopHealth>;

/**
 * The registry of REQUIRED runtime loops and their liveness. Synchronous + in-memory: the
 * supervisor's crash boundary feeds it inline (no awaits between the catch and the mark), so any
 * observer that saw a crash's metric/log also sees the loop down.
 */
export class LoopHealthRegistry {
  private readonly clock: Clock;
  private readonly loops = new Map<string, LoopHealth>();

  public constructor(args: { clock: Clock }) {
    this.clock = args.clock;
  }

  /** Declare a REQUIRED loop, initially "up". Throws on a duplicate name — double-wiring (two
   *  supervised sets sharing one registry) must fail loud at the wiring site. */
  public register(loopName: string): void {
    if (this.loops.has(loopName)) {
      throw new Error(
        `LoopHealthRegistry: loop '${loopName}' is already registered — each supervised loop ` +
          `registers exactly once before start (a duplicate means two supervised sets are ` +
          `sharing one registry, which would let one set's crash hide behind the other's health)`,
      );
    }
    this.loops.set(loopName, { status: "up", since: this.clock.now() });
  }

  /** Mark a registered loop DOWN with the crash reason (an Error normalizes to `name: message`).
   *  A later markDown overwrites — the latest observation wins. Throws on an unregistered name. */
  public markDown(loopName: string, reason: string | Error): void {
    this.assertRegistered(loopName, "markDown");
    const normalized = reason instanceof Error ? `${reason.name}: ${reason.message}` : reason;
    this.loops.set(loopName, {
      status: "down",
      reason: normalized === "" ? "(no reason provided)" : normalized,
      since: this.clock.now(),
    });
  }

  /** Mark a registered loop UP (the recovery instant). Throws on an unregistered name. */
  public markUp(loopName: string): void {
    this.assertRegistered(loopName, "markUp");
    this.loops.set(loopName, { status: "up", since: this.clock.now() });
  }

  /** Point-in-time DEFENSIVE COPY of every registered loop's health — mutating the returned
   *  record never perturbs the registry (entries are replaced whole on transition, never
   *  mutated, so sharing the value objects is safe). */
  public snapshot(): LoopHealthSnapshot {
    return Object.fromEntries(this.loops);
  }

  /** TRUE iff every registered (= required) loop is "up". An empty registry is vacuously true —
   *  required-ness is declared by {@link register}, never assumed. */
  public allRequiredUp(): boolean {
    for (const health of this.loops.values()) {
      if (health.status === "down") {
        return false;
      }
    }
    return true;
  }

  private assertRegistered(loopName: string, op: "markDown" | "markUp"): void {
    if (!this.loops.has(loopName)) {
      throw new Error(
        `LoopHealthRegistry.${op}: loop '${loopName}' is not registered — only loops declared ` +
          `via register() participate in readiness (a typo'd name must fail loud here, never ` +
          `silently mint a health entry)`,
      );
    }
  }
}
