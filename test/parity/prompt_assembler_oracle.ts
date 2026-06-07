// Prompt-assembler parity oracle for `assemble_prompt`: talks to ONE long-lived Python ref process
// over stdin/stdout JSONL. Drives the frozen prompt_assembler (tools/parity/run_prompt_assembler_ref.py)
// so the TS port can be proven byte-equal against the source-of-truth.
//
// A dedicated driver (not the generic oracle.ts) because `assemble_prompt` takes a CONSTRUCTED
// ResolvedGuidanceBundleV1 Pydantic instance plus a tuple of ScoredKnowledgeChunkV1 instances, not a
// kwargs dict — the generic `fn(**kwargs)` runner cannot build the models. Returns the raw
// AssembledPromptV1 model_dump dict so the envelope compares directly.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** AssembledPromptV1 dict as emitted by the Python driver (model_dump(mode="json")). */
export type AssembledDict = Record<string, unknown>;

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly assembled?: AssembledDict;
  readonly err?: string;
};

/** Wire shape for an assemble_prompt request (mirrors the driver's reconstruction inputs). */
export type AssemblePromptInput = {
  readonly policy_bundle: Record<string, unknown> | null;
  readonly knowledge_results: ReadonlyArray<Record<string, unknown>>;
  readonly total_budget_tokens?: number;
  readonly policy_max_tokens?: number;
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
    [join(repoRoot, "tools", "parity", "run_prompt_assembler_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[prompt-assembler-ref] ${d}`));
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

/** Run the frozen `assemble_prompt` over the input and return its emitted AssembledPromptV1 dict. */
export async function pyAssemblePrompt(input: AssemblePromptInput): Promise<AssembledDict> {
  const r = await request({ op: "assemble_prompt", ...input });
  if (!r.ok) throw new Error(`python prompt-assembler ref failed: ${r.err ?? "(no err)"}`);
  if (r.assembled === undefined) {
    throw new Error("python prompt-assembler ref returned ok with no assembled envelope");
  }
  return r.assembled;
}

export function shutdownPromptAssemblerRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
