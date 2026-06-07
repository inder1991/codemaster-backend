/**
 * `_relative_to_workspace` — shared helper duplicated verbatim across the three frozen-Python runners
 * (`ruff_runner.py`, `eslint_runner.py`, `gitleaks_runner.py`). Hoisted here so the TS port has one
 * copy; the behaviour is byte-identical to each Python copy.
 *
 * Returns `filePath` relative to `workspace` when it is inside the workspace; otherwise (Python's
 * `ValueError` from `Path.relative_to`) passes the path through with a leading-slash strip
 * (`file_path.lstrip("/")`). An empty `filePath` maps to "".
 */

import { isAbsolute, relative } from "node:path";

/** Return `filePath` relative to `workspace`, or a leading-slash-stripped passthrough. */
export function relativeToWorkspace(filePath: string, workspace: string): string {
  if (!filePath) return "";
  // Python `Path(file_path).relative_to(workspace)` raises ValueError when `file_path` is not under
  // `workspace`. `path.relative` instead returns a `../`-prefixed path in that case; we detect the
  // not-under-workspace case and fall back to the Python passthrough (lstrip "/").
  const rel = relative(workspace, filePath);
  const notUnderWorkspace = rel === "" || rel.startsWith("..") || isAbsolute(rel);
  if (notUnderWorkspace) {
    return stripLeadingSlashes(filePath);
  }
  return rel;
}

/** Python `str.lstrip("/")` — strip ALL leading "/" characters (not just one). */
function stripLeadingSlashes(s: string): string {
  let i = 0;
  // `s[i]` is a length-bounded numeric index into a local string, not an attacker-controlled object
  // key — the security rule's prototype-pollution threat model does not apply.
  // eslint-disable-next-line security/detect-object-injection
  while (i < s.length && s[i] === "/") i += 1;
  return s.slice(i);
}
