"""Long-lived parity driver for the frozen Python `dedup_linter_with_llm` (the linter↔LLM dedup stage).

Dedicated to `codemaster.analysis.dedup_with_llm.dedup_linter_with_llm` (do NOT fold into
run_python_ref.py — that generic runner canonicalizes results and REJECTS bare floats, but
ReviewFindingV1 carries a `confidence` float that must survive verbatim; and `dedup_linter_with_llm`
takes constructed tuples of `ReviewFindingV1` Pydantic instances + an embedder, not a flat kwargs dict).

This driver drives the frozen function with a FAILING embedder so the semantic stage takes the
deterministic fail-open skip path — matching the TS port's no-embedder seam (the orchestrator calls it
with `embedder=None` in the frozen Python workflow body; the real embedder lives in the activity
runtime). With a failing embedder the dedup output is fully deterministic (exact-match dedupe only),
so the TS port can be proven byte-equal against the source-of-truth.

`dedup_linter_with_llm` returns a bare `tuple[ReviewFindingV1, ...]` (it does NOT surface the
semantic-skip flag — it logs it). So this driver emits ONLY the findings list. The TS test asserts the
findings byte-equality against this ref, and asserts the TS-side `semantic_skipped` observable
structurally (the envelope field the activity adds; there is no Python counterpart for it).

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs
under the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` /
`import contracts` resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "dedup_linter_with_llm",
     "linter_findings": [<ReviewFindingV1 wire dict>, ...],
     "llm_findings": [<ReviewFindingV1 wire dict>, ...]}
        Constructs each ReviewFindingV1(**dict), runs
        dedup_linter_with_llm(linter_findings=..., llm_findings=..., embedder=<failing>), and returns:
            {"id": "...", "ok": true,
             "result": {"findings": [<ReviewFindingV1.model_dump(mode="json")>, ...]}}

The embedder is a stub whose `.embed` always raises `EmbeddingsError`, forcing `aggregate_semantic`'s
fail-open branch (combined with its `len(findings) < 2` early return, the dedup is deterministic).

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one
bad request never tears down the long-lived process.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from codemaster.adapters.embeddings_port import EmbeddingsError
from codemaster.analysis.dedup_with_llm import dedup_linter_with_llm
from contracts.review_findings.v1 import ReviewFindingV1


class _FailingEmbedder:
    """Embedder stub whose every call raises `EmbeddingsError` — forces `aggregate_semantic`'s
    fail-open skip branch, matching the TS port's no-embedder seam exactly."""

    async def embed(self, req: Any) -> Any:  # noqa: ANN401 — stub mirrors the Port signature
        raise EmbeddingsError("parity driver: no embedder (forced skip path)")


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `dedup_linter_with_llm` and return its encoded result."""
    op = req["op"]
    if op == "dedup_linter_with_llm":
        linter = tuple(ReviewFindingV1(**d) for d in req["linter_findings"])
        llm = tuple(ReviewFindingV1(**d) for d in req["llm_findings"])
        result = asyncio.run(
            dedup_linter_with_llm(
                linter_findings=linter,
                llm_findings=llm,
                embedder=_FailingEmbedder(),  # type: ignore[arg-type]
            )
        )
        return {
            "id": req["id"],
            "ok": True,
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
