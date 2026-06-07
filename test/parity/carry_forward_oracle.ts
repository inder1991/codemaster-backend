// Carry-forward parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `_do_select` (tools/parity/run_carry_forward_ref.py) so the TS port can be proven
// byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because `_do_select` takes a constructed tuple of
// `ReviewFindingV1` instances + a constructed tuple of `DiffChunkV1` instances + a tuple-of-tuples
// change map + a UUID-or-None parent id (not a flat kwargs dict), AND its result nests a
// `ReviewFindingV1.confidence` FLOAT that the generic canonicalizing runner rejects. Returns the raw
// `CarryForwardSelectionV1.model_dump(mode="json")` dict so the test can canonicalize + diff (confidence
// stripped from the canonical compare, asserted structurally). Mirrors aggregate_oracle.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One ReviewFindingV1 wire dict (the shape `ReviewFindingV1(**dict)` / `ReviewFindingV1.parse` accept). */
export type FindingInput = Record<string, unknown>;
/** One DiffChunkV1 wire dict (the shape `DiffChunkV1(**dict)` / `DiffChunkV1.parse` accept). */
export type ChunkInput = Record<string, unknown>;
/** The change map: path → list of [start, end] line ranges. JSON arrays; the Python driver re-tuples them. */
export type ChangedLineRanges = Record<string, ReadonlyArray<readonly [number, number]>>;

/** The `CarryForwardSelectionV1.model_dump(mode="json")` dict the Python driver emits. */
export type SelectionDict = Record<string, unknown>;

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: SelectionDict;
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
    [join(repoRoot, "tools", "parity", "run_carry_forward_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[carry-forward-ref] ${String(d)}`));
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

/**
 * Run the frozen `_do_select` over the given inputs; return its `CarryForwardSelectionV1` envelope dict.
 * Throws if the Python driver reported failure (used by the negative/accept-reject-parity assertions,
 * which catch the throw and assert the TS side throws too).
 */
export async function pyDoSelect(args: {
  readonly parentFindings: ReadonlyArray<FindingInput>;
  readonly currentChunks: ReadonlyArray<ChunkInput>;
  readonly changedLineRanges: ChangedLineRanges;
  readonly parentReviewId: string | null;
}): Promise<SelectionDict> {
  const r = await request({
    op: "do_select",
    parent_findings: [...args.parentFindings],
    current_chunks: [...args.currentChunks],
    changed_line_ranges: args.changedLineRanges,
    parent_review_id: args.parentReviewId,
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python carry-forward ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownCarryForwardRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
