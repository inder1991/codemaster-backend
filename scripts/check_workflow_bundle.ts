/**
 * Workflow-bundle self-check (ADR-0065) — the build-time proof that the Temporal workflow sandbox bundle
 * is crypto-free, WITHOUT a running Temporal server.
 *
 * `bundleWorkflowCode({ workflowsPath })` runs the SDK's webpack-based bundler over the workflow module
 * and its transitive import graph, compiling them into the V8-isolate bundle. The bundler REFUSES
 * sandbox-illegal Node builtins (`node:crypto` among them) — so if the workflow graph (transitively)
 * imported `node:crypto` (e.g. via the `diff_chunking.v1` / `retrieved_evidence.v1` contracts or any
 * minting helper), bundling FAILS LOUDLY here. A clean exit 0 means the workflow body + everything it
 * pulls in is sandbox-safe: the ADR-0065 crypto boundary holds.
 *
 * This is intentionally a standalone script (run via `npx tsx scripts/check_workflow_bundle.ts`) rather
 * than a `make validate-fast` gate yet — bundling spins up webpack and is heavier than the AST gates.
 * FOLLOW-UP (ADR-0065): promote this to a `scripts/gates/` entry (wired into `run_all.ts`) once Phase 2.1
 * adds more workflows, so every workflow's sandbox-purity is enforced pre-merge.
 *
 * ## ESM `require.resolve`
 *
 * The package is `"type": "module"`; there is no ambient `require`. We reconstruct it via
 * `createRequire(import.meta.url)` (bound to THIS script's URL) and resolve the workflow module relative
 * to `scripts/` → `../apps/backend/src/workflows/...`.
 */

import { createRequire } from "node:module";

import { bundleWorkflowCode } from "@temporalio/worker";

/** ESM→CJS bridge: a `require` bound to THIS script's URL, so `require.resolve` works under ESM. */
const require_ = createRequire(import.meta.url);

/** Bundle the spine workflow; exit 0 on success, non-zero (printing the error) on any bundler failure. */
async function main(): Promise<number> {
  // Stage 1 — bundle the THIN review-pipeline SPINE workflow (review_pull_request.workflow), which
  // REPLACES the Phase-2.0 walking skeleton as the worker's served workflow. The bundler webpacks the
  // workflow body + its transitive import graph (the orchestrator, parallelism, state, degradation,
  // activity_proxy, and the type-only contract shapes) into the V8 sandbox bundle and REFUSES
  // sandbox-illegal Node builtins (node:crypto among them). A clean exit 0 proves the whole spine
  // (body + orchestrator + helpers) is sandbox-safe — the ADR-0065 crypto boundary holds.
  const workflowsPath = require_.resolve(
    "../apps/backend/src/workflows/review_pull_request.workflow",
  );
  try {
    const bundle = await bundleWorkflowCode({ workflowsPath });
    process.stdout.write(
      `[INFO] check_workflow_bundle: OK — workflow sandbox bundle compiled crypto-free ` +
        `(${bundle.code.length} bytes)\n`,
    );
    return 0;
  } catch (err: unknown) {
    process.stderr.write(
      `[ERROR] check_workflow_bundle: bundling FAILED — the workflow graph imports a ` +
        `sandbox-illegal module (e.g. node:crypto). See ADR-0065.\n${String(err)}\n`,
    );
    return 1;
  }
}

main()
  .then((rc) => {
    process.exit(rc);
  })
  .catch((err: unknown) => {
    process.stderr.write(`[ERROR] check_workflow_bundle: unexpected failure: ${String(err)}\n`);
    process.exit(1);
  });
