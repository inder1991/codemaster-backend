"""Long-lived parity driver for the frozen Python chunker POST-PASSES + selector + the composite
chunk_and_redact activity.

Dedicated to the post-pass / activity seam (do NOT fold into run_python_ref.py — that runner calls a
MODULE-LEVEL pure function via `fn(**kwargs)`, but these ops take tuples-of-DiffChunkV1 / raw file
bytes / a wired chunker registry that JSONL `**kwargs` can't carry verbatim). One interpreter, many
requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under the frozen
submodule's venv with cwd at vendor/codemaster-py so `import codemaster` resolves the source-of-truth.

Ops:

  {"id","op":"estimate_tokens","body":"<str>"}
      → {"id","ok":true,"value": <int>}                       (token_budget.estimate_tokens)

  {"id","op":"enforce_token_budget","chunks":[<chunk-dict>,...],"max_tokens": <int>}
      → {"id","ok":true,"chunks":[<DiffChunkV1.model_dump(mode="json")>,...]}

  {"id","op":"batch_adjacent","chunks":[<chunk-dict>,...],"budget_tokens": <int>}
      → {"id","ok":true,"chunks":[...]}

  {"id","op":"select_for_name","path":"<str>"}
      → {"id","ok":true,"value": "<ChunkerClassName>"}         (selector dispatch — class name proves
                                                                 which chunker was chosen)

  {"id","op":"chunk_and_redact","files":[<{"rel": "...", "body_b64": "..."}>,...],
   "changed_line_ranges": {"<rel>": [[s,e],...]}}
      → {"id","ok":true,"chunks":[...]}
      Materializes the files into a tmp workspace, wires ChunkerRegistry.build() onto worker.main, then
      awaits the FROZEN chunk_and_redact_activity over the real registry + the real redactors.

`<chunk-dict>` is a full DiffChunkV1 payload (the same keys model_dump emits). File bodies are carried
as base64 of RAW BYTES so invalid-UTF-8 round-trips losslessly. On any exception the driver emits
{"id","ok":false,"err":"..."} and keeps running.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
from typing import Any

import codemaster.worker.main as worker_main
from codemaster.activities.chunk_and_redact import chunk_and_redact_activity
from codemaster.chunking.batcher import batch_adjacent
from codemaster.chunking.selector import ChunkerRegistry
from codemaster.chunking.token_budget import enforce_token_budget, estimate_tokens
from contracts.diff_chunking.v1 import DiffChunkV1


def _dump(chunks: Any) -> list[dict[str, Any]]:
    return [c.model_dump(mode="json") for c in chunks]


def _to_chunk(d: dict[str, Any]) -> DiffChunkV1:
    return DiffChunkV1(**d)


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req["op"]

    if op == "estimate_tokens":
        return {"id": req["id"], "ok": True, "value": estimate_tokens(req["body"])}

    if op == "enforce_token_budget":
        chunks = tuple(_to_chunk(c) for c in req["chunks"])
        out = enforce_token_budget(chunks, max_tokens=int(req["max_tokens"]))
        return {"id": req["id"], "ok": True, "chunks": _dump(out)}

    if op == "batch_adjacent":
        chunks = tuple(_to_chunk(c) for c in req["chunks"])
        out = batch_adjacent(chunks, budget_tokens=int(req["budget_tokens"]))
        return {"id": req["id"], "ok": True, "chunks": _dump(out)}

    if op == "select_for_name":
        registry = ChunkerRegistry.build()
        chunker = registry.select_for(path=req["path"])
        return {"id": req["id"], "ok": True, "value": type(chunker).__name__}

    if op == "chunk_and_redact":
        worker_main._chunker_registry = ChunkerRegistry.build()
        tmp = tempfile.mkdtemp(prefix="codemaster_postpass_parity_")
        files: list[str] = []
        for f in req["files"]:
            rel = f["rel"]
            abspath = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(abspath) or tmp, exist_ok=True)
            with open(abspath, "wb") as fh:
                fh.write(base64.b64decode(f["body_b64"]))
            files.append(rel)
        ranges = {
            rel: tuple((int(s), int(e)) for s, e in pairs)
            for rel, pairs in req.get("changed_line_ranges", {}).items()
        }
        out = asyncio.run(
            chunk_and_redact_activity(tmp, tuple(files), ranges)
        )
        return {"id": req["id"], "ok": True, "chunks": _dump(out)}

    raise ValueError(f"unknown op: {op!r}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            resp = _handle(req)
        except Exception as exc:  # report, never crash the long-lived process
            resp = {"id": req.get("id"), "ok": False, "err": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
