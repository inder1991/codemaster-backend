// Citation-validate parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `CitationValidator.validate` (tools/parity/run_citation_validate_ref.py) over a REAL
// on-disk workspace directory the test materializes, so the TS port (doValidateCitations) can be proven
// byte-equal against the source-of-truth surviving/dropped partition.
//
// A DEDICATED driver (not the generic oracle.ts) because `CitationValidator.validate` takes constructed
// tuples of `ReviewFindingV1` Pydantic instances + a real workspace Path (filesystem syscalls), not a
// flat kwargs dict; and findings carry a `confidence` FLOAT the generic canonicalizing runner rejects.
// Returns the raw surviving + dropped lists (each finding via `model_dump(mode="json")`) so the test can
// canonicalize + diff (confidence stripped).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One finding wire dict as accepted by `ReviewFindingV1(**dict)` on the Python side. */
export type FindingInput = Record<string, unknown>;

/** The validate result dict the Python driver emits (each entry already `model_dump(mode="json")`). */
export type ValidationResultDict = {
  readonly surviving: ReadonlyArray<Record<string, unknown>>;
  readonly dropped: ReadonlyArray<Record<string, unknown>>;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: ValidationResultDict;
  readonly err?: string;
};

/** The tri-stated inputs the frozen validator's constructor accepts (mirrors the activity envelope). */
export type ValidateRefArgs = {
  readonly workspacePath: string;
  readonly findings: ReadonlyArray<FindingInput>;
  /** null = skip-mode (accept knowledge_chunk as-is); array = strict membership set. */
  readonly knowledgeChunkIds: ReadonlyArray<string> | null;
  /** null = skip-mode (accept policy_rule as-is); a PolicyCitationContextV1 wire dict selects observe/enforce. */
  readonly policyCitation: Record<string, unknown> | null;
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
    [join(repoRoot, "tools", "parity", "run_citation_validate_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[citation-validate-ref] ${String(d)}`));
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

/** Run the frozen `CitationValidator.validate` over the given workspace + findings; return its result dict. */
export async function pyValidateCitations(args: ValidateRefArgs): Promise<ValidationResultDict> {
  const r = await request({
    op: "validate",
    workspace_path: args.workspacePath,
    findings: [...args.findings],
    knowledge_chunk_ids: args.knowledgeChunkIds === null ? null : [...args.knowledgeChunkIds],
    policy_citation: args.policyCitation,
  });
  if (!r.ok || r.result === undefined) {
    throw new Error(`python citation-validate ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

export function shutdownCitationValidateRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
