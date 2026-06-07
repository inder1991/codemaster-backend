"""Long-lived parity driver for the frozen Python WALKTHROUGH deterministic helpers.

Dedicated to the generate_walkthrough activity's PURE surface (the prompt builder + the file-rows
synthesizer + the tool schema) so the TS port can be proven 1:1 against the source-of-truth. The live
Opus call itself is proven separately in the dual-run; this driver covers ONLY the deterministic
transforms.

  * `_build_user_message(pr_meta=..., aggregated=...)` — the walkthrough LLM prompt body
    (vendor/codemaster-py/codemaster/review/walkthrough_activity.py). CHAR-FOR-CHAR significant: the
    dual-run replays the recorded LLM interaction keyed on these exact bytes.
  * `synthesize_file_rows_from_aggregated(findings)` — the fallback per-file table synthesizer
    (vendor/codemaster-py/codemaster/review/file_rows_synthesizer.py). Structurally significant.
  * `WALKTHROUGH_TOOL_SCHEMA` + `LLM_FALLBACK_SYNTHESIS_NOTE` constants.

Both sides operate on the IDENTICAL wire dict: the TS oracle serializes the wire shape its Zod
contracts produce, the Python side `model_validate`s the SAME dict — so the fixtures live only in TS.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kinds:

    {"id": "...", "op": "constants"}
        → {"id","ok":true,"tool_schema":<WALKTHROUGH_TOOL_SCHEMA dict>,
           "fallback_note":"<LLM_FALLBACK_SYNTHESIS_NOTE>"}

    {"id": "...", "op": "build_user_message", "pr_meta": {...}, "aggregated": {...}}
        Constructs PrMetaV1.model_validate(pr_meta) + AggregatedFindingsV1.model_validate(aggregated),
        calls _build_user_message(pr_meta=..., aggregated=...).
        → {"id","ok":true,"user_message":"<exact prompt string>"}

    {"id": "...", "op": "synthesize_file_rows", "findings": [<ReviewFindingV1 wire dicts>]}
        Constructs each finding via ReviewFindingV1.model_validate, calls
        synthesize_file_rows_from_aggregated(tuple(findings)).
        → {"id","ok":true,"file_rows":[<FileRowV1 model_dump(mode="json") dicts>]}

On any exception the driver emits {"id","ok":false,"err":"..."} and keeps running, so one bad request
never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.review.file_rows_synthesizer import (
    LLM_FALLBACK_SYNTHESIS_NOTE,
    synthesize_file_rows_from_aggregated,
)
from codemaster.review.walkthrough_activity import _build_user_message
from codemaster.review.walkthrough_renderer import render_walkthrough
from codemaster.review.walkthrough_schema import WALKTHROUGH_TOOL_SCHEMA
from codemaster.security.output_safety import MAX_OUTPUT_CHARS
from contracts.aggregated_findings.v1 import AggregatedFindingsV1
from contracts.review_findings.v1 import ReviewFindingV1
from contracts.walkthrough.pr_meta_v1 import PrMetaV1
from contracts.walkthrough.v1 import WalkthroughV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to a frozen helper and return its encoded result."""
    op = req["op"]
    if op == "constants":
        return {
            "id": req["id"],
            "ok": True,
            "tool_schema": WALKTHROUGH_TOOL_SCHEMA,
            "fallback_note": LLM_FALLBACK_SYNTHESIS_NOTE,
        }
    if op == "build_user_message":
        pr_meta = PrMetaV1.model_validate(req["pr_meta"])
        aggregated = AggregatedFindingsV1.model_validate(req["aggregated"])
        return {
            "id": req["id"],
            "ok": True,
            "user_message": _build_user_message(pr_meta=pr_meta, aggregated=aggregated),
        }
    if op == "synthesize_file_rows":
        findings = tuple(ReviewFindingV1.model_validate(f) for f in req["findings"])
        rows = synthesize_file_rows_from_aggregated(findings)
        return {
            "id": req["id"],
            "ok": True,
            "file_rows": [row.model_dump(mode="json") for row in rows],
        }
    if op == "render_walkthrough":
        walkthrough = WalkthroughV1.model_validate(req["walkthrough"])
        max_chars = req.get("max_chars", MAX_OUTPUT_CHARS)
        return {
            "id": req["id"],
            "ok": True,
            "markdown": render_walkthrough(walkthrough, max_chars=max_chars),
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
