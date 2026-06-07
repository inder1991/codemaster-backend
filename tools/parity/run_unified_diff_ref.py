"""Long-lived parity driver for the frozen Python unified-diff hunk-range parser.

Dedicated to the unified-diff-parser seam (do NOT fold into run_python_ref.py — that runner
canonicalizes results / rejects bare types; this one carries the raw patch string verbatim and
distinguishes the malformed-header error path from a normal result). One interpreter, many requests:
read JSONL on stdin and emit one JSON line per request on stdout. Runs under the frozen submodule's
venv with cwd at vendor/codemaster-py so `import codemaster` resolves the source-of-truth.

One op kind:

    {"id": "...", "op": "parse", "patch": "<unified diff patch string>"}
        Calls the frozen `parse_unified_diff_ranges(patch)`. On success:
            {"id": "...", "ok": true, "ranges": [[start, end], ...]}
        On a malformed hunk header the frozen parser raises ValueError; that is a LEGITIMATE
        result the TS port must reproduce, so it is reported as a structured error WITHOUT an
        `ok: false` process-failure framing — instead:
            {"id": "...", "ok": true, "error": "value_error", "message": "<str(exc)>"}
        so the parity test can assert "both sides raise on this input" rather than treating the
        Python raise as a driver crash.

The post-image ranges are emitted as plain JSON arrays of two ints (the tuple[int, int] HunkRange
serialized). No floats anywhere, so no bit-exact float encoding is required.

On any UNEXPECTED exception (not the parser's own ValueError) the driver emits
{"id": "...", "ok": false, "err": "..."} and keeps running, so one bad request never tears down the
long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.integrations.github.unified_diff_parser import (
    parse_unified_diff_ranges,
)


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen parser and return its encoded result."""
    op = req["op"]
    if op == "parse":
        patch = req["patch"]
        try:
            ranges = parse_unified_diff_ranges(patch)
        except ValueError as exc:
            # The parser's OWN documented raise — a legitimate parity outcome, not a driver crash.
            return {
                "id": req["id"],
                "ok": True,
                "error": "value_error",
                "message": str(exc),
            }
        return {
            "id": req["id"],
            "ok": True,
            "ranges": [[start, end] for (start, end) in ranges],
        }
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
