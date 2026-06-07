// Dedup-findings parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `dedup_linter_with_llm` (tools/parity/run_dedup_ref.py) with a forced-skip embedder
// so the TS port (doDedupLinterWithLlm, no-embedder seam) can be proven byte-equal against the
// source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because `dedup_linter_with_llm` takes constructed tuples
// of `ReviewFindingV1` Pydantic instances + a failing embedder (not a flat kwargs dict), and findings
// carry a `confidence` FLOAT the generic canonicalizing runner rejects. Returns the raw findings list
// (each via `model_dump(mode="json")`) so the test can canonicalize + diff (confidence stripped).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One finding wire dict as accepted by `ReviewFindingV1(**dict)` on the Python side. */
export type FindingInput = Record<string, unknown>;

/** The `{ findings: [ReviewFindingV1.model_dump(mode="json"), ...] }` dict the Python driver emits. */
export type DedupedDict = { readonly findings: ReadonlyArray<Record<string, unknown>> };

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: DedupedDict;
  readonly err?: string;
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
    [join(repoRoot, "tools", "parity", "run_dedup_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[dedup-ref] ${String(d)}`));
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

/** Run the frozen `dedup_linter_with_llm` over the given linter + LLM findings; return its findings dict. */
export async function pyDedupLinterWithLlm(
  linterFindings: ReadonlyArray<FindingInput>,
  llmFindings: ReadonlyArray<FindingInput>,
): Promise<DedupedDict> {
  const r = await request({
    op: "dedup_linter_with_llm",
    linter_findings: [...linterFindings],
    llm_findings: [...llmFindings],
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python dedup ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownDedupRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
