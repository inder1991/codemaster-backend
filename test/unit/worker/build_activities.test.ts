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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildActivities } from "#backend/worker/build_activities.js";

// ── The two modules that proxy activities (the AUTHORITATIVE source of "what the workflow dispatches") ──
// The workflow body proxies the Stage-2/3/4 lifecycle + enrichment activities DIRECTLY; the orchestrator's
// activity_proxy bridge proxies the 18 pipeline activities + the Stage-3/4/5 orchestrator-side ports. Every
// `proxyActivities<{ <name>(...) }>(...)` block names a REGISTERED activity Temporal will dispatch by name —
// so the union of those names is exactly the set buildActivities() MUST register or the workflow dies with
// ActivityNotRegistered at dispatch. We parse this set from source so the coverage assertion is self-updating
// (a new proxied activity that is NOT registered fails the test below, rather than silently drifting).
const WORKFLOW_BODY_PATH = fileURLToPath(
  new URL("../../../apps/backend/src/workflows/review_pull_request.workflow.ts", import.meta.url),
);
const ACTIVITY_PROXY_PATH = fileURLToPath(
  new URL("../../../apps/backend/src/workflows/activity_proxy.ts", import.meta.url),
);

/**
 * Parse the REGISTERED activity names from every `proxyActivities<{ <name>(...)` block in a workflow-side
 * module. Each `proxyActivities()` call in this codebase is typed to exactly ONE registered-name method (the
 * naming-bridge convention activity_proxy.ts documents), so the FIRST identifier inside each
 * `proxyActivities<{` block IS the registered name Temporal dispatches by. A literal source parse (no TS
 * compile) is sufficient + dependency-free.
 */
function parseProxiedActivityNames(modulePath: string): ReadonlyArray<string> {
  const src = readFileSync(modulePath, "utf8");
  const names = new Set<string>();
  const re = /proxyActivities<\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.add(m[1]!);
  }
  return [...names];
}

/** The full union of activity names the two workflow-side modules proxy (the dispatch-by-name surface). */
const PROXIED_ACTIVITY_NAMES: ReadonlyArray<string> = [
  ...new Set([
    ...parseProxiedActivityNames(WORKFLOW_BODY_PATH),
    ...parseProxiedActivityNames(ACTIVITY_PROXY_PATH),
  ]),
];

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
  // #4 manifest fetch/parse (bound-method holders) + #6 carry-forward loader (bare fn) — dispatched
  // directly by the workflow body (fetch→parse straight-line; loader flag-gated default-off).
  "fetchManifestSnapshots",
  "parseManifestDependencies",
  "loadParentReviewFindings",
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
  // Stage-4 enrichment: changed-files enrich (body) + linked-issues / suggested-reviewers (body) +
  // PR-description summary (posting) + per-chunk evidence manifest (buildChunkContext). The two self-wiring
  // activities (enrichPrFilesV2, updatePrDescriptionSummary) + the stateless buildRetrievedEvidence are
  // registered bare; the two bound-method holders (fetchLinkedIssues, fetchSuggestedReviewers) are bound.
  "enrichPrFilesV2",
  "fetchLinkedIssues",
  "fetchSuggestedReviewers",
  "updatePrDescriptionSummary",
  "buildRetrievedEvidence",
  // Stage-5: arbitration apply + tool-run record (orchestrator Step 7.7) + fix-prompt (posting). The two
  // arbitration activities self-wire their repos from env (registered bare); generateFixPrompt is the
  // FixPromptActivities bound arrow property (shared LLM cache + repo + lazy GitHub client).
  "applyArbitrationActivity",
  "recordToolRuns",
  "generateFixPrompt",
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

  // ── Source-derived registry coverage (self-updating; no hand-maintained drift) ──
  // The two assertions above pin a HAND-MAINTAINED `EXPECTED_ACTIVITY_NAMES` list, which can silently drift
  // if a new proxied activity is added to the workflow body / activity_proxy bridge but the engineer forgets
  // to extend the list. THIS assertion derives the dispatch-by-name surface DIRECTLY from the two
  // proxyActivities() source modules, so a new proxied activity that is NOT registered fails HERE — proving
  // the FULL proxied set (not just the curated list) is covered, with no ActivityNotRegistered at runtime.
  it("registers EVERY activity the workflow proxies (full source-derived proxied set — no drift)", () => {
    // Guard against a parse regression: if the regex stopped matching, this would pass vacuously. The two
    // modules proxy dozens of activities; assert we actually parsed a non-trivial surface.
    expect(
      PROXIED_ACTIVITY_NAMES.length,
      "parsed proxied-activity set is implausibly small — the proxyActivities source parse likely broke",
    ).toBeGreaterThanOrEqual(30);

    const registered = new Set(Object.keys(buildActivities()));
    const missing = PROXIED_ACTIVITY_NAMES.filter((name) => !registered.has(name)).sort();
    expect(
      missing,
      `the workflow proxies these activities but buildActivities() does NOT register them — Temporal would ` +
        `crash with ActivityNotRegistered at dispatch: ${JSON.stringify(missing)}`,
    ).toEqual([]);

    // Cross-check the hand-maintained list is a SUPERSET of the source-derived set (so the curated list above
    // can't fall behind the source either). The curated list may carry extras (e.g. `redactChunks`, which is
    // registered as an internal helper but never proxied by name).
    const curated = new Set<string>(EXPECTED_ACTIVITY_NAMES);
    const notInCurated = PROXIED_ACTIVITY_NAMES.filter((name) => !curated.has(name)).sort();
    expect(
      notInCurated,
      `EXPECTED_ACTIVITY_NAMES has fallen behind the proxyActivities source — add: ${JSON.stringify(notInCurated)}`,
    ).toEqual([]);
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
