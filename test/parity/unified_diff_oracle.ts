// Unified-diff-parser parity oracle: talks to ONE long-lived Python ref process over stdin/stdout
// JSONL. Drives the frozen `parse_unified_diff_ranges` (tools/parity/run_unified_diff_ref.py) so the
// TS port can be proven byte-equal against the source-of-truth over multi-hunk / added / deleted /
// renamed diffs. The parser is a module-level pure function taking the raw patch string; the driver
// carries it verbatim and returns either the post-image ranges OR a structured value-error marker so
// the parity test can assert "both sides raise on this input".
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The frozen parser's encoded result: either its sorted post-image ranges, or a value-error marker. */
export type RefParseResult =
  | { readonly ranges: ReadonlyArray<readonly [number, number]> }
  | { readonly error: "value_error"; readonly message: string };

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly ranges?: ReadonlyArray<readonly [number, number]>;
  readonly error?: "value_error";
  readonly message?: string;
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
    [join(repoRoot, "tools", "parity", "run_unified_diff_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[unified-diff-ref] ${d}`));
  proc = p;
  return p;
}

/** Run the frozen `parse_unified_diff_ranges(patch)` and return its ranges (or a value-error marker). */
export async function pyParseUnifiedDiff(patch: string): Promise<RefParseResult> {
  const id = String(seq++);
  const r = await new Promise<RefResponse>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(JSON.stringify({ id, op: "parse", patch }) + "\n");
  });
  if (!r.ok) throw new Error(`python unified-diff ref failed: ${r.err}`);
  if (r.error === "value_error") {
    return { error: "value_error", message: r.message ?? "" };
  }
  return { ranges: r.ranges ?? [] };
}

export function shutdownUnifiedDiffRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
