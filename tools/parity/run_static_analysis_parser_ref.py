"""Static-analysis parser parity ref — emits the frozen Python parser's findings for one tool.

Invoked by `test/parity/static_analysis_parsers.parity.test.ts` (one spawn per tool) under the
frozen submodule's venv with cwd at `vendor/codemaster-py` so `import codemaster` resolves the
source-of-truth.

Usage (parse mode):
    python run_static_analysis_parser_ref.py parse <tool> <fixture_path> <workspace> <exit_code>

  <tool>        one of: ruff | eslint | gitleaks
  <fixture_path>  absolute path to a recorded tool-JSON fixture (the subprocess stdout)
  <workspace>   absolute workspace path (drives `_relative_to_workspace`)
  <exit_code>   the subprocess exit code to simulate (0/1 = success; >=2 = RunnerToolError)

Usage (filter mode — parse + changed-line filter through the frozen `filter_to_changed_lines`):
    python run_static_analysis_parser_ref.py filter <tool> <fixture_path> <workspace> <exit_code> <ranges_json>

  <ranges_json>  a JSON object mapping file → [[start,end], ...] (the ChangedLineRanges shape).

Emits to stdout a JSON array of the parsed (and, in filter mode, changed-line-filtered)
`AnalysisFindingV1`s with the non-deterministic `finding_id` and the constant `schema_version`
stripped (so the TS comparison is value-stable). On a RunnerToolError it emits
`{"error": "RunnerToolError", "exit_code": N}`.

This is a thin wrapper around the frozen `*_runner._parse_output` static methods +
`promotion.filter_to_changed_lines` — NOT a re-implementation. It exists only because those parsers
take a Pydantic `SubprocessResultV1` + a `Path`, which the generic JSONL oracle cannot construct
from JSON kwargs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from codemaster.analysis.eslint_runner import EslintInWorkerRunner, RunnerToolError
from codemaster.analysis.gitleaks_runner import GitleaksInWorkerRunner
from codemaster.analysis.in_worker_runner import SubprocessResultV1
from codemaster.analysis.promotion import filter_to_changed_lines
from codemaster.analysis.ruff_runner import RuffInWorkerRunner

_PARSERS = {
    "ruff": RuffInWorkerRunner._parse_output,
    "eslint": EslintInWorkerRunner._parse_output,
    "gitleaks": GitleaksInWorkerRunner._parse_output,
}


def _strip(findings) -> list[dict]:
    out = []
    for f in findings:
        d = f.model_dump(mode="json")
        d.pop("finding_id", None)
        d.pop("schema_version", None)
        out.append(d)
    return out


def main() -> int:
    mode = sys.argv[1]
    tool, fixture_path, workspace, exit_code_s = sys.argv[2:6]
    parse = _PARSERS[tool]
    # Substitute the committed-source-safe placeholder back to the real Slack-token bait — the literal is
    # never stored in the fixture (GitHub push-protection); the TS test loader does the same substitution.
    _slack_bait = "-".join(["xoxb", "1234567890123", "1234567890123", "aBcDeFgHiJkLmNoPqRsTuVwX"])
    stdout = Path(fixture_path).read_bytes().replace(b"__SLACK_BAIT_TOKEN__", _slack_bait.encode())
    result = SubprocessResultV1(
        exit_code=int(exit_code_s),
        stdout=stdout,
        stderr=b"",
        wall_ms=1,
    )
    try:
        findings = parse(result, workspace=Path(workspace))
    except RunnerToolError as e:
        print(json.dumps({"error": "RunnerToolError", "exit_code": e.exit_code}))
        return 0

    if mode == "filter":
        ranges_raw = json.loads(sys.argv[6])
        # JSON arrays → tuples of (start, end), matching the frozen ChangedLineRanges shape.
        ranges = {k: tuple(tuple(pair) for pair in v) for k, v in ranges_raw.items()}
        findings = filter_to_changed_lines(findings, ranges)

    print(json.dumps(_strip(findings)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
