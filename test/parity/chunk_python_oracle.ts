// Python-chunker parity oracle: talks to ONE long-lived Python ref process over stdin/stdout JSONL.
// Drives the frozen TreeSitterPythonChunker (tools/parity/run_chunk_python_ref.py) so the TS port can
// be proven byte-equal against the source-of-truth. Unlike oracle.ts (which calls a module-level pure
// function), the chunker is an async METHOD taking `body: bytes`; this driver carries the raw bytes as
// base64 and returns the full DiffChunkV1 tuples verbatim so chunk_id / body / span compare directly.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One chunk dict as emitted by the Python driver (DiffChunkV1.model_dump(mode="json")). */
export type RefChunk = {
  readonly schema_version: number;
  readonly chunk_id: string;
  readonly path: string;
  readonly language: string | null;
  readonly start_line: number;
  readonly end_line: number;
  readonly body: string;
  readonly chunk_kind: string;
  readonly token_estimate: number;
};

type RefResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly chunks?: ReadonlyArray<RefChunk>;
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
    [join(repoRoot, "tools", "parity", "run_chunk_python_ref.py")],
    { cwd: submodule }, // so `import codemaster` resolves against the frozen source-of-truth
  );
  createInterface({ input: p.stdout }).on("line", (line) => {
    const r = JSON.parse(line) as RefResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  p.stderr.on("data", (d: Buffer) => process.stderr.write(`[chunk-ref] ${d}`));
  proc = p;
  return p;
}

/** Run the frozen TreeSitterPythonChunker over (path, body bytes, hunk_ranges); return its chunks. */
export async function pyChunkPython(args: {
  path: string;
  body: Uint8Array;
  hunkRanges: ReadonlyArray<readonly [number, number]>;
}): Promise<Array<RefChunk>> {
  const id = String(seq++);
  const body_b64 = Buffer.from(args.body).toString("base64");
  const r = await new Promise<RefResponse>((resolve) => {
    pending.set(id, resolve);
    ref().stdin.write(
      JSON.stringify({
        id,
        op: "chunk_python",
        path: args.path,
        body_b64,
        hunk_ranges: args.hunkRanges.map(([s, e]) => [s, e]),
      }) + "\n",
    );
  });
  if (!r.ok) throw new Error(`python chunk ref failed: ${r.err}`);
  return [...(r.chunks ?? [])];
}

export function shutdownChunkRef(): void {
  proc?.stdin.end();
  proc = undefined;
}
