// Arbitration parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL
// (tools/parity/run_arbitrate_ref.py). Drives the frozen `arbitrate` core (the bundled-policy path) +
// the `ApplyArbitrationInput` envelope so the TS port can be proven byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts): `arbitrate` takes constructed tuples of Pydantic
// instances + a `SuppressionPolicy` (not a flat kwargs dict), and its result's `rejected_intents` carry a
// `Decimal | None` hand-encoded as a string. The driver emits the result already JSON-encoded; this oracle
// returns it raw so the test can canonicalize + diff.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One wire dict as accepted by the Python constructors (AnalysisFindingV1 / ReviewFindingV1 / intent). */
export type WireDict = Record<string, unknown>;

/** The `{ decisions, rejected_intents }` dict the `arbitrate` op emits (raw, pre-canonicalization). */
export type ArbitrateResultDict = {
  readonly decisions: ReadonlyArray<Record<string, unknown>>;
  readonly rejected_intents: ReadonlyArray<Record<string, unknown>>;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
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
    [join(repoRoot, "tools", "parity", "run_arbitrate_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[arbitrate-ref] ${String(d)}`));
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

/** Run the frozen `arbitrate` (bundled policy) over the given inputs; return its result dict. */
export async function pyArbitrate(args: {
  tier1Findings: ReadonlyArray<WireDict>;
  tier2Findings: ReadonlyArray<readonly [string, WireDict]>;
  intents: ReadonlyArray<WireDict>;
  model: string;
  promptVersion: string;
  now: string;
}): Promise<ArbitrateResultDict> {
  const r = await request({
    op: "arbitrate",
    tier1_findings: [...args.tier1Findings],
    tier2_findings: args.tier2Findings.map(([id, d]) => [id, d]),
    intents: [...args.intents],
    model: args.model,
    prompt_version: args.promptVersion,
    now: args.now,
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python arbitrate ref failed: ${r.err ?? "no result"}`);
  }
  return r.result as ArbitrateResultDict;
}

/**
 * Round-trip an `ApplyArbitrationInput` payload through Pydantic: returns `{ ok, out }` where `out` is the
 * model_dump(mode="json") on success (null on a ValidationError). Lets the contract test assert
 * accept/reject + dump parity.
 */
export async function pyApplyArbitrationInput(
  payload: Record<string, unknown>,
): Promise<{ readonly ok: boolean; readonly out: unknown; readonly err: string | undefined }> {
  const r = await request({ op: "apply_arbitration_input", payload });
  return { ok: r.ok, out: r.ok ? r.result : null, err: r.err };
}

/** Dump the frozen BUNDLED suppression policy (model_dump(mode="json")) for drift-guard parity. */
export async function pyLoadPolicy(): Promise<unknown> {
  const r = await request({ op: "load_policy" });
  if (!r.ok) throw new Error(`python load_policy ref failed: ${r.err ?? "no result"}`);
  return r.result;
}

/** Run the frozen `is_suppressible` for one (tool, rule_id, confidence) tuple. */
export async function pyIsSuppressible(args: {
  tool: string;
  ruleId: string;
  confidence: number;
}): Promise<{ readonly suppressible: boolean; readonly min_confidence: number }> {
  const r = await request({
    op: "is_suppressible",
    tool: args.tool,
    rule_id: args.ruleId,
    confidence: args.confidence,
  });
  if (!r.ok) throw new Error(`python is_suppressible ref failed: ${r.err ?? "no result"}`);
  return r.result as { suppressible: boolean; min_confidence: number };
}

export function shutdownArbitrateRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
