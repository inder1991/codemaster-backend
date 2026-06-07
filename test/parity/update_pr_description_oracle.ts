// Parity oracle for the update_pr_description_summary PURE helpers: talks to ONE long-lived Python ref
// process over stdin/stdout JSONL. Drives the frozen pure helpers
// (tools/parity/run_update_pr_description_ref.py) so the TS ports (stripExistingSummary /
// buildSummaryMarkdown / composeNewBody + the marker constants) can be proven byte-equal against the
// source-of-truth.
//
// A DEDICATED driver (not the generic oracle.ts) because build_summary takes a tuple of CONSTRUCTED
// ReviewFindingV1, the strip/compose helpers take raw body STRINGS whose exact bytes (the HTML-comment
// markers) are load-bearing, and it dumps module-level marker constants. Mirrors
// walkthrough_helpers_oracle.ts for the spawn + readline + id-correlation pattern.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly summary_start?: string;
  readonly summary_end?: string;
  readonly stripped?: string;
  readonly summary?: string;
  readonly composed?: string;
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
    [join(repoRoot, "tools", "parity", "run_update_pr_description_ref.py")],
    { cwd: submodule }, // so `import codemaster` / `import contracts` resolve the source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[update-pr-description-ref] ${String(d)}`));
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

/** The marker delimiter strings from frozen Python (`_SUMMARY_START` / `_SUMMARY_END`). */
export async function pyMarkers(): Promise<{ start: string; end: string }> {
  const r = await request({ op: "constants" });
  if (!r.ok) throw new Error(`python update-pr-description ref failed: ${r.err}`);
  return { start: r.summary_start!, end: r.summary_end! };
}

/** Run the frozen `strip_existing_summary(body)` and return the stripped string. */
export async function pyStrip(body: string): Promise<string> {
  const r = await request({ op: "strip", body });
  if (!r.ok) throw new Error(`python update-pr-description ref failed: ${r.err}`);
  return r.stripped!;
}

/** Run the frozen `build_summary_markdown(findings)` over wire-shape findings; return the markdown. */
export async function pyBuildSummary(findings: ReadonlyArray<unknown>): Promise<string> {
  const r = await request({ op: "build_summary", findings });
  if (!r.ok) throw new Error(`python update-pr-description ref failed: ${r.err}`);
  return r.summary!;
}

/** Run the frozen `compose_new_body(original_body, build_summary_markdown(findings))`; return the body. */
export async function pyCompose(
  originalBody: string,
  findings: ReadonlyArray<unknown>,
): Promise<string> {
  const r = await request({ op: "compose", original_body: originalBody, findings });
  if (!r.ok) throw new Error(`python update-pr-description ref failed: ${r.err}`);
  return r.composed!;
}

export function shutdownUpdatePrDescriptionRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
