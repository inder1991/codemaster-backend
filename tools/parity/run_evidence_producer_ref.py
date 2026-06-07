"""Long-lived parity driver for the frozen Python `build_retrieved_evidence`
(vendor/codemaster-py/codemaster/review/evidence_producer.py — the v10 R-12 provenance-backed
evidence manifest producer; the source-of-truth for the TS `buildRetrievedEvidence` activity port).

Dedicated to `codemaster.review.evidence_producer.build_retrieved_evidence` (do NOT fold into
run_python_ref.py — that generic runner calls `fn(**kwargs)` over a flat JSON kwargs dict, but
`build_retrieved_evidence` takes CONSTRUCTED Pydantic instances: `chunk: DiffChunkV1`,
`retrieved_knowledge: tuple[KnowledgeChunkV1, ...]`, `tier1_findings: tuple[AnalysisFindingV1, ...]`,
`tool_statuses: tuple[ToolStatusV1, ...]`, `pr_topology_manifest: tuple[PRTopologyEntryV1, ...]`. It
accesses model attributes (`chunk.body`, `k.doc_kind.value`, …), so raw dicts would AttributeError).

The producer is a PURE data transformation whose only side-effect is the deterministic UUIDv5
`mint_evidence_id` — so its output (the priority-ordered RetrievedEvidenceV1 tuple, with ev_ids and the
lowest-priority-first cap drop) is fully deterministic and byte-comparable against the TS port. No bare
floats in RetrievedEvidenceV1 (all str / uuid-string / Literal), so the result round-trips cleanly.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "build_retrieved_evidence",
     "chunk": {<DiffChunkV1 wire dict>},
     "retrieved_knowledge": [{<KnowledgeChunkV1 wire dict>}, ...],
     "tier1_findings":      [{<AnalysisFindingV1 wire dict>}, ...],
     "tool_statuses":       [{<ToolStatusV1 wire dict>}, ...],
     "pr_topology_manifest":[{<PRTopologyEntryV1 wire dict>}, ...],
     "max_entries": 100}
        Constructs each Pydantic instance, runs build_retrieved_evidence(...), and returns:
            {"id": "...", "ok": true,
             "result": {"entries": [<RetrievedEvidenceV1.model_dump(mode="json")>, ...]}}

Optional list fields default to [] when omitted; `max_entries` defaults to the producer's own default
(100) when omitted, exercising the same default the TS envelope applies.

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.review.evidence_producer import build_retrieved_evidence
from contracts.analysis_findings.v1 import AnalysisFindingV1
from contracts.diff_chunking.v1 import DiffChunkV1
from contracts.knowledge_chunks.v1 import KnowledgeChunkV1
from contracts.pr_topology.v1 import PRTopologyEntryV1
from contracts.tool_status.v1 import ToolStatusV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `build_retrieved_evidence` and return its encoded result."""
    op = req["op"]
    if op == "build_retrieved_evidence":
        chunk = DiffChunkV1(**req["chunk"])
        retrieved_knowledge = tuple(
            KnowledgeChunkV1(**d) for d in req.get("retrieved_knowledge", [])
        )
        tier1_findings = tuple(AnalysisFindingV1(**d) for d in req.get("tier1_findings", []))
        tool_statuses = tuple(ToolStatusV1(**d) for d in req.get("tool_statuses", []))
        pr_topology_manifest = tuple(
            PRTopologyEntryV1(**d) for d in req.get("pr_topology_manifest", [])
        )

        kwargs: dict[str, Any] = {
            "chunk": chunk,
            "retrieved_knowledge": retrieved_knowledge,
            "tier1_findings": tier1_findings,
            "tool_statuses": tool_statuses,
            "pr_topology_manifest": pr_topology_manifest,
        }
        if "max_entries" in req and req["max_entries"] is not None:
            kwargs["max_entries"] = req["max_entries"]

        entries = build_retrieved_evidence(**kwargs)
        return {
            "id": req["id"],
            "ok": True,
            "result": {"entries": [e.model_dump(mode="json") for e in entries]},
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
