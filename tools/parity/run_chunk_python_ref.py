"""Long-lived parity driver for the frozen Python TreeSitterPythonChunker.

Dedicated to the python-chunker seam (do NOT fold into run_python_ref.py — that runner calls a
MODULE-LEVEL pure function via `fn(**kwargs)`, but the chunker is an async METHOD on a class taking a
`body: bytes` argument that JSONL can't carry verbatim). One interpreter, many requests: read JSONL on
stdin and emit one JSON line per request on stdout. Runs under the frozen submodule's venv with cwd at
vendor/codemaster-py so `import codemaster` resolves the source-of-truth.

One op kind:

    {"id": "...", "op": "chunk_python", "path": "x.py", "body_b64": "<base64 of raw file BYTES>",
     "hunk_ranges": [[start, end], ...]}
        Decodes body_b64 → bytes, constructs the frozen TreeSitterPythonChunker(), awaits
        `.chunk(path=..., body=<bytes>, hunk_ranges=tuple(map(tuple, hunk_ranges)))`. Response:
            {"id": "...", "ok": true, "chunks": [<DiffChunkV1.model_dump(mode="json")>, ...]}
        Each chunk carries chunk_id / path / language / start_line / end_line / body / chunk_kind /
        token_estimate / schema_version — the full tuple the TS port must reproduce byte-for-byte.

`body` is carried as base64 of the RAW file bytes (not a str) so invalid-UTF-8 inputs round-trip
losslessly; the frozen chunker decodes them itself via `errors="replace"`, exactly like production.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Any

from codemaster.chunking.treesitter_python import TreeSitterPythonChunker

_CHUNKER = TreeSitterPythonChunker()


async def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen chunker and return its encoded chunk tuples."""
    op = req["op"]
    if op == "chunk_python":
        body = base64.b64decode(req["body_b64"])
        hunk_ranges = tuple((int(hs), int(he)) for hs, he in req.get("hunk_ranges", []))
        chunks = await _CHUNKER.chunk(
            path=req["path"],
            body=body,
            hunk_ranges=hunk_ranges,
        )
        return {
            "id": req["id"],
            "ok": True,
            "chunks": [c.model_dump(mode="json") for c in chunks],
        }
    raise ValueError(f"unknown op: {op!r}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            resp = asyncio.run(_handle(req))
        except Exception as exc:  # report, never crash the long-lived process
            resp = {"id": req.get("id"), "ok": False, "err": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
