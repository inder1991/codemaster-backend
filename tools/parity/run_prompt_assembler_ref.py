"""Long-lived parity driver for the frozen Python prompt assembler.

Dedicated to ``codemaster.review.prompt_assembler.assemble_prompt`` (do NOT fold into
run_python_ref.py — that generic runner calls ``fn(**kwargs)`` with plain JSON kwargs, but
``assemble_prompt`` requires a constructed ``ResolvedGuidanceBundleV1`` Pydantic instance plus a tuple
of ``ScoredKnowledgeChunkV1`` instances, not raw dicts). This driver reconstructs the models from the
wire dicts, calls the frozen ``assemble_prompt``, and emits the ``AssembledPromptV1`` via
``model_dump(mode="json")`` so the TS port compares the envelope byte-for-byte.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so ``import codemaster`` /
``import contracts`` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "assemble_prompt",
     "policy_bundle": {<ResolvedGuidanceBundleV1 fields>} | null,
     "knowledge_results": [{<ScoredKnowledgeChunkV1 fields>}, ...],
     "total_budget_tokens": 4000,   # optional; omit → contract default
     "policy_max_tokens": 3000}     # optional; omit → contract default
        Constructs the models, calls assemble_prompt(...), then assert_prompt_safety(result).
        Response:
            {"id": "...", "ok": true, "assembled": <AssembledPromptV1.model_dump(mode="json")>}

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.review.prompt_assembler import (
    DEFAULT_POLICY_MAX_TOKENS,
    DEFAULT_TOTAL_BUDGET_TOKENS,
    assemble_prompt,
    assert_prompt_safety,
)
from contracts.knowledge_chunks.v1 import ScoredKnowledgeChunkV1
from contracts.resolved_guidance.v1 import ResolvedGuidanceBundleV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen assemble_prompt and return its encoded result."""
    op = req["op"]
    if op == "assemble_prompt":
        raw_bundle = req.get("policy_bundle")
        bundle = (
            ResolvedGuidanceBundleV1(**raw_bundle) if raw_bundle is not None else None
        )
        knowledge = tuple(
            ScoredKnowledgeChunkV1(**k) for k in req.get("knowledge_results", [])
        )
        total_budget = req.get("total_budget_tokens", DEFAULT_TOTAL_BUDGET_TOKENS)
        policy_max = req.get("policy_max_tokens", DEFAULT_POLICY_MAX_TOKENS)
        assembled = assemble_prompt(
            policy_bundle=bundle,
            knowledge_results=knowledge,
            total_budget_tokens=total_budget,
            policy_max_tokens=policy_max,
        )
        # The assembler enforces the never-drop invariant structurally; assert it here so the parity
        # driver fails loudly if a future frozen-source change breaks it (defense-in-depth, matches
        # the Python unit-test surface).
        assert_prompt_safety(assembled)
        return {
            "id": req["id"],
            "ok": True,
            "assembled": assembled.model_dump(mode="json"),
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
