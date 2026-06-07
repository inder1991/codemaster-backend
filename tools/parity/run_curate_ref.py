"""Long-lived parity driver for the frozen Python `parse_curate_tool_use` (the curate-tool-use parser).

Drives `codemaster.analysis.curator_schema.parse_curate_tool_use` over adversarial tool-use blocks so
the TS port (`apps/backend/src/analysis/curator_schema.ts::parseCurateToolUse`) can be proven
byte-equal to the source-of-truth.

`parse_curate_tool_use` takes a `list[dict]` of Anthropic content blocks and returns a
`tuple[ReviewFindingV1, ...]` — OR raises `CurateParseError(block_id, reason)` for a malformed
curate_finding block (missing/non-object input, or a contract-validation failure). The TS test asserts:

  * the SUCCESS findings list is byte-equal (confidence stripped; asserted structurally), AND
  * the RAISE behavior matches (the same block list raises on the Python side iff it raises on TS).

So this driver returns one of:
    {"id": "...", "ok": true,  "result": {"findings": [<ReviewFindingV1.model_dump(mode="json")>, ...]}}
    {"id": "...", "ok": true,  "raised": true, "error_type": "CurateParseError", "block_id": "..."}
    {"id": "...", "ok": false, "err": "..."}   # only on an UNEXPECTED driver error

Note: a CurateParseError is a MODELED outcome (ok=true, raised=true), not a driver failure — the TS
parity test asserts the raise + the block_id parity. An unexpected exception (ok=false) tears down
nothing; the long-lived process keeps serving.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "parse_curate_tool_use", "blocks": [<content block dict>, ...]}
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.analysis.curator_schema import CurateParseError, parse_curate_tool_use


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `parse_curate_tool_use` and return its encoded result."""
    op = req["op"]
    if op == "parse_curate_tool_use":
        blocks = list(req["blocks"])
        try:
            result = parse_curate_tool_use(blocks)
        except CurateParseError as exc:
            return {
                "id": req["id"],
                "ok": True,
                "raised": True,
                "error_type": "CurateParseError",
                "block_id": exc.block_id,
            }
        return {
            "id": req["id"],
            "ok": True,
            "raised": False,
            "result": {"findings": [f.model_dump(mode="json") for f in result]},
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
