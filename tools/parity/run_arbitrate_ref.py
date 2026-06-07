"""Long-lived parity driver for the frozen Python arbitration layer (`arbitrate`) + `ApplyArbitrationInput`.

Dedicated driver (do NOT fold into run_python_ref.py): `arbitrate` takes constructed tuples of Pydantic
instances + a `SuppressionPolicy` (not a flat kwargs dict), returns an `ArbitrationResult` whose
`rejected_intents` are plain `@dataclass` `RejectedIntent`s carrying a `Decimal | None` — neither a
`model_dump`-able model nor a JSON primitive. This driver hand-encodes the result so the TS port can be
proven byte-equal against the source-of-truth, and exposes a second op to round-trip the
`ApplyArbitrationInput` envelope for the contract-parity test.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under
the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import contracts`
resolve the source-of-truth.

Ops:

    {"id": "...", "op": "arbitrate",
     "tier1_findings": [<AnalysisFindingV1 wire dict>, ...],
     "tier2_findings": [[<uuid str>, <ReviewFindingV1 wire dict>], ...],
     "intents": [<ArbitrationIntentV1 wire dict>, ...],
     "model": "...", "prompt_version": "...", "now": "<RFC3339>"}
        Loads the BUNDLED policy, runs `arbitrate(...)`, returns:
            {"id": "...", "ok": true,
             "result": {"decisions": [<ArbitrationDecisionV1.model_dump(mode="json")>, ...],
                        "rejected_intents": [<hand-encoded RejectedIntent>, ...]}}

    {"id": "...", "op": "apply_arbitration_input", "payload": {<ApplyArbitrationInput kwargs>}}
        Constructs `ApplyArbitrationInput(**payload)` and returns
            {"id": "...", "ok": true, "result": <model_dump(mode="json")>}
        (or ok:false on a ValidationError — so the TS contract test can assert reject-parity).

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one bad
request never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from typing import Any

from codemaster.review.arbitration_apply_activity import ApplyArbitrationInput
from codemaster.review.arbitration_layer import arbitrate
from codemaster.review.suppression_policy import load_policy
from contracts.analysis_findings.v1 import AnalysisFindingV1
from contracts.arbitration_intent.v1 import ArbitrationIntentV1
from contracts.review_findings.v1 import ReviewFindingV1


def _encode_rejected(r: Any) -> dict[str, Any]:
    """Hand-encode a `RejectedIntent` dataclass: UUID→lowercase str, Decimal→str, None→null. Matches the
    TS RejectedIntent contract's wire shape (arbitration_result.v1.ts)."""
    return {
        "target_finding_id": str(r.target_finding_id),
        "reason_rejected": r.reason_rejected,
        "intent_confidence": (str(r.intent_confidence) if isinstance(r.intent_confidence, Decimal) else None),
        "intent_reason": r.intent_reason,
    }


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req["op"]
    if op == "arbitrate":
        tier1 = tuple(AnalysisFindingV1(**d) for d in req["tier1_findings"])
        tier2 = tuple((__import__("uuid").UUID(pair[0]), ReviewFindingV1(**pair[1])) for pair in req["tier2_findings"])
        intents = tuple(ArbitrationIntentV1(**d) for d in req["intents"])
        result = arbitrate(
            tier1_findings=tier1,
            tier2_findings=tier2,
            intents=intents,
            policy=load_policy(),
            model=req["model"],
            prompt_version=req["prompt_version"],
            now=__import__("datetime").datetime.fromisoformat(req["now"]),
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": {
                "decisions": [d.model_dump(mode="json") for d in result.decisions],
                "rejected_intents": [_encode_rejected(r) for r in result.rejected_intents],
            },
        }
    if op == "apply_arbitration_input":
        model = ApplyArbitrationInput(**req["payload"])
        return {"id": req["id"], "ok": True, "result": model.model_dump(mode="json")}
    if op == "load_policy":
        # Dump the BUNDLED suppression policy so the TS embedded literal can be proven byte-equal to the
        # frozen YAML's parsed+validated form (guards against drift in the embedded TS constant).
        return {"id": req["id"], "ok": True, "result": load_policy().model_dump(mode="json")}
    if op == "is_suppressible":
        from codemaster.review.suppression_policy import is_suppressible

        d = is_suppressible(
            policy=load_policy(),
            tool=req["tool"],
            rule_id=req["rule_id"],
            confidence=req["confidence"],
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": {"suppressible": d.suppressible, "min_confidence": d.min_confidence},
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
