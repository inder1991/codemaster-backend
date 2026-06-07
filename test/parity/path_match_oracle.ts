// path_match parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `codemaster/config/path_match.py` (tools/parity/run_path_match_ref.py) so the TS
// port can be proven byte-equal against the source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because `match_path_instructions` takes a tuple of
// CONSTRUCTED `PathInstructionV1` Pydantic instances as `rules=`, not a flat kwargs dict — the
// generic `fn(**kwargs)` runner cannot build the models. This driver also exposes the white-box
// `glob_regex` op so the test can pin the EXACT regex translation, not just match outcomes.
//
// Mirrors policy_oracle.ts / config_oracle.ts for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One PathInstructionV1 dict (matches the contract fields the driver re-constructs / emits). */
export type PathInstructionDict = {
  readonly path: string;
  readonly instructions: string;
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
    [join(repoRoot, "tools", "parity", "run_path_match_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[path-match-ref] ${String(d)}`));
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

async function run(payload: Record<string, unknown>): Promise<unknown> {
  const r = await request(payload);
  if (!r.ok) throw new Error(`python path_match ref failed: ${r.err}`);
  return r.result;
}

/** Frozen `matches_glob(path=, pattern=)`. */
export async function pyMatchesGlob(path: string, pattern: string): Promise<boolean> {
  return (await run({ op: "matches_glob", path, pattern })) as boolean;
}

/** Frozen `filter_review_paths(paths, path_filters)` → kept paths (order-preserving subsequence). */
export async function pyFilterReviewPaths(
  paths: ReadonlyArray<string>,
  pathFilters: ReadonlyArray<string>,
): Promise<Array<string>> {
  return (await run({
    op: "filter_review_paths",
    paths: [...paths],
    path_filters: [...pathFilters],
  })) as Array<string>;
}

/** Frozen `match_path_instructions(path=, rules=)` → matched PathInstructionV1 dicts in order. */
export async function pyMatchPathInstructions(
  rules: ReadonlyArray<PathInstructionDict>,
  chunkPath: string,
): Promise<Array<PathInstructionDict>> {
  return (await run({
    op: "match_path_instructions",
    path: chunkPath,
    rules: rules.map((r) => ({ path: r.path, instructions: r.instructions })),
  })) as Array<PathInstructionDict>;
}

/** White-box: the frozen `_glob_to_regex(pattern).pattern` string (exact regex translation). */
export async function pyGlobRegex(pattern: string): Promise<string> {
  return (await run({ op: "glob_regex", pattern })) as string;
}

export function shutdownPathMatchRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
