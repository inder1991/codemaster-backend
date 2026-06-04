"""Long-lived parity driver for the frozen Python `_do_post_check_run` post-check-run orchestration.

Dedicated to the post-check-run entry point (do NOT fold into run_python_ref.py — the generic runner
canonicalizes a single flat result, whereas `_do_post_check_run` takes an injected `GhCheckRunClient` and
its observable behaviour is BOTH the returned `PostedCheckRunV1` AND the SEQUENCE of client calls it
issued — the find→update/create logic is only verifiable by recording that call sequence).

The real GitHub REST client is OUT OF SCOPE here (exercised separately on the TS side via a recording
stub of the GitHubApiClient transport). This driver injects a STUB `GhCheckRunClient` scripted with the
existing-check-run id (an int) or None, which records every method call (name + kwargs) so BOTH the Python
and TS sides drive the SAME stub and the orchestration is byte-verifiable WITHOUT any network round-trip.

One interpreter, many requests: read JSONL on stdin, emit one JSON line per request on stdout. Runs under
the frozen submodule's venv with cwd at vendor/codemaster-py so `import codemaster` / `import contracts`
resolve the source-of-truth.

Op kind:

    {"id": "...", "op": "do_post_check_run",
     "pr_meta": <PrMetaV1 wire dict>,              # threaded through unchanged (logic doesn't read it)
     "head_sha": "abc123",
     "summary": "All clear.",
     "owner": "octo",
     "repo_name": "hello-world",
     "existing": 4242 | null}                       # the id the stub's find_existing_check_run returns
        Runs `_do_post_check_run(pr_meta=..., head_sha=..., summary=..., owner=..., repo_name=...,
        gh_client=<stub>)` and returns:
            {"id": "...", "ok": true,
             "result": {"check_run_id": ..., "was_update": ...},
             "calls": [{"method": "find_existing_check_run", "kwargs": {...}}, ...]}

The summary-empty / head_sha-empty cases raise `ValueError` in the frozen helper → emitted as
{"id": "...", "ok": false, "err": "ValueError: ..."} (the TS side asserts its `doPostCheckRun` throws the
same-shaped error for the same input).

On any exception the driver emits {"id": "...", "ok": false, "err": "..."} and keeps running, so one bad
request never tears down the long-lived process.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Literal

from codemaster.activities.post_check_run import _do_post_check_run
from contracts.walkthrough.pr_meta_v1 import PrMetaV1


class _RecordingStubClient:
    """Deterministic stub mirroring the `GhCheckRunClient` Protocol. `find_existing_check_run` returns the
    caller-scripted `existing` (an int or None); `create`/`update` no-op (create returns a fixed new id).
    Every call is appended to `self.calls` as {"method": <name>, "kwargs": {<kw>: <val>}} so the find→
    update/create SEQUENCE is byte-verifiable across the Python and TS sides. NO network."""

    NEW_CHECK_RUN_ID = 7777

    def __init__(self, *, existing: int | None) -> None:
        self._existing = existing
        self.calls: list[dict[str, Any]] = []

    async def find_existing_check_run(
        self,
        *,
        owner: str,
        repo: str,
        head_sha: str,
        name: str,
    ) -> int | None:
        self.calls.append(
            {
                "method": "find_existing_check_run",
                "kwargs": {"owner": owner, "repo": repo, "head_sha": head_sha, "name": name},
            }
        )
        return self._existing

    async def create_check_run(
        self,
        *,
        owner: str,
        repo: str,
        head_sha: str,
        name: str,
        status: Literal["completed", "in_progress"],
        conclusion: Literal["neutral"],
        summary: str,
    ) -> int:
        self.calls.append(
            {
                "method": "create_check_run",
                "kwargs": {
                    "owner": owner,
                    "repo": repo,
                    "head_sha": head_sha,
                    "name": name,
                    "status": status,
                    "conclusion": conclusion,
                    "summary": summary,
                },
            }
        )
        return self.NEW_CHECK_RUN_ID

    async def update_check_run(
        self,
        *,
        owner: str,
        repo: str,
        check_run_id: int,
        status: Literal["completed", "in_progress"],
        conclusion: Literal["neutral"],
        summary: str,
    ) -> None:
        self.calls.append(
            {
                "method": "update_check_run",
                "kwargs": {
                    "owner": owner,
                    "repo": repo,
                    "check_run_id": check_run_id,
                    "status": status,
                    "conclusion": conclusion,
                    "summary": summary,
                },
            }
        )


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen `_do_post_check_run` and return its encoded result + calls."""
    op = req["op"]
    if op == "do_post_check_run":
        pr_meta = PrMetaV1.model_validate(req["pr_meta"])
        existing = req.get("existing")
        stub = _RecordingStubClient(existing=existing)
        result = asyncio.run(
            _do_post_check_run(
                pr_meta=pr_meta,
                head_sha=req["head_sha"],
                summary=req["summary"],
                owner=req["owner"],
                repo_name=req["repo_name"],
                gh_client=stub,  # type: ignore[arg-type]
            )
        )
        return {
            "id": req["id"],
            "ok": True,
            "result": {"check_run_id": result.check_run_id, "was_update": result.was_update},
            "calls": stub.calls,
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
