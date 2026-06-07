// Curate-tool-use parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `parse_curate_tool_use` (tools/parity/run_curate_ref.py) so the TS port
// (parseCurateToolUse) can be proven byte-equal against the source-of-truth over adversarial blocks.
//
// A DEDICATED driver (not the generic oracle.ts) because parse_curate_tool_use returns a list of
// `ReviewFindingV1` Pydantic instances (each via `model_dump(mode="json")`) carrying a `confidence`
// FLOAT the generic canonicalizing runner rejects — and because a CurateParseError is a MODELED
// outcome the test must compare (raise + block_id parity), not a driver failure.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One Anthropic content block dict, exactly as `parse_curate_tool_use([block, ...])` accepts. */
export type ContentBlock = Record<string, unknown>;

/** The `{ findings: [ReviewFindingV1.model_dump(mode="json"), ...] }` dict the Python driver emits. */
export type CuratedDict = { readonly findings: ReadonlyArray<Record<string, unknown>> };

/** The driver's response: either a findings list, or a modeled CurateParseError (raised + block_id). */
export type CurateRefResult =
  | { readonly raised: false; readonly findings: ReadonlyArray<Record<string, unknown>> }
  | { readonly raised: true; readonly errorType: string; readonly blockId: string };

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly raised?: boolean;
  readonly result?: CuratedDict;
  readonly error_type?: string;
  readonly block_id?: string;
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
    [join(repoRoot, "tools", "parity", "run_curate_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[curate-ref] ${String(d)}`));
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

/** Run the frozen `parse_curate_tool_use` over the given blocks; return its findings OR raised outcome. */
export async function pyParseCurateToolUse(
  blocks: ReadonlyArray<ContentBlock>,
): Promise<CurateRefResult> {
  const r = await request({ op: "parse_curate_tool_use", blocks: [...blocks] });
  if (!r.ok) {
    throw new Error(`python curate ref failed: ${r.err ?? "no result"}`);
  }
  if (r.raised === true) {
    return { raised: true, errorType: r.error_type ?? "", blockId: r.block_id ?? "" };
  }
  if (r.result === undefined) {
    throw new Error("python curate ref returned ok without a result");
  }
  return { raised: false, findings: r.result.findings };
}

export function shutdownCurateRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
