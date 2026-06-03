"""Long-lived Tier-A parity ref process: read JSONL requests on stdin, emit canonical JSON per line.

One interpreter, many calls (avoids ~200-500ms cold start per assertion). Runs under the frozen
submodule's venv with cwd at vendor/codemaster-py so `import codemaster` resolves the source-of-truth.

Request line:  {"id": "...", "module": "codemaster.chunking.markdown_chunker", "callable": "chunk_markdown", "kwargs": {...}}
Response line: {"id": "...", "ok": true, "out": <canonical-json-string>}  OR  {"id": "...", "ok": false, "err": "..."}

Tier-A (pure functions) ONLY. Impure subsystems (classify=Magika ML, cost-cap=DB+locks) use Tier-B
integration parity, NOT this process.
"""

from __future__ import annotations

import importlib
import json
import sys
import re
from decimal import Decimal
from enum import Enum
from typing import Any

# Datetime instant-parity: normalize RFC3339 to `.ffffff+00:00` (IDENTICAL transform to the TS
# canonicalizer test/parity/canonical.ts). Reconciles Pydantic's verbatim `str` datetime fields
# (often Z) with its `datetime` fields (.ffffff+00:00). UTC assumed; non-UTC offsets kept as-is.
_DT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$")


def _norm_dt(obj: Any) -> Any:
    if isinstance(obj, str):
        m = _DT_RE.match(obj)
        if m:
            frac = (m.group(2) or "").ljust(6, "0")[:6]
            offset = "+00:00" if m.group(3) == "Z" else m.group(3)
            return f"{m.group(1)}.{frac}{offset}"
        return obj
    if isinstance(obj, list):
        return [_norm_dt(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _norm_dt(v) for k, v in obj.items()}
    return obj


def _to_jsonable(result: Any) -> Any:
    if hasattr(result, "model_dump"):
        return result.model_dump(mode="json")
    if isinstance(result, Enum):
        return result.value
    if isinstance(result, (tuple, list)):
        return [_to_jsonable(x) for x in result]
    if isinstance(result, dict):
        return {k: _to_jsonable(v) for k, v in result.items()}
    return result


def _canonical(obj: Any) -> str:
    # Match the TS canonicalizer: datetime -> `.ffffff+00:00`, Decimal -> string, sort keys, tight separators.
    obj = _norm_dt(obj)

    def default(o: Any) -> Any:
        if isinstance(o, Decimal):
            return str(o)
        raise TypeError(repr(o))

    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=default)


def main() -> int:
    cache: dict[str, Any] = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            key = req["module"]
            mod = cache.get(key) or cache.setdefault(key, importlib.import_module(key))
            fn = getattr(mod, req["callable"])
            result = fn(**req.get("kwargs", {}))
            out = _canonical(_to_jsonable(result))
            sys.stdout.write(json.dumps({"id": req["id"], "ok": True, "out": out}) + "\n")
        except Exception as e:  # report, never crash the long-lived process
            sys.stdout.write(
                json.dumps({"id": req["id"], "ok": False, "err": f"{type(e).__name__}: {e}"}) + "\n"
            )
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
