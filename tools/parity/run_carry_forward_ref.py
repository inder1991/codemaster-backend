"""Long-lived parity driver for the frozen Python `_do_select` carry-forward selector.

Dedicated to the select-carry-forward entry point (do NOT fold into run_python_ref.py — the generic
runner calls `fn(**kwargs)` with a flat dict, but `_do_select` takes a constructed tuple of
`ReviewFindingV1` Pydantic instances, a constructed tuple of `DiffChunkV1` Pydantic instances, a
`dict[str, tuple[tuple[int, int], ...]]` change map, and a `uuid.UUID | None` parent id — none of which
survive a raw-dict kwargs splat. AND the result nests `ReviewFindingV1.confidence` (a bare float) which
the generic canonicalizing runner REJECTS). This driver reconstructs the inputs from their wire dicts,
drives the frozen `_do_select`, and emits the resulting `CarryForwardSelectionV1` via
`model_dump(mode="json")` so the TS port can diff the envelope (carried list + ORDER + to_review list +
ORDER + parent_review_id) — confidence floats stripped from the canonical compare on the TS side and
asserted structurally (the established bare-float handling).

`_do_select` is PURE deterministic line-range-overlap selection; no clock / random / DB / LLM, so the
selection is reproducible across runs and a byte-for-byte parity target.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "do_select",
     "parent_findings": [<ReviewFindingV1 wire dict>, ...],
     "current_chunks": [<DiffChunkV1 wire dict>, ...],
     "changed_line_ranges": {"<path>": [[start, end], ...], ...},
     "parent_review_id": "<uuid>" | null}
        Constructs each ReviewFindingV1(**dict) / DiffChunkV1(**dict), rebuilds the change map into the
        `dict[str, tuple[tuple[int, int], ...]]` shape `_do_select` expects (JSON has no tuples — inner
        [start, end] arrays are reconstituted into (start, end) tuples), runs
        `_do_select(parent_findings=..., current_chunks=..., changed_line_ranges=..., parent_review_id=...)`,
        and returns:
            {"id": "...", "ok": true, "result": <CarryForwardSelectionV1.model_dump(mode="json")>}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process — including INTENTIONALLY-malformed inputs the
adversarial test feeds to assert accept/reject parity.
"""

from __future__ import annotations

import json
import sys
import uuid
from typing import Any

from codemaster.review.carry_forward import _do_select
from contracts.diff_chunking.v1 import DiffChunkV1
from contracts.review_findings.v1 import ReviewFindingV1


def _rebuild_changed(raw: dict[str, Any]) -> dict[str, tuple[tuple[int, int], ...]]:
    """JSON has no tuple type — reconstitute the `[[s, e], ...]` arrays back into the
    `tuple[tuple[int, int], ...]` shape `_do_select`'s overlap walk expects."""
    out: dict[str, tuple[tuple[int, int], ...]] = {}
    for path, ranges in raw.items():
        out[path] = tuple((int(r[0]), int(r[1])) for r in ranges)
    return out


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `_do_select` and return its encoded result."""
    op = req["op"]
    if op == "do_select":
        parent_findings = tuple(ReviewFindingV1(**d) for d in req["parent_findings"])
        current_chunks = tuple(DiffChunkV1(**d) for d in req["current_chunks"])
        changed = _rebuild_changed(req["changed_line_ranges"])
        raw_parent = req["parent_review_id"]
        parent_review_id = None if raw_parent is None else uuid.UUID(raw_parent)
        result = _do_select(
            parent_findings=parent_findings,
            current_chunks=current_chunks,
            changed_line_ranges=changed,
            parent_review_id=parent_review_id,
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": result.model_dump(mode="json"),
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
