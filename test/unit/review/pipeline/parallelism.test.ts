// Unit-test matrix for fanOutReview + coerceChunkResult — the 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/review/parallelism.py.
//
// Load-bearing semantics under test:
//   * ORDERING DETERMINISM — findings/intents are emitted in chunk-INPUT order, NOT completion order.
//     The stub resolves dispatches in a scrambled order (last chunk first) yet the output preserves
//     input order. This is the Temporal replay-determinism guarantee (slot-indexed fan-in).
//   * PER-CHUNK THREADING — the typed ChunkThreadingV1 payload (tier1Findings / toolStatuses /
//     prTopologyManifest) is forwarded into EVERY dispatch (gate-collapse: always-passed, no
//     `_callable_accepts_kwarg` opt-in branch).
//   * ENVELOPE COERCE — coerceChunkResult projects the ReviewChunkResponseV1 envelope to
//     [findings, intents] (the `bedrock-review-chunk-envelope` collapse-on path; the legacy tuple
//     branch is not ported).
//   * CONCURRENCY BOUND — at most `concurrency` dispatches are in-flight at once (the Python
//     anyio.Semaphore(concurrency) cap); default is CHUNK_CONCURRENCY_DEFAULT = 4.
//   * SHORT-CIRCUITS — empty chunks → ([], []); concurrency <= 0 → throws.
//   * ERROR PROPAGATION — the first dispatch rejection propagates out of fanOutReview.
import { describe, it, expect } from "vitest";

import {
  fanOutReview,
  coerceChunkResult,
  CHUNK_CONCURRENCY_DEFAULT,
  type ChunkThreadingV1,
  type InvokeChunkFn,
} from "#backend/review/pipeline/parallelism.js";
import { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures — built through the Zod schemas so contract defaults / validators apply.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

/** A deterministic v4-shaped uuid keyed by a small integer (stable across runs, sandbox-safe). */
function uuidFor(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function chunk(idx: number): DiffChunkV1 {
  return DiffChunkV1.parse({
    chunk_id: uuidFor(idx),
    path: `src/file_${idx}.ts`,
    start_line: 1,
    end_line: 10,
    body: `// chunk ${idx}`,
    chunk_kind: "hunk",
    token_estimate: 5,
  });
}

/** A finding whose title encodes its origin chunk index — lets us assert input-order fan-in. */
function finding(idx: number): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: `src/file_${idx}.ts`,
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: `finding-from-chunk-${idx}`,
    body: `body ${idx}`,
    confidence: 0.9,
  });
}

function intent(idx: number): ArbitrationIntentV1 {
  return ArbitrationIntentV1.parse({
    target_finding_id: uuidFor(idx),
    confidence: "0.9",
    reason: `intent-from-chunk-${idx}`,
  });
}

function envelope(idx: number, opts: { withIntent?: boolean } = {}): ReviewChunkResponseV1 {
  return ReviewChunkResponseV1.parse({
    findings: [finding(idx)],
    arbitration_intents: opts.withIntent ? [intent(idx)] : [],
  });
}

const EMPTY_THREADING: ChunkThreadingV1 = {
  tier1Findings: [],
  toolStatuses: [],
  prTopologyManifest: [],
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("coerceChunkResult — envelope → [findings, intents] (parallelism.py:51)", () => {
  it("projects the envelope's findings + arbitration_intents", () => {
    const env = envelope(7, { withIntent: true });
    const [findings, intents] = coerceChunkResult(env);
    expect(findings).toBe(env.findings);
    expect(intents).toBe(env.arbitration_intents);
    expect(findings[0]!.title).toBe("finding-from-chunk-7");
    expect(intents[0]!.reason).toBe("intent-from-chunk-7");
  });

  it("empty arbitration_intents project to an empty array", () => {
    const [, intents] = coerceChunkResult(envelope(0));
    expect(intents).toEqual([]);
  });
});

describe("fanOutReview — short-circuits + guards (parallelism.py:117-120)", () => {
  it("returns ([], []) for zero chunks without invoking", async () => {
    let calls = 0;
    const invoke: InvokeChunkFn = async () => {
      calls += 1;
      return envelope(0);
    };
    const [findings, intents] = await fanOutReview([], invoke);
    expect(findings).toEqual([]);
    expect(intents).toEqual([]);
    expect(calls).toBe(0);
  });

  it("throws when concurrency <= 0", async () => {
    const invoke: InvokeChunkFn = async () => envelope(0);
    await expect(fanOutReview([chunk(0)], invoke, { concurrency: 0 })).rejects.toThrow(
      "concurrency must be positive",
    );
    await expect(fanOutReview([chunk(0)], invoke, { concurrency: -1 })).rejects.toThrow(
      "concurrency must be positive",
    );
  });

  it("exposes the default concurrency constant (parallelism.py:43)", () => {
    expect(CHUNK_CONCURRENCY_DEFAULT).toBe(4);
  });
});

describe("fanOutReview — ordering determinism (input order, NOT completion order)", () => {
  it("emits findings in chunk-input order even when dispatches resolve in reverse", async () => {
    const n = 5;
    const chunks = Array.from({ length: n }, (_, i) => chunk(i));

    // Controllable deferreds keyed by chunk path-index. We DELAY resolution so the fan-in cannot
    // possibly see completion order: chunk N resolves first, chunk 0 resolves last.
    const resolvers = new Map<number, () => void>();
    const gates = new Map<number, Promise<void>>();
    for (let i = 0; i < n; i += 1) {
      gates.set(
        i,
        new Promise<void>((res) => {
          resolvers.set(i, res);
        }),
      );
    }

    const indexOf = (c: DiffChunkV1): number => Number(c.path.replace(/\D/g, ""));

    const invoke: InvokeChunkFn = async (c) => {
      const idx = indexOf(c);
      await gates.get(idx)!;
      return envelope(idx, { withIntent: true });
    };

    // Run the fan-out at full concurrency so all dispatches are in-flight, then release them in
    // REVERSE order (highest index first). The output must STILL be input-ordered.
    const promise = fanOutReview(chunks, invoke, { concurrency: n });
    for (let i = n - 1; i >= 0; i -= 1) {
      resolvers.get(i)!();
    }
    const [findings, intents] = await promise;

    expect(findings.map((f) => f.title)).toEqual([
      "finding-from-chunk-0",
      "finding-from-chunk-1",
      "finding-from-chunk-2",
      "finding-from-chunk-3",
      "finding-from-chunk-4",
    ]);
    expect(intents.map((i) => i.reason)).toEqual([
      "intent-from-chunk-0",
      "intent-from-chunk-1",
      "intent-from-chunk-2",
      "intent-from-chunk-3",
      "intent-from-chunk-4",
    ]);
  });

  it("flattens multi-finding chunks in slot order", async () => {
    const chunks = [chunk(0), chunk(1)];
    const invoke: InvokeChunkFn = async (c) => {
      const idx = Number(c.path.replace(/\D/g, ""));
      if (idx === 0) {
        return ReviewChunkResponseV1.parse({ findings: [finding(0)] });
      }
      // chunk 1 emits two findings; both must follow chunk 0's finding.
      return ReviewChunkResponseV1.parse({
        findings: [
          ReviewFindingV1.parse({ ...finding(1), title: "finding-from-chunk-1a" }),
          ReviewFindingV1.parse({ ...finding(1), title: "finding-from-chunk-1b" }),
        ],
      });
    };
    const [findings] = await fanOutReview(chunks, invoke, { concurrency: 2 });
    expect(findings.map((f) => f.title)).toEqual([
      "finding-from-chunk-0",
      "finding-from-chunk-1a",
      "finding-from-chunk-1b",
    ]);
  });
});

describe("fanOutReview — per-chunk threading (always-forwarded, gate-collapsed)", () => {
  it("forwards the typed ChunkThreadingV1 payload into every dispatch", async () => {
    const tier1 = [
      AnalysisFindingV1.parse({
        finding_id: ZERO_UUID,
        tool: "ruff",
        rule_id: "E501",
        file: "src/file_0.ts",
        start_line: 3,
        end_line: 3,
        severity_raw: "warning",
        message: "line too long",
      }),
    ];
    const statuses = [
      ToolStatusV1.parse({
        tool_name: "ruff",
        status: "completed",
        files_scanned: 1,
        files_total: 1,
        started_at: "2026-06-05T00:00:00+00:00",
        finished_at: "2026-06-05T00:00:01+00:00",
        duration_ms: 1000,
      }),
    ];
    const manifest = [
      PRTopologyEntryV1.parse({
        chunk_id: uuidFor(0),
        path: "src/file_0.ts",
        start_line: 1,
        end_line: 10,
        kind: "code",
      }),
    ];
    const threading: ChunkThreadingV1 = {
      tier1Findings: tier1,
      toolStatuses: statuses,
      prTopologyManifest: manifest,
    };

    const seen: Array<ChunkThreadingV1> = [];
    const chunks = [chunk(0), chunk(1), chunk(2)];
    const invoke: InvokeChunkFn = async (c, t) => {
      seen.push(t);
      return envelope(Number(c.path.replace(/\D/g, "")));
    };

    await fanOutReview(chunks, invoke, { threading });

    expect(seen).toHaveLength(3);
    for (const t of seen) {
      expect(t).toBe(threading); // same payload object threaded into every chunk
      expect(t.tier1Findings[0]!.rule_id).toBe("E501");
      expect(t.toolStatuses[0]!.tool_name).toBe("ruff");
      expect(t.prTopologyManifest[0]!.path).toBe("src/file_0.ts");
    }
  });

  it("defaults to empty threading when none is supplied", async () => {
    const seen: Array<ChunkThreadingV1> = [];
    const invoke: InvokeChunkFn = async (c, t) => {
      seen.push(t);
      return envelope(Number(c.path.replace(/\D/g, "")));
    };
    await fanOutReview([chunk(0)], invoke);
    expect(seen[0]).toEqual(EMPTY_THREADING);
  });
});

describe("fanOutReview — concurrency bound (anyio.Semaphore parity)", () => {
  it("never exceeds `concurrency` in-flight dispatches", async () => {
    const n = 10;
    const limit = 3;
    const chunks = Array.from({ length: n }, (_, i) => chunk(i));

    let inFlight = 0;
    let peak = 0;
    // A barrier each dispatch awaits, released a fixed micro-step later, so several dispatches
    // overlap and the peak in-flight count is observable. No timers (sandbox-safe in the prod
    // module; the test merely awaits resolved promises to yield the event loop).
    const invoke: InvokeChunkFn = async (c) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield a few microtasks so peers can enter before this one resolves.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return envelope(Number(c.path.replace(/\D/g, "")));
    };

    const [findings] = await fanOutReview(chunks, invoke, { concurrency: limit });
    expect(findings).toHaveLength(n);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBeGreaterThan(1); // sanity: there WAS real overlap
  });

  it("caps the pool at chunk count when concurrency exceeds it", async () => {
    let peak = 0;
    let inFlight = 0;
    const invoke: InvokeChunkFn = async (c) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return envelope(Number(c.path.replace(/\D/g, "")));
    };
    await fanOutReview([chunk(0), chunk(1)], invoke, { concurrency: 99 });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("fanOutReview — error propagation", () => {
  it("propagates the first dispatch rejection", async () => {
    const chunks = [chunk(0), chunk(1), chunk(2)];
    const invoke: InvokeChunkFn = async (c) => {
      const idx = Number(c.path.replace(/\D/g, ""));
      if (idx === 1) {
        throw new Error("chunk-1 dispatch failed");
      }
      return envelope(idx);
    };
    await expect(fanOutReview(chunks, invoke, { concurrency: 3 })).rejects.toThrow(
      "chunk-1 dispatch failed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FIX #11 (owner-requested HARDENING DIVERGENCE) — cancel-peers on first hard failure.
//
// Parity target: Python's `anyio.create_task_group()` CANCELS all peer tasks the instant one task
// raises. Tasks still parked at `async with semaphore` (i.e. that have not yet called `invoke`) are
// cancelled before they ever dispatch — so on a hard failure the task-group never schedules the
// not-yet-started chunks.
//
// The original TS worker-pool had NO such cancellation: `Promise.all` rejects on the first worker
// throwing, but the OTHER in-flight workers keep pulling the shared cursor and dispatching `invoke`
// for later chunks (wasted LLM spend + larger Temporal history). This suite pins the corrected
// contract: once any worker observes a rejection, NO worker dispatches a chunk pulled AFTER that
// point — while preserving first-error-propagation and success-path ordering.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("fanOutReview — cancel-peers on first hard failure (anyio task-group parity)", () => {
  it("stops dispatching new chunks once a rejection is observed (fewer than n invoke calls)", async () => {
    // 5 chunks, concurrency 2. Chunk index 1 rejects. With the cursor model, the two initial
    // workers pull idx 0 and idx 1. We park idx 0 on a gate so its worker stays in-flight, let
    // idx 1 reject, then release idx 0. The abort flag must stop BOTH workers from pulling idx 2/3/4.
    const n = 5;
    const chunks = Array.from({ length: n }, (_, i) => chunk(i));

    const dispatched: Array<number> = [];
    let releaseChunk0!: () => void;
    const chunk0Gate = new Promise<void>((res) => {
      releaseChunk0 = res;
    });

    const invoke: InvokeChunkFn = async (c) => {
      const idx = Number(c.path.replace(/\D/g, ""));
      dispatched.push(idx);
      if (idx === 0) {
        // Park the first worker so it is genuinely in-flight when the peer rejects.
        await chunk0Gate;
        return envelope(0);
      }
      if (idx === 1) {
        // Reject synchronously-ish on the second worker → sets the shared abort flag.
        throw new Error("chunk-1 dispatch failed");
      }
      return envelope(idx);
    };

    const promise = fanOutReview(chunks, invoke, { concurrency: 2 });
    // Yield so chunk 1's rejection is observed (abort flag set) before we release chunk 0. Then
    // chunk 0's worker, on its next loop turn, must SEE the abort flag and NOT pull idx 2/3/4.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    releaseChunk0();

    await expect(promise).rejects.toThrow("chunk-1 dispatch failed");

    // The core fix assertion: peers stopped scheduling. Without cancel-peers, all 5 chunks would
    // have been pulled+dispatched (or 4 of them — every index except the rejected one's successors
    // up to the cursor). With it, only the chunks pulled BEFORE the abort flag was set ran.
    expect(dispatched.length).toBeLessThan(n);
    // idx 2/3/4 must never have been dispatched after the failure was observed.
    expect(dispatched).not.toContain(3);
    expect(dispatched).not.toContain(4);
  });

  it("propagates the FIRST rejection even when a later peer would also reject", async () => {
    // Two failing chunks; the first one observed must be the propagated error.
    const n = 4;
    const chunks = Array.from({ length: n }, (_, i) => chunk(i));
    const invoke: InvokeChunkFn = async (c) => {
      const idx = Number(c.path.replace(/\D/g, ""));
      if (idx === 1) {
        throw new Error("first-failure");
      }
      if (idx === 3) {
        throw new Error("second-failure");
      }
      return envelope(idx);
    };
    await expect(fanOutReview(chunks, invoke, { concurrency: 2 })).rejects.toThrow("first-failure");
  });

  it("does NOT alter the success path — full dispatch + input-ordered fan-in (control)", async () => {
    // Cancel-peers must be inert when nothing fails: all chunks dispatch and ordering is preserved.
    const n = 5;
    const chunks = Array.from({ length: n }, (_, i) => chunk(i));
    const dispatched: Array<number> = [];
    const invoke: InvokeChunkFn = async (c) => {
      const idx = Number(c.path.replace(/\D/g, ""));
      dispatched.push(idx);
      // Yield to interleave workers — output ordering must still be input order.
      await Promise.resolve();
      await Promise.resolve();
      return envelope(idx, { withIntent: true });
    };
    const [findings, intents] = await fanOutReview(chunks, invoke, { concurrency: 2 });
    expect(dispatched).toHaveLength(n); // every chunk dispatched on the success path
    expect(findings.map((f) => f.title)).toEqual([
      "finding-from-chunk-0",
      "finding-from-chunk-1",
      "finding-from-chunk-2",
      "finding-from-chunk-3",
      "finding-from-chunk-4",
    ]);
    expect(intents.map((i) => i.reason)).toEqual([
      "intent-from-chunk-0",
      "intent-from-chunk-1",
      "intent-from-chunk-2",
      "intent-from-chunk-3",
      "intent-from-chunk-4",
    ]);
  });
});
