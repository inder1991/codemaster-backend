// Parity oracle for the WALKTHROUGH deterministic helpers: talks to ONE long-lived Python ref process
// over stdin/stdout JSONL. Drives the frozen pure helpers (tools/parity/run_walkthrough_helpers_ref.py)
// so the TS ports can be proven byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because the prompt builder takes CONSTRUCTED Pydantic
// instances (PrMetaV1 + AggregatedFindingsV1) as keyword args, the synthesizer takes a tuple of
// constructed ReviewFindingV1, and it also dumps module-level constants. Mirrors review_prompt_oracle.ts
// for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** A JSON value as emitted by the Python driver (the tool-schema dict / file-row dicts). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [k: string]: JsonValue };

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly tool_schema?: JsonValue;
  readonly fallback_note?: string;
  readonly user_message?: string;
  readonly file_rows?: ReadonlyArray<JsonValue>;
  readonly markdown?: string;
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
    [join(repoRoot, "tools", "parity", "run_walkthrough_helpers_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[walkthrough-helpers-ref] ${String(d)}`));
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

/** Static walkthrough constants (the tool schema + the fallback degradation note) from frozen Python. */
export async function pyConstants(): Promise<{ toolSchema: JsonValue; fallbackNote: string }> {
  const r = await request({ op: "constants" });
  if (!r.ok) throw new Error(`python walkthrough-helpers ref failed: ${r.err}`);
  return { toolSchema: r.tool_schema!, fallbackNote: r.fallback_note! };
}

/** Build the walkthrough user message for a wire-shape (pr_meta, aggregated) via the frozen builder. */
export async function pyBuildUserMessage(pr_meta: unknown, aggregated: unknown): Promise<string> {
  const r = await request({ op: "build_user_message", pr_meta, aggregated });
  if (!r.ok) throw new Error(`python walkthrough-helpers ref failed: ${r.err}`);
  return r.user_message!;
}

/** Synthesize file rows from wire-shape findings via the frozen synthesizer (FileRowV1 wire dicts). */
export async function pySynthesizeFileRows(
  findings: ReadonlyArray<unknown>,
): Promise<ReadonlyArray<JsonValue>> {
  const r = await request({ op: "synthesize_file_rows", findings });
  if (!r.ok) throw new Error(`python walkthrough-helpers ref failed: ${r.err}`);
  return r.file_rows!;
}

/** Render a wire-shape WalkthroughV1 to markdown via the frozen `render_walkthrough` (byte-exact). */
export async function pyRenderWalkthrough(
  walkthrough: unknown,
  maxChars?: number,
): Promise<string> {
  const r = await request(
    maxChars === undefined
      ? { op: "render_walkthrough", walkthrough }
      : { op: "render_walkthrough", walkthrough, max_chars: maxChars },
  );
  if (!r.ok) throw new Error(`python walkthrough-helpers ref failed: ${r.err}`);
  return r.markdown!;
}

export function shutdownWalkthroughHelpersRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
