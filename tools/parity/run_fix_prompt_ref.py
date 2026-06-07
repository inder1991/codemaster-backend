"""Long-lived parity driver for the frozen Python deterministic fix-prompt builder.

Dedicated to the deterministic fix-prompt path (do NOT fold into run_python_ref.py — that generic
runner canonicalizes results as JSON via `model_dump`, but the builder returns a BARE multi-line
`str` that must survive verbatim, and the builder takes a constructed tuple of `ReviewFindingV1`
Pydantic instances + a `pr_meta` object, not a flat kwargs dict). This driver reconstructs the
findings from their wire dicts and drives the frozen functions, returning the raw string / tuple so
the TS port can assert BYTE-EXACT equality.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kinds:

    {"id": "...", "op": "build_deterministic",
     "findings": [<ReviewFindingV1 wire dict>, ...],
     "pr_number": <int>,
     "truncated": <bool, optional>,
     "total": <int | null, optional>,
     "synthesized_themes": <str | null, optional>}
        Constructs each ReviewFindingV1(**dict), then calls
        build_fix_prompt_deterministic(findings, None, pr_number=..., truncated=..., total=...,
        synthesized_themes=...) and returns {"id": ..., "ok": true, "result": <str>}.
        `pr_meta` is passed as None (the builder `del pr_meta`s it — v1 only needs pr_number).

    {"id": "...", "op": "severity_truncate",
     "findings": [<ReviewFindingV1 wire dict>, ...],
     "max_findings": <int>, "max_chars": <int>}
        Calls severity_truncate(findings, max_findings=..., max_chars=...) and returns the result as
        {"id": ..., "ok": true, "result": {"ids": [finding_id_for(f) for f in included], "truncated": bool}}
        (the included findings are identified by their stable finding_id_for so the TS port can compare
        order + membership without re-serializing the whole envelope).

    {"id": "...", "op": "finding_id",
     "finding": <ReviewFindingV1 wire dict>}
        Calls finding_id_for(ReviewFindingV1(**finding)) and returns {"id": ..., "ok": true, "result": <str>}.

    {"id": "...", "op": "neutralize_fence", "value": <str>}
        Calls neutralize_fence(value) and returns {"id": ..., "ok": true, "result": <str>}.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.review.fix_prompt_builder import (
    build_fix_prompt_deterministic,
    finding_id_for,
    neutralize_fence,
    severity_truncate,
)
from contracts.review_findings.v1 import ReviewFindingV1


def _findings(req: dict[str, Any]) -> tuple[ReviewFindingV1, ...]:
    return tuple(ReviewFindingV1(**d) for d in req["findings"])


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen builder and return its encoded result."""
    op = req["op"]
    if op == "build_deterministic":
        result = build_fix_prompt_deterministic(
            _findings(req),
            None,
            pr_number=req["pr_number"],
            truncated=req.get("truncated", False),
            total=req.get("total"),
            synthesized_themes=req.get("synthesized_themes"),
        )
        return {"id": req["id"], "ok": True, "result": result}
    if op == "severity_truncate":
        included, truncated = severity_truncate(
            _findings(req),
            max_findings=req["max_findings"],
            max_chars=req["max_chars"],
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": {"ids": [finding_id_for(f) for f in included], "truncated": truncated},
        }
    if op == "finding_id":
        return {"id": req["id"], "ok": True, "result": finding_id_for(ReviewFindingV1(**req["finding"]))}
    if op == "neutralize_fence":
        return {"id": req["id"], "ok": True, "result": neutralize_fence(req["value"])}
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
