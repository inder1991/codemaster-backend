// Unit-test matrix for stageOutcome() — the 1:1 port of the frozen Python stage_outcome context manager
// (vendor/codemaster-py/codemaster/workflows/stage_outcome.py). Asserts the load-bearing semantics:
//   * swallow-by-default (raiseAfterLog unset → caught error is swallowed, returns undefined)
//   * raiseAfterLog re-raises AFTER logging/emitting/appending
//   * the cancellation error ALWAYS re-raises — even without raiseAfterLog (Temporal cancellation MUST
//     propagate), with NO log / NO degradation-notes append
//   * skipOutcome suppresses the success-path record_stage(ok) emit only
//   * the degradation note `<stage>_failed` (+ handle.note extras) is recorded on the error path
//   * unknown stage name raises synchronously before the body runs
import { CancelledFailure } from "@temporalio/common";
import { describe, it, expect, vi } from "vitest";

import {
  stageOutcome,
  recordStage,
  STAGE_NAMES,
  OUTCOMES,
} from "#backend/review/pipeline/degradation.js";
import { DegradationCollector } from "#backend/review/pipeline/state.js";

/** A logger spy capturing every WARN line. */
function makeLogger(): { warning: ReturnType<typeof vi.fn>; lines: Array<string> } {
  const lines: Array<string> = [];
  const warning = vi.fn((msg: string) => {
    lines.push(msg);
  });
  return { warning, lines };
}

describe("stageOutcome — swallow / re-raise matrix", () => {
  it("success path returns the body result and records outcome=ok", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    const result = await stageOutcome("clone", { logger, degradationNotes: notes }, async () => 42);
    expect(result).toBe(42);
    expect(notes).toEqual([]);
    expect(logger.warning).not.toHaveBeenCalled();
  });

  it("swallow-by-default: a caught error is swallowed (returns undefined) and notes <stage>_failed", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    const result = await stageOutcome("aggregate", { logger, degradationNotes: notes }, async () => {
      throw new Error("boom");
    });
    expect(result).toBeUndefined();
    expect(notes).toEqual(["aggregate_failed"]);
    expect(logger.warning).toHaveBeenCalledTimes(1);
    expect(logger.lines[0]).toContain("aggregate failed");
    expect(logger.lines[0]).toContain("error_class=Error");
    expect(logger.lines[0]).toContain('error_msg="boom"');
  });

  it("raiseAfterLog re-raises the caught error AFTER logging + appending the note", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    const err = new Error("fatal");
    await expect(
      stageOutcome("post_review", { logger, degradationNotes: notes, raiseAfterLog: true }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    // The note + log still happened before the re-raise.
    expect(notes).toEqual(["post_review_failed"]);
    expect(logger.warning).toHaveBeenCalledTimes(1);
  });

  it("CancelledFailure ALWAYS re-raises even without raiseAfterLog — no log, no note", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    const cancel = new CancelledFailure("cancelled");
    await expect(
      stageOutcome("review_chunk", { logger, degradationNotes: notes }, async () => {
        throw cancel;
      }),
    ).rejects.toBe(cancel);
    // Cancellation is NOT a degradation: no WARN line, no degradation-notes append.
    expect(logger.warning).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it("an AbortError (cancellation-shaped) ALWAYS re-raises even without raiseAfterLog", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(
      stageOutcome("review_chunk", { logger, degradationNotes: notes }, async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(logger.warning).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it("skipOutcome suppresses the success emit but does NOT affect the failure path", async () => {
    const logger = makeLogger();
    // success path with skipOutcome → returns result, no error
    const ok = await stageOutcome("load_repo_config", { logger }, async (handle) => {
      handle.skipOutcome();
      return "config";
    });
    expect(ok).toBe("config");

    // failure path: skipOutcome is irrelevant — the error path still logs + appends.
    const notes: Array<string> = [];
    const failed = await stageOutcome(
      "load_repo_config",
      { logger, degradationNotes: notes },
      async (handle) => {
        handle.skipOutcome();
        throw new Error("x");
      },
    );
    expect(failed).toBeUndefined();
    expect(notes).toEqual(["load_repo_config_failed"]);
  });

  it("handle.note extra notes are appended on the failure path AFTER <stage>_failed", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    await stageOutcome("embed_query", { logger, degradationNotes: notes }, async (handle) => {
      handle.note("retrieval_degraded");
      throw new Error("embed down");
    });
    expect(notes).toEqual(["embed_query_failed", "retrieval_degraded"]);
  });

  it("handle.note extra notes are appended on the SUCCESS path too", async () => {
    const logger = makeLogger();
    const notes: Array<string> = [];
    const out = await stageOutcome("walkthrough", { logger, degradationNotes: notes }, async (handle) => {
      handle.note("walkthrough_stub_used");
      return "wt";
    });
    expect(out).toBe("wt");
    expect(notes).toEqual(["walkthrough_stub_used"]);
  });

  it("degradationNotes undefined → log-only, never touches a list (Python None branch)", async () => {
    const logger = makeLogger();
    const result = await stageOutcome("cleanup", { logger }, async () => {
      throw new Error("leak");
    });
    expect(result).toBeUndefined();
    expect(logger.warning).toHaveBeenCalledTimes(1);
  });

  it("threads head_sha + run_id into the WARN line", async () => {
    const logger = makeLogger();
    await stageOutcome(
      "classify",
      { logger, headSha: "abc123", runId: "run-9" },
      async () => {
        throw new Error("nope");
      },
    );
    expect(logger.lines[0]).toContain("head_sha=abc123");
    expect(logger.lines[0]).toContain("run_id=run-9");
  });

  it("unknown stage name raises synchronously before the body runs", async () => {
    const logger = makeLogger();
    const bodyRan = vi.fn();
    await expect(
      stageOutcome("not_a_real_stage", { logger }, async () => {
        bodyRan();
        return 1;
      }),
    ).rejects.toThrow(/unknown stage/);
    expect(bodyRan).not.toHaveBeenCalled();
  });

  it("truncates a very long error message to 2KB in the error_msg field", async () => {
    const logger = makeLogger();
    const huge = "x".repeat(5000);
    await stageOutcome("aggregate", { logger }, async () => {
      throw new Error(huge);
    });
    // The error_msg=<json> field is capped at 2048 chars: extract the JSON-quoted value and assert its
    // length. (The truncated stack below it still echoes more of the message — faithful to the Python's
    // separate 8KB traceback truncation — so we assert on the error_msg field specifically, not the whole
    // line.)
    const line = logger.lines[0] ?? "";
    const m = /error_msg="(x+)"/.exec(line);
    expect(m).not.toBeNull();
    expect(m?.[1]?.length).toBe(2048);
  });
});

describe("recordStage shim — outcome allowlist guard (Stage 0 no-op emit)", () => {
  it("accepts every locked outcome without throwing", () => {
    for (const outcome of OUTCOMES) {
      expect(() => recordStage({ stage: "clone", outcome })).not.toThrow();
    }
  });

  it("rejects an out-of-allowlist outcome (a typo'd outcome silently drops the metric)", () => {
    expect(() => recordStage({ stage: "clone", outcome: "degraded" })).toThrow(/invalid outcome/);
  });
});

describe("STAGE_NAMES registry — pipeline_metrics.STAGE_NAMES + TS-enhancement stages", () => {
  it("contains 33 stage names (30 from Python + 3 TS-enhancement)", () => {
    expect(STAGE_NAMES.size).toBe(33);
  });

  it("contains the TS-enhancement stages (#4 manifest fetch/parse + #6 carry-forward)", () => {
    for (const s of [
      "fetch_manifest_snapshots",
      "parse_manifest_dependencies",
      "load_parent_review_findings",
    ]) {
      expect(STAGE_NAMES.has(s)).toBe(true);
    }
  });

  it("contains the spine stages the orchestrator drives", () => {
    for (const s of [
      "clone",
      "classify",
      "chunk_and_redact",
      "static_analysis",
      "select_carry_forward",
      "review_chunk",
      "aggregate",
      "walkthrough",
      "post_review",
      "post_check_run",
      "cleanup",
    ]) {
      expect(STAGE_NAMES.has(s)).toBe(true);
    }
  });
});

describe("DegradationCollector — dedup + compose", () => {
  it("dedups on insert (a repeated note is added once)", () => {
    const c = new DegradationCollector();
    c.add("persist_findings_failed");
    c.add("persist_findings_failed");
    c.add("apply_arbitration_failed");
    expect(c.notes).toEqual(["persist_findings_failed", "apply_arbitration_failed"]);
  });

  it("compose() with no notes returns the prior note unchanged", () => {
    const c = new DegradationCollector();
    expect(c.compose("earlier signal")).toBe("earlier signal");
    expect(c.compose(null)).toBeNull();
    expect(c.compose()).toBeNull();
  });

  it("compose() prefixes 'pipeline degraded: ' and joins with ', '", () => {
    const c = new DegradationCollector();
    c.add("persist_findings_failed");
    c.add("record_tool_runs_failed");
    expect(c.compose(null)).toBe(
      "pipeline degraded: persist_findings_failed, record_tool_runs_failed",
    );
  });

  it("compose() chains onto a non-empty prior note with '; '", () => {
    const c = new DegradationCollector();
    c.add("retrieval_degraded");
    expect(c.compose("earlier")).toBe("earlier; pipeline degraded: retrieval_degraded");
  });

  it("notes getter returns an immutable snapshot (mutating it does not affect the collector)", () => {
    const c = new DegradationCollector();
    c.add("a");
    const snap = c.notes as Array<string>;
    snap.push("b");
    expect(c.notes).toEqual(["a"]);
  });
});
