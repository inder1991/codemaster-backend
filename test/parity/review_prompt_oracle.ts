// Parity oracle for the review-chunk PROMPT BUILDER: talks to ONE long-lived Python ref process over
// stdin/stdout JSONL. Drives the frozen prompt builder (tools/parity/run_review_prompt_ref.py) so the
// TS port can be proven CHAR-FOR-CHAR byte-equal against the source-of-truth.
//
// A dedicated driver (not the generic oracle.ts) because `_build_user_message` takes a CONSTRUCTED
// ReviewContextV1 Pydantic instance (the generic `fn(**kwargs)` runner cannot build the model) and
// also dumps several module-level constants. The TS side serializes the wire dict produced by the
// Zod ReviewContextV1, the Python side `model_validate`s the SAME dict — so both operate on the
// identical wire shape and the fixtures live only in TS.
//
// IMPORTANT: comparison is EXACT STRING EQUALITY (not JSON-canonicalized). The prompt string is the
// LLM input byte stream; any divergence (a space, a newline, a number format) is a finding.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** A JSON value as emitted by the Python driver (the tool-schema dicts). */
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
  readonly system_prompt?: string;
  readonly tool_schema?: JsonValue;
  readonly arbitration_tool_schema?: JsonValue;
  readonly user_message?: string;
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
    [join(repoRoot, "tools", "parity", "run_review_prompt_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[review-prompt-ref] ${d}`));
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

/** Static prompt constants (system prompt + the two tool schemas) from the frozen Python. */
export async function pyConstants(): Promise<{
  systemPrompt: string;
  toolSchema: JsonValue;
  arbitrationToolSchema: JsonValue;
}> {
  const r = await request({ op: "constants" });
  if (!r.ok) throw new Error(`python review-prompt ref failed: ${r.err}`);
  return {
    systemPrompt: r.system_prompt!,
    toolSchema: r.tool_schema!,
    arbitrationToolSchema: r.arbitration_tool_schema!,
  };
}

/** Build the user message for a wire-shape ReviewContextV1 via the frozen Python builder. */
export async function pyBuildUserMessage(context: unknown): Promise<string> {
  const r = await request({ op: "build_user_message", context });
  if (!r.ok) throw new Error(`python review-prompt ref failed: ${r.err}`);
  return r.user_message!;
}

export function shutdownReviewPromptRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
