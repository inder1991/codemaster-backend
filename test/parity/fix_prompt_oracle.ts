// Deterministic-fix-prompt parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen `build_fix_prompt_deterministic` / `severity_truncate` / `finding_id_for` /
// `neutralize_fence` (tools/parity/run_fix_prompt_ref.py) so the TS port can be proven BYTE-EXACT against
// the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because the builder takes a constructed tuple of
// `ReviewFindingV1` Pydantic instances + a `pr_meta` object (not a flat kwargs dict) and returns a BARE
// multi-line `str` (the generic canonicalizing runner only handles model_dump-able results). Returns the
// raw string / tuple so the test can assert exact equality.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One finding wire dict as accepted by `ReviewFindingV1(**dict)` on the Python side. */
export type FindingInput = Record<string, unknown>;

/** The `{ ids, truncated }` shape the `severity_truncate` op returns. */
export type SeverityTruncateResult = {
  readonly ids: ReadonlyArray<string>;
  readonly truncated: boolean;
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
    [join(repoRoot, "tools", "parity", "run_fix_prompt_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[fix-prompt-ref] ${String(d)}`));
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

function unwrap(r: RefResponse): unknown {
  if (!r.ok || r.result === undefined) {
    throw new Error(`python fix-prompt ref failed: ${r.err ?? "no result"}`);
  }
  return r.result;
}

/** Run the frozen `build_fix_prompt_deterministic` and return the raw rendered string. */
export async function pyBuildDeterministic(args: {
  findings: ReadonlyArray<FindingInput>;
  prNumber: number;
  truncated?: boolean;
  total?: number | null;
  synthesizedThemes?: string | null;
}): Promise<string> {
  const r = await request({
    op: "build_deterministic",
    findings: [...args.findings],
    pr_number: args.prNumber,
    truncated: args.truncated ?? false,
    total: args.total ?? null,
    synthesized_themes: args.synthesizedThemes ?? null,
  });
  return unwrap(r) as string;
}

/** Run the frozen `severity_truncate`; returns the included finding ids (in order) + the truncated flag. */
export async function pySeverityTruncate(args: {
  findings: ReadonlyArray<FindingInput>;
  maxFindings: number;
  maxChars: number;
}): Promise<SeverityTruncateResult> {
  const r = await request({
    op: "severity_truncate",
    findings: [...args.findings],
    max_findings: args.maxFindings,
    max_chars: args.maxChars,
  });
  return unwrap(r) as SeverityTruncateResult;
}

/** Run the frozen `finding_id_for` and return the stable F-xxxxxxxx id. */
export async function pyFindingId(finding: FindingInput): Promise<string> {
  const r = await request({ op: "finding_id", finding });
  return unwrap(r) as string;
}

/** Run the frozen `neutralize_fence` and return the defanged string. */
export async function pyNeutralizeFence(value: string): Promise<string> {
  const r = await request({ op: "neutralize_fence", value });
  return unwrap(r) as string;
}

export function shutdownFixPromptRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
