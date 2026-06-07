/**
 * Activity registry — a thin re-export of the {@link buildActivities} COMPOSITION ROOT.
 *
 * The worker registry used to be a STATIC map that (a) registered only a partial slice of the
 * review-pipeline surface and (b) registered the 2-arg `cloneRepoIntoWorkspace(req, deps)` BARE — so a
 * Temporal dispatch (a single positional argument) left `deps === undefined` and crashed. That static
 * map is GONE: the registered surface is now constructed by `buildActivities()`, which builds the real
 * collaborators (git cloner, platform embedder, the ledger-wired LlmClientCache) and binds / curries
 * EVERY activity into a 1-arg Temporal activity — closing both the missing-activities gap and the
 * 2-arg-crash class.
 *
 * `buildActivities()` reads env (`CODEMASTER_PG_CORE_DSN`, the embedder vars) and constructs LAZY pools /
 * deferred-Vault wiring, so calling it at module load would
 * couple any importer to those env reads. The worker bootstrap (`main.ts`) therefore calls
 * `buildActivities()` itself at `runWorker()` time (when the env is populated). This module re-exports the
 * composition root so the bootstrap + any bundle self-check stay decoupled from the individual activity
 * modules.
 */

export { buildActivities } from "./build_activities.js";
