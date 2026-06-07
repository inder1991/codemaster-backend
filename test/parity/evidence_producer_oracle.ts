// Evidence-producer parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `build_retrieved_evidence` (tools/parity/run_evidence_producer_ref.py — the v10 R-12
// provenance-backed evidence manifest producer) so the TS port (buildRetrievedEvidenceEntries /
// buildRetrievedEvidence activity) can be proven byte-equal against the source-of-truth: same entries,
// same ev_ids, same priority-cap drop order.
//
// A DEDICATED driver (not the generic oracle.ts) because `build_retrieved_evidence` takes CONSTRUCTED
// Pydantic instances (DiffChunkV1 / KnowledgeChunkV1 / AnalysisFindingV1 / ToolStatusV1 /
// PRTopologyEntryV1) and accesses their attributes — a flat kwargs dict would AttributeError. Returns the
// raw entries list (each via `model_dump(mode="json")`) so the test can canonicalize + diff.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** A wire dict for one source model, as accepted by `<Model>(**dict)` on the Python side. */
export type ModelInput = Record<string, unknown>;

/** The `{ entries: [RetrievedEvidenceV1.model_dump(mode="json"), ...] }` dict the Python driver emits. */
export type EvidenceEntriesDict = { readonly entries: ReadonlyArray<Record<string, unknown>> };

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: EvidenceEntriesDict;
  readonly err?: string;
};

/** The per-chunk producer inputs the frozen `build_retrieved_evidence` accepts (mirrors the envelope). */
export type EvidenceRefArgs = {
  readonly chunk: ModelInput;
  readonly retrievedKnowledge?: ReadonlyArray<ModelInput>;
  readonly tier1Findings?: ReadonlyArray<ModelInput>;
  readonly toolStatuses?: ReadonlyArray<ModelInput>;
  readonly prTopologyManifest?: ReadonlyArray<ModelInput>;
  /** Omitted → the producer's own default (100) applies on BOTH sides. */
  readonly maxEntries?: number;
};

let proc: ChildProcessWithoutNullStreams | undefined;
const pending = new Map<string, (r: RefResponse) => void>();
let seq = 0;

function ref(): ChildProcessWithoutNullStreams {
  if (proc) return proc;
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
  const repoRoot = join(here, "..", "..");
  const submodule = join(repoRoot, "vendor", "codemaster-py");
  const p = spawn(
    join(submodule, ".venv", "bin", "python"),
    [join(repoRoot, "tools", "parity", "run_evidence_producer_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[evidence-producer-ref] ${String(d)}`));
  proc = p;
  return p;
}

function request(payload: Record<string, unknown>): Promise<RefResponse> {
  const id = String(seq++);
  return new Promise<RefResponse>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(JSON.stringify({ id, ...payload }) + "\n");
  });
}

/** Run the frozen `build_retrieved_evidence` over the given per-chunk inputs; return its entries dict. */
export async function pyBuildRetrievedEvidence(args: EvidenceRefArgs): Promise<EvidenceEntriesDict> {
  const payload: Record<string, unknown> = {
    op: "build_retrieved_evidence",
    chunk: args.chunk,
    retrieved_knowledge: [...(args.retrievedKnowledge ?? [])],
    tier1_findings: [...(args.tier1Findings ?? [])],
    tool_statuses: [...(args.toolStatuses ?? [])],
    pr_topology_manifest: [...(args.prTopologyManifest ?? [])],
  };
  if (args.maxEntries !== undefined) {
    payload["max_entries"] = args.maxEntries;
  }
  const r = await request(payload);
  if (!r.ok || r.result === undefined) {
    throw new Error(`python evidence-producer ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownEvidenceProducerRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
