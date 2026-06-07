"""Long-lived parity driver for the frozen Python `update_pr_description_summary` PURE helpers.

Dedicated to the update_pr_description_summary activity's deterministic surface — the strip+recompose +
the summary RENDER — so the TS port can be proven byte-equal against the source-of-truth. The GitHub
GET-modify-PATCH choreography itself is OUT OF SCOPE here (exercised separately on the TS side via a
cassette round-trip of the GitHubApiClient transport); this driver covers ONLY the pure transforms whose
exact bytes are load-bearing (the HTML-comment markers must round-trip across a mixed-version deploy).

  * `strip_existing_summary(body)` — remove a prior codemaster summary block in place (idempotency).
  * `build_summary_markdown(findings)` — render the markdown summary block (marker delimiters, the
    "## 🤖 Summary by codemaster" heading, the category breakdown with `str.title()` + Counter.most_common
    ordering).
  * `compose_new_body(original_body=..., summary_markdown=...)` — original-author content + summary.
  * marker constants (`_SUMMARY_START` / `_SUMMARY_END`) so the TS side pins the delimiter strings.

The findings ops operate on the IDENTICAL wire dict: the TS oracle serializes the wire shape its Zod
contracts produce, the Python side `model_validate`s the SAME dict — so the fixtures live only in TS.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under
the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import contracts`
resolve the source-of-truth.

Op kinds:

    {"id": "...", "op": "constants"}
        → {"id","ok":true,"summary_start":"<!-- codemaster-summary-start -->",
           "summary_end":"<!-- codemaster-summary-end -->"}

    {"id": "...", "op": "strip", "body": "<raw body>"}
        → {"id","ok":true,"stripped":"<strip_existing_summary(body)>"}

    {"id": "...", "op": "build_summary", "findings": [<ReviewFindingV1 wire dicts>]}
        Constructs each finding via ReviewFindingV1.model_validate, calls
        build_summary_markdown(tuple(findings)).
        → {"id","ok":true,"summary":"<exact markdown block>"}

    {"id": "...", "op": "compose", "original_body": "<raw>", "findings": [<wire dicts>]}
        Builds the summary from `findings` then calls compose_new_body(original_body=..., summary=...).
        → {"id","ok":true,"composed":"<exact composed body>"}

On any exception the driver emits {"id","ok":false,"err":"..."} and keeps running, so one bad request
never tears down the long-lived process.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from codemaster.activities.update_pr_description_summary import (
    _SUMMARY_END,
    _SUMMARY_START,
    build_summary_markdown,
    compose_new_body,
    strip_existing_summary,
)
from contracts.review_findings.v1 import ReviewFindingV1


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to a frozen helper and return its encoded result."""
    op = req["op"]
    if op == "constants":
        return {
            "id": req["id"],
            "ok": True,
            "summary_start": _SUMMARY_START,
            "summary_end": _SUMMARY_END,
        }
    if op == "strip":
        return {
            "id": req["id"],
            "ok": True,
            "stripped": strip_existing_summary(req["body"]),
        }
    if op == "build_summary":
        findings = tuple(ReviewFindingV1.model_validate(f) for f in req["findings"])
        return {
            "id": req["id"],
            "ok": True,
            "summary": build_summary_markdown(findings),
        }
    if op == "compose":
        findings = tuple(ReviewFindingV1.model_validate(f) for f in req["findings"])
        summary = build_summary_markdown(findings)
        return {
            "id": req["id"],
            "ok": True,
            "composed": compose_new_body(
                original_body=req["original_body"],
                summary_markdown=summary,
            ),
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
