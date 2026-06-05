// Post-pass / activity parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen chunker POST-PASSES (token_budget.enforce_token_budget,
// batcher.batch_adjacent, token_budget.estimate_tokens), the selector dispatch
// (ChunkerRegistry.select_for → class name), AND the composite chunk_and_redact_activity over the real
// registry + real redactors (tools/parity/run_post_pass_ref.py). Mirrors chunk_python_oracle.ts: the
// inputs (DiffChunkV1 tuples / raw file bytes) can't be carried as `**kwargs`, so this is a dedicated
// driver rather than oracle.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One chunk dict as emitted by the Python driver (DiffChunkV1.model_dump(mode="json")). */
export type RefChunk = {
  readonly schema_version: number;
  readonly chunk_id: string;
  readonly path: string;
  readonly language: string | null;
  readonly start_line: number;
  readonly end_line: number;
  readonly body: string;
  readonly chunk_kind: string;
  readonly token_estimate: number;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly value?: number | string;
  readonly chunks?: ReadonlyArray<RefChunk>;
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
    [join(repoRoot, "tools", "parity", "run_post_pass_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[postpass-ref] ${d}`));
  proc = p;
  return p;
}

function send(payload: Record<string, unknown>): Promise<RefResponse> {
  const id = String(seq++);
  return new Promise<RefResponse>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(JSON.stringify({ id, ...payload }) + "\n");
  });
}

/** frozen token_budget.estimate_tokens(body). */
export async function pyEstimateTokens(body: string): Promise<number> {
  const r = await send({ op: "estimate_tokens", body });
  if (!r.ok) throw new Error(`postpass ref failed: ${r.err}`);
  return r.value as number;
}

/** frozen token_budget.enforce_token_budget(chunks, max_tokens=...). */
export async function pyEnforceTokenBudget(
  chunks: ReadonlyArray<RefChunk>,
  maxTokens: number,
): Promise<Array<RefChunk>> {
  const r = await send({ op: "enforce_token_budget", chunks, max_tokens: maxTokens });
  if (!r.ok) throw new Error(`postpass ref failed: ${r.err}`);
  return [...(r.chunks ?? [])];
}

/** frozen batcher.batch_adjacent(chunks, budget_tokens=...). */
export async function pyBatchAdjacent(
  chunks: ReadonlyArray<RefChunk>,
  budgetTokens: number,
): Promise<Array<RefChunk>> {
  const r = await send({ op: "batch_adjacent", chunks, budget_tokens: budgetTokens });
  if (!r.ok) throw new Error(`postpass ref failed: ${r.err}`);
  return [...(r.chunks ?? [])];
}

/** frozen ChunkerRegistry.build().select_for(path) → the chosen chunker's class name. */
export async function pySelectForName(path: string): Promise<string> {
  const r = await send({ op: "select_for_name", path });
  if (!r.ok) throw new Error(`postpass ref failed: ${r.err}`);
  return r.value as string;
}

/** frozen chunk_and_redact_activity over a materialized tmp workspace + the real registry/redactors. */
export async function pyChunkAndRedact(args: {
  files: ReadonlyArray<{ rel: string; body: Uint8Array }>;
  changedLineRanges: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;
}): Promise<Array<RefChunk>> {
  const files = args.files.map((f) => ({
    rel: f.rel,
    body_b64: Buffer.from(f.body).toString("base64"),
  }));
  const changed_line_ranges: Record<string, Array<[number, number]>> = {};
  for (const [rel, pairs] of Object.entries(args.changedLineRanges)) {
    changed_line_ranges[rel] = pairs.map(([s, e]) => [s, e]);
  }
  const r = await send({ op: "chunk_and_redact", files, changed_line_ranges });
  if (!r.ok) throw new Error(`postpass ref failed: ${r.err}`);
  return [...(r.chunks ?? [])];
}

export function shutdownPostPassRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
