/**
 * Coverage test for the Temporal worker composition root (`apps/backend/src/worker/build_activities.ts`).
 *
 * This is the regression guard for two defect classes the composition root closes:
 *
 *   1. MISSING ACTIVITIES — the pre-`buildActivities` static registry registered only a partial slice of
 *      the review-pipeline surface (no chunk/redact, embed, retrieve, workspace, or review-chunk
 *      activities). A workflow dispatching one of the absent activities crashes at runtime with
 *      `ActivityNotRegistered`. This test asserts EVERY expected activity NAME is present in the map.
 *
 *   2. THE 2-ARG LATENT CRASH — Temporal dispatches an activity with a SINGLE positional argument. A bare
 *      2-arg function (e.g. `cloneRepoIntoWorkspace(req, deps)`) registered directly receives `deps ===
 *      undefined` and crashes (or silently runs with a hole). The composition root CURRIES every such
 *      activity into a 1-arg `(input) => …` closure. A curried activity has `.length === 1`; a bare 2-arg
 *      function has `.length === 2`. This test asserts `fn.length <= 1` for EVERY registered value, so a
 *      future regression that registers a bare 2-arg function FAILS HERE rather than at dispatch time.
 *
 * ## No DB, no network
 *
 * `buildActivities()` constructs the real collaborators but the `*.fromDsn(...)` constructors build a
 * LAZY pool (no connection at construction), and the LlmClientCache + Vault wiring is deferred to first
 * `bedrockReviewChunk` invocation (the same production-deferred-Vault pattern the sibling post_* activities
 * use). So construction is cheap: it reads `CODEMASTER_PG_CORE_DSN` + `CODEMASTER_GITHUB_INSTALLATION_ID`
 * (+ `CODEMASTER_QWEN_DSN` for the embedder), which this test sets to dummy values; it never connects.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildActivities } from "#backend/worker/build_activities.js";

// The full review-pipeline activity surface the composition root MUST register. Keys are the camelCase
// function names Temporal resolves activities by (matching the workflow `proxyActivities<{…}>` surface).
const EXPECTED_ACTIVITY_NAMES = [
  "persistReviewFindings",
  "persistReviewWalkthrough",
  "aggregateFindings",
  "dedupFindings",
  "classifyFiles",
  "cloneRepoIntoWorkspace",
  "loadRepoConfigActivity",
  "computePolicyRules",
  "postCheckRun",
  "postReviewResults",
  "chunkAndRedact",
  "redactChunks",
  "selectCarryForward",
  "staticAnalysis",
  "allocateWorkspace",
  "releaseWorkspace",
  "embedQuery",
  "retrieveKnowledge",
  "bedrockReviewChunk",
  "generateWalkthrough",
  // Stage-2 lifecycle: gate + mutex lease renew/release + placeholder post/delete (dispatched directly by
  // the workflow body, not the orchestrator's activity_proxy bridge).
  "startReviewForWebhook",
  "renewPrReviewMutexLeaseActivity",
  "releasePrReviewMutexActivity",
  "postReviewPlaceholder",
  "deleteReviewPlaceholder",
  // Stage-3 run-lifecycle + finding-delivery + citation + audit (the body's ANALYSIS_STARTED/ANALYZED/
  // finalize/run-failed/run-cancelled + the lifecycle-bookkeeping setters; the orchestrator's Step 7.5
  // citation_validate + the output-safety audit emit).
  "recordReviewLifecycleEvent",
  "finalizeReviewRun",
  "recordRunFailed",
  "recordRunCancelled",
  "recordDeliveryFinalized",
  "recordDeliverySkipped",
  "recordDeliveryDegraded",
  "citationValidate",
  "emitOutputSafetyAuditEvent",
] as const;

describe("buildActivities() composition root", () => {
  // Snapshot + set dummy env so construction succeeds WITHOUT a DB connection or live Vault/GitHub. The
  // DSN is a syntactically-valid Postgres DSN (lazy pool — never dialed); the installation id is a
  // positive integer (the cloner + GitHub activities validate it as such); the Qwen DSN routes the
  // embedder through the dev recording client sentinel (no Qwen round-trip).
  const SAVED: Record<string, string | undefined> = {};
  const DUMMY_ENV: Record<string, string> = {
    CODEMASTER_PG_CORE_DSN: "postgresql://codemaster:codemaster@localhost:5433/codemaster_test",
    CODEMASTER_GITHUB_INSTALLATION_ID: "12345",
    CODEMASTER_QWEN_DSN: "stub://recording",
  };

  beforeAll(() => {
    for (const [k, v] of Object.entries(DUMMY_ENV)) {
      SAVED[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const k of Object.keys(DUMMY_ENV)) {
      const prev = SAVED[k];
      if (prev === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev;
      }
    }
  });

  it("registers EVERY review-pipeline activity (no ActivityNotRegistered gaps)", () => {
    const activities = buildActivities();
    const registered = Object.keys(activities).sort();
    for (const name of EXPECTED_ACTIVITY_NAMES) {
      expect(registered, `missing activity '${name}' in buildActivities() map`).toContain(name);
    }
  });

  it("every registered value is a 1-arg Temporal activity (arity <= 1 — the 2-arg-crash guard)", () => {
    const activities = buildActivities() as Record<string, unknown>;
    for (const [name, value] of Object.entries(activities)) {
      expect(typeof value, `activity '${name}' is not a function`).toBe("function");
      // A curried / bound 1-arg activity has `.length <= 1`; a bare 2-arg function has `.length === 2`
      // and crashes when Temporal dispatches it with one positional arg. This is the load-bearing assert.
      expect(
        (value as (...args: ReadonlyArray<unknown>) => unknown).length,
        `activity '${name}' has arity > 1 — it would receive 'undefined' for its 2nd arg when ` +
          `Temporal dispatches it with a single positional argument (curry it in buildActivities)`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
