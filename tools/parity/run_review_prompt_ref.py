"""Long-lived parity driver for the frozen Python review-chunk PROMPT BUILDER.

Dedicated to the bedrock_review_chunk prompt surface (do NOT fold into run_python_ref.py — that
generic runner calls `fn(**kwargs)`, but the prompt builder needs a fully-constructed
`ReviewContextV1` Pydantic instance as its single positional argument, plus it dumps several
module-level constants). This driver:

  * reconstructs `ReviewContextV1.model_validate(payload)` from the wire dict the TS oracle sends
    (the dict the TS-side Zod `ReviewContextV1` produced — so BOTH sides operate on the identical
    wire shape; the fixtures live only in TS),
  * calls the frozen pure builder `codemaster.review.activities._build_user_message(context)`,
  * and emits the byte-exact prompt string + the system prompt + the tool schemas.

The dual-run replays the recorded LLM interaction keyed on these exact bytes, so the TS port is
asserted CHAR-FOR-CHAR identical (exact string equality, NOT JSON-canonicalized) in
test/parity/review_prompt.parity.test.ts.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kinds:

    {"id": "...", "op": "constants"}
        Returns the static constants (no context needed). Response:
            {"id": "...", "ok": true,
             "system_prompt": "<REVIEW_SYSTEM_PROMPT>",
             "tool_schema": <REVIEW_TOOL_SCHEMA dict>,
             "arbitration_tool_schema": <ARBITRATION_INTENT_TOOL_SCHEMA dict>}

    {"id": "...", "op": "build_user_message", "context": {<ReviewContextV1 wire fields>}}
        Constructs ReviewContextV1.model_validate(context) and calls _build_user_message(ctx).
        Response: {"id": "...", "ok": true, "user_message": "<exact prompt string>"}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.llm.system_prompt import REVIEW_SYSTEM_PROMPT
from codemaster.review.activities import _build_user_message
from codemaster.review.tool_schema import (
    ARBITRATION_INTENT_TOOL_SCHEMA,
    REVIEW_TOOL_SCHEMA,
)
from contracts.review_context.v1 import ReviewContextV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen prompt builder and return its encoded result."""
    op = req["op"]
    if op == "constants":
        return {
            "id": req["id"],
            "ok": True,
            "system_prompt": REVIEW_SYSTEM_PROMPT,
            "tool_schema": REVIEW_TOOL_SCHEMA,
            "arbitration_tool_schema": ARBITRATION_INTENT_TOOL_SCHEMA,
        }
    if op == "build_user_message":
        ctx = ReviewContextV1.model_validate(req["context"])
        return {
            "id": req["id"],
            "ok": True,
            "user_message": _build_user_message(ctx),
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
