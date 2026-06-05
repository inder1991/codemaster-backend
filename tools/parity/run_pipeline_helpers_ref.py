"""Long-lived parity driver for the frozen Python pipeline pure-helpers.

Dedicated to the seven workflow-sandbox-safe pure helpers the TS port reproduces:

  From codemaster.workflows.review_pull_request:
    * _stage_outcome_for_publication
    * _fix_prompt_stage_outcome
    * _resolve_degraded_payload
    * _config_change_notice_finding
    * _compose_orchestrator_degradation_note
  From codemaster.workflows.review_pipeline_orchestrator:
    * _path_filters_excluded_all_finding
    * _infer_pr_topology_kind

Importing the workflow module pulls temporalio (available in the frozen submodule's venv) but only the
PURE module-level functions are exercised — no workflow runtime is started, so the import is the lightest
faithful drive. (If temporalio import ever becomes unavailable, fall back to importing only the leaf
helpers via their definitions.)

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under
the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import contracts`
resolve the source-of-truth.

Op kinds (the `op` field selects the helper):

  {"id": "...", "op": "stage_outcome_for_publication", "outcome": <null | "inline_posted" | ...>}
      -> {"id": ..., "ok": true, "result": "<ok|fallback>"}

  {"id": "...", "op": "fix_prompt_stage_outcome", "generated": <bool>, "generation_mode": "<str>"}
      -> {"id": ..., "ok": true, "result": "<skipped|ok|fallback>"}

  {"id": "...", "op": "resolve_degraded_payload", "outcome": <null | "body_only_posted" | ...>,
   "kept_rfids": ["<uuid-str>", ...]}
      -> {"id": ..., "ok": true, "result": {"rfids": ["<uuid-str>", ...], "outcome_value": <null | str>}}

  {"id": "...", "op": "config_change_notice_finding"}
      -> {"id": ..., "ok": true, "result": <ReviewFindingV1.model_dump(mode="json")>}

  {"id": "...", "op": "path_filters_excluded_all_finding"}
      -> {"id": ..., "ok": true, "result": <ReviewFindingV1.model_dump(mode="json")>}

  {"id": "...", "op": "infer_pr_topology_kind", "path": "<str>"}
      -> {"id": ..., "ok": true, "result": "<test|doc|config|code|other>"}

  {"id": "...", "op": "compose_orchestrator_degradation_note", "notes": ["<str>", ...],
   "prior_note": <null | str>}
      -> {"id": ..., "ok": true, "result": <null | str>}

The two ReviewFindingV1 dumps carry a BARE FLOAT `confidence` (0.99). The TS canonicalizer rejects bare
floats, so the TS parity test STRIPS `confidence` before the canonical compare and asserts it structurally
+ by range — exactly the established review-findings gotcha (the dumped float repr differs between Python
and JS). The Python driver emits the model_dump verbatim; the stripping is a TS-side concern.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one bad
request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
import uuid
from typing import Any

from contracts.posted_review.v1 import PublicationOutcome

from codemaster.workflows.review_pipeline_orchestrator import (
    ReviewPipelineResult,
    _infer_pr_topology_kind,
    _path_filters_excluded_all_finding,
)
from codemaster.workflows.review_pull_request import (
    _PostReviewCapture,
    _build_analyzed_payload,
    _compose_orchestrator_degradation_note,
    _config_change_notice_finding,
    _fix_prompt_stage_outcome,
    _resolve_degraded_payload,
    _stage_outcome_for_publication,
)


def _outcome_or_none(value: Any) -> PublicationOutcome | None:
    """Map a wire-string (or null) to a PublicationOutcome enum (or None)."""
    if value is None:
        return None
    return PublicationOutcome(value)


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the named frozen helper and return its encoded result."""
    op = req["op"]
    if op == "stage_outcome_for_publication":
        return _ok(req, _stage_outcome_for_publication(_outcome_or_none(req.get("outcome"))))
    if op == "fix_prompt_stage_outcome":
        return _ok(
            req,
            _fix_prompt_stage_outcome(
                generated=req["generated"], generation_mode=req["generation_mode"]
            ),
        )
    if op == "resolve_degraded_payload":
        kept = tuple(uuid.UUID(s) for s in req.get("kept_rfids", []))
        rfids, outcome_value = _resolve_degraded_payload(_outcome_or_none(req.get("outcome")), kept)
        return _ok(req, {"rfids": [str(x) for x in rfids], "outcome_value": outcome_value})
    if op == "config_change_notice_finding":
        return _ok(req, _config_change_notice_finding().model_dump(mode="json"))
    if op == "path_filters_excluded_all_finding":
        return _ok(req, _path_filters_excluded_all_finding().model_dump(mode="json"))
    if op == "infer_pr_topology_kind":
        return _ok(req, _infer_pr_topology_kind(req["path"]))
    if op == "compose_orchestrator_degradation_note":
        return _ok(
            req,
            _compose_orchestrator_degradation_note(
                notes=tuple(req.get("notes", [])), prior_note=req.get("prior_note")
            ),
        )
    if op == "build_analyzed_payload":
        # The patched branch is the only one the gate-collapsed TS port reproduces, so the ref always
        # passes patched=True (the unpatched v7-A baseline shape is dead code in the new workflow type).
        capture = _PostReviewCapture(
            publication_outcome=_outcome_or_none(req.get("publication_outcome")),
            degradation_notes=tuple(req.get("capture_degradation_notes", [])),
        )
        pipeline_notes = req.get("pipeline_degradation_notes")
        pipeline_result = (
            None
            if pipeline_notes is None
            else ReviewPipelineResult(
                status="accepted",
                head_sha=req["head_sha"],
                findings_count=req["findings_count"],
                walkthrough=None,
                aggregated=None,
                file_routing=None,
                static_analysis=None,
                carry_forward=None,
                classifier_failure_ratio=0.0,
                degradation_notes=tuple(pipeline_notes),
            )
        )
        return _ok(
            req,
            _build_analyzed_payload(
                findings_count=req["findings_count"],
                head_sha=req["head_sha"],
                posted_review_capture=capture,
                pipeline_result=pipeline_result,
                patched=True,
            ),
        )
    raise ValueError(f"unknown op: {op!r}")


def _ok(req: dict[str, Any], result: Any) -> dict[str, Any]:
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
