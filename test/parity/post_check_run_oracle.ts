// post_check_run parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen `_do_post_check_run` (tools/parity/run_post_check_run_ref.py) with a scripted
// RECORDING STUB `GhCheckRunClient` so the TS port's find→update/create LOGIC can be proven byte-equal
// against the source-of-truth WITHOUT any real GitHub round-trip (the real REST client is exercised
// separately on the TS side via a recording stub of the GitHubApiClient transport).
//
// The Python stub returns the caller-scripted `existing` (an int or None) from find_existing_check_run and
// records every call (method + kwargs); the TS test drives the SAME stub shape + inputs and asserts the
// returned PostedCheckRunV1 + the recorded call sequence byte-match.
//
// Mirrors classify_oracle.ts for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One recorded stub call: the method name + the kwargs the orchestration passed (snake_case, as Python). */
export type RecordedCall = {
  readonly method: "find_existing_check_run" | "create_check_run" | "update_check_run";
  readonly kwargs: Record<string, unknown>;
};

/** The `{check_run_id, was_update}` dict the Python driver emits (the dataclass's two fields). */
export type PostedCheckRunDict = {
  readonly check_run_id: number;
  readonly was_update: boolean;
};

/** The single `do_post_check_run` request payload both sides drive from. */
export type PostCheckRunRequest = {
  readonly pr_meta: Record<string, unknown>;
  readonly head_sha: string;
  readonly summary: string;
  readonly owner: string;
  readonly repo_name: string;
  /** The id the stub's find_existing_check_run returns: an int (update path) or null (create path). */
  readonly existing: number | null;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: PostedCheckRunDict;
  readonly calls?: ReadonlyArray<RecordedCall>;
  readonly err?: string;
};

/** Either a successful run (result + calls) or a raised error (err) — what both `_do_post_check_run`
 *  outcomes look like over the wire. */
export type PyPostCheckRunOutcome =
  | { readonly ok: true; readonly result: PostedCheckRunDict; readonly calls: ReadonlyArray<RecordedCall> }
  | { readonly ok: false; readonly err: string };

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
    [join(repoRoot, "tools", "parity", "run_post_check_run_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[post-check-run-ref] ${String(d)}`));
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

/** Run the frozen `_do_post_check_run` over the given request; return its outcome (result+calls OR err). */
export async function pyDoPostCheckRun(req: PostCheckRunRequest): Promise<PyPostCheckRunOutcome> {
  const r = await request({
    op: "do_post_check_run",
    pr_meta: req.pr_meta,
    head_sha: req.head_sha,
    summary: req.summary,
    owner: req.owner,
    repo_name: req.repo_name,
    existing: req.existing,
  });
  if (r.ok && r.result !== undefined && r.calls !== undefined) {
    return { ok: true, result: r.result, calls: r.calls };
  }
  return { ok: false, err: r.err ?? "no result" };
}

export function shutdownPostCheckRunRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
