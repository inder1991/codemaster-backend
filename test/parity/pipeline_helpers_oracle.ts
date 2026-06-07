// pipeline-helpers parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen pure pipeline helpers (tools/parity/run_pipeline_helpers_ref.py) so the TS ports can
// be proven byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because each op maps to a DIFFERENT frozen helper with a
// different argument shape (some take a PublicationOutcome enum, some a uuid tuple, some none). Mirrors
// config_oracle.ts for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

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
    [join(repoRoot, "tools", "parity", "run_pipeline_helpers_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[pipeline-helpers-ref] ${String(d)}`));
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

/** Run the named frozen helper `op` with `args` and return its raw JSON result (throwing on a ref error). */
export async function pyHelper(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const r = await request({ op, ...args });
  if (!r.ok) {
    throw new Error(`python pipeline-helpers ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownPipelineHelpersRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
