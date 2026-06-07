"""Long-lived parity driver for the frozen Python `CitationValidator.validate`
(the source-of-truth for the TS `citation_validate` activity port).

Dedicated to `codemaster.review.citation_validator.CitationValidator` (do NOT fold into
run_python_ref.py — that generic runner canonicalizes results and REJECTS bare floats, but
ReviewFindingV1 carries a `confidence` float that must survive verbatim; and the validator takes
constructed tuples of `ReviewFindingV1` Pydantic instances + a real on-disk workspace Path, not a flat
kwargs dict).

The validator's `_repo_path_exists` does REAL filesystem syscalls (Path.resolve/.exists/.is_file) — the
whole reason the call is an activity. So this driver runs against a REAL workspace directory the TS test
materializes on disk and passes as `workspace_path`; the Python resolves citation locators against it
exactly as the activity does in production. Both sides see the identical directory tree, so the
surviving/dropped partition is fully deterministic and byte-comparable.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "validate",
     "workspace_path": "<abs path to a real dir on disk>",
     "findings": [<ReviewFindingV1 wire dict>, ...],
     "knowledge_chunk_ids": null | [<id>, ...],
     "policy_citation": null | {<PolicyCitationContextV1 wire dict>}}
        Constructs CitationValidator(workspace=Path(workspace_path),
            knowledge_chunk_ids=None|frozenset(ids), policy_citation=None|PolicyCitationContextV1(...)),
        runs validate(tuple(ReviewFindingV1(**d) ...)), and returns the result envelope as:
            {"id": "...", "ok": true,
             "result": {"surviving": [<ReviewFindingV1.model_dump(mode="json")>, ...],
                        "dropped":   [<DroppedFindingV1.model_dump(mode="json")>, ...]}}

`knowledge_chunk_ids` is tri-stated EXACTLY as the production activity: JSON `null` → Python `None`
(skip-mode); a JSON array → `frozenset(...)` (strict membership). `policy_citation` JSON `null` → Python
`None` (skip-mode); a JSON object → `PolicyCitationContextV1(**obj)`.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from codemaster.review.citation_validator import CitationValidator
from contracts.policy_citation.v1 import PolicyCitationContextV1
from contracts.review_findings.v1 import ReviewFindingV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `CitationValidator.validate` and return its encoded result."""
    op = req["op"]
    if op == "validate":
        raw_ids = req.get("knowledge_chunk_ids")
        knowledge_chunk_ids = None if raw_ids is None else frozenset(raw_ids)

        raw_ctx = req.get("policy_citation")
        policy_citation = None if raw_ctx is None else PolicyCitationContextV1(**raw_ctx)

        validator = CitationValidator(
            workspace=Path(req["workspace_path"]),
            knowledge_chunk_ids=knowledge_chunk_ids,
            policy_citation=policy_citation,
        )
        findings = tuple(ReviewFindingV1(**d) for d in req["findings"])
        result = asyncio.run(validator.validate(findings))
        return {
            "id": req["id"],
            "ok": True,
            "result": {
                "surviving": [f.model_dump(mode="json") for f in result.surviving],
                "dropped": [d.model_dump(mode="json") for d in result.dropped],
            },
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
