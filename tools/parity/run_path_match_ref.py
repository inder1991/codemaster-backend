"""Long-lived parity driver for the frozen Python config path-matcher.

Dedicated to `codemaster/config/path_match.py`. The generic run_python_ref.py (which calls
`fn(**kwargs)`) suffices for `matches_glob` and `filter_review_paths` (both take plain kwargs), but
`match_path_instructions` requires a tuple of CONSTRUCTED `PathInstructionV1` Pydantic instances as
its `rules=` argument — a plain kwargs dict cannot stand in (the matcher reads `r.path` attribute
access on each rule). This driver reconstructs the models from the wire dicts and drives all three
entry points so the TS port compares against ONE source-of-truth process.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Ops:

    {"id": "...", "op": "matches_glob", "path": "<p>", "pattern": "<pat>"}
        → {"id": "...", "ok": true, "result": <bool>}

    {"id": "...", "op": "filter_review_paths", "paths": [...], "path_filters": [...]}
        → {"id": "...", "ok": true, "result": [<kept path>, ...]}

    {"id": "...", "op": "match_path_instructions",
        "path": "<chunk path>", "rules": [{"path": "...", "instructions": "..."}, ...]}
        → {"id": "...", "ok": true, "result": [{"path": "...", "instructions": "..."}, ...]}
          (the matched PathInstructionV1.model_dump(mode="json") dicts, in declaration order)

    {"id": "...", "op": "glob_regex", "pattern": "<pat>"}
        → {"id": "...", "ok": true, "result": "<compiled regex .pattern string>"}
          (white-box: lets the parity test pin the EXACT regex translation, not just match outcomes)

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.config.path_match import (
    _glob_to_regex,
    filter_review_paths,
    match_path_instructions,
    matches_glob,
)
from contracts.codemaster_config.v1 import PathInstructionV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen path-matcher and return its encoded result."""
    op = req["op"]
    if op == "matches_glob":
        result: Any = matches_glob(path=req["path"], pattern=req["pattern"])
    elif op == "filter_review_paths":
        kept = filter_review_paths(tuple(req["paths"]), tuple(req["path_filters"]))
        result = list(kept)
    elif op == "match_path_instructions":
        rules = tuple(PathInstructionV1(**r) for r in req["rules"])
        matched = match_path_instructions(path=req["path"], rules=rules)
        result = [m.model_dump(mode="json") for m in matched]
    elif op == "glob_regex":
        result = _glob_to_regex(req["pattern"]).pattern
    else:
        raise ValueError(f"unknown op: {op!r}")
    return {"id": req["id"], "ok": True, "result": result}


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
