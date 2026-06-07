// classifiers — port of the frozen Python file-classifier stage (Sub-spec B T2):
//   vendor/codemaster-py/codemaster/retrieval/detection/classifiers/generated.py::classify_generated
//   vendor/codemaster-py/codemaster/retrieval/detection/classifiers/vendored.py::classify_vendored
//   vendor/codemaster-py/codemaster/retrieval/detection/classifiers/test.py::classify_test
//   vendor/codemaster-py/codemaster/retrieval/detection/classifiers/classify_files.py::classify_files
//
// Stage-1 of the detection pipeline (spec §3.5 line 369-371). Walks `PRContext.changed_files` and
// rebuilds it with the `classification` field populated from the per-classifier outputs. Pure functions
// — replay-safe (no I/O, no clock, no random).

import type { ChangedFile, FileClassification, PRContext } from "#contracts/pr_context.v1.js";

/** One classifier pattern: a regex + the reason string emitted on first match. */
type ClassifierPattern = readonly [RegExp, string];

// ─── Generated-file patterns (1:1 with Python `_GENERATED_PATTERNS`) ───────────────────────────────
// Order matters only for the `reason` attribution — the first-matching pattern wins.
const GENERATED_PATTERNS: ReadonlyArray<ClassifierPattern> = [
  // protobuf
  [/\.pb\.go$/, "protobuf-go"],
  [/_pb2(?:_grpc)?\.py$/, "protobuf-py"],
  [/\.pb\.(cc|h)$/, "protobuf-cpp"],
  // codegen by-product
  [/\.gen\.(ts|tsx|js|jsx|go|py|rs)$/, "codegen-suffix"],
  [/\.generated\.(ts|tsx|js|jsx)$/, "codegen-dotgenerated"],
  // minified
  [/\.min\.(js|css|mjs)$/, "minified"],
  // auto-generated typedefs / source maps
  [/\.d\.ts$/, "typescript-declaration"],
  [/\.map$/, "source-map"],
  // mocks/stubs commonly generated
  [/(?:^|\/)mocks?\/.*_mock\.go$/, "go-mockgen"],
  [/_generated\.go$/, "go-generate"],
  // OpenAPI client / GraphQL codegen
  [/(?:^|\/)generated\//, "generated-dir"],
  [/(?:^|\/)__generated__\//, "double-underscore-generated"],
];

// ─── Vendored-file patterns (1:1 with Python `_VENDORED_PATTERNS`) ─────────────────────────────────
const VENDORED_PATTERNS: ReadonlyArray<ClassifierPattern> = [
  // More-specific patterns first so reason attribution is precise.
  [/(?:^|\/)vendor\/bundle\//, "bundler-vendor"],
  [/(?:^|\/)vendor\//, "vendor-dir"],
  [/(?:^|\/)node_modules\//, "node_modules"],
  [/(?:^|\/)third_party\//, "third_party"],
  [/(?:^|\/)3rdparty\//, "3rdparty"],
  [/(?:^|\/)vendored\//, "vendored-dir"],
  [/(?:^|\/)\.venv\//, "python-virtualenv"],
  [/(?:^|\/)\.tox\//, "python-tox"],
  [/(?:^|\/)Godeps\//, "godeps"],
];

// ─── Test-file patterns (1:1 with Python `_TEST_PATTERNS`) ─────────────────────────────────────────
const TEST_PATTERNS: ReadonlyArray<ClassifierPattern> = [
  // Path-segment matches
  [/(?:^|\/)tests?\//, "tests-dir"],
  [/(?:^|\/)__tests__\//, "double-underscore-tests"],
  [/(?:^|\/)e2e\//, "e2e-dir"],
  [/(?:^|\/)cypress\//, "cypress-dir"],
  [/(?:^|\/)specs?\//, "spec-dir"],
  // Filename-suffix matches
  [/_test\.(go|py|js|ts|tsx|jsx|rb)$/, "underscore-test-suffix"],
  [/(?:^|\/)test_[^/]+\.py$/, "python-test-prefix"],
  [/\.test\.(js|jsx|ts|tsx|mjs)$/, "dot-test-suffix"],
  [/\.spec\.(js|jsx|ts|tsx|mjs)$/, "dot-spec-suffix"],
  // JVM ecosystem
  [/Tests?\.(java|kt|kts)$/, "jvm-test-suffix"],
  [/Spec\.(scala|kt)$/, "jvm-spec-suffix"],
];

/** First-matching pattern → `[true, reason]`; no match → `[false, null]` (Python `classify_*`). */
function classify(path: string, patterns: ReadonlyArray<ClassifierPattern>): readonly [boolean, string | null] {
  for (const [rx, reason] of patterns) {
    if (rx.test(path)) {
      return [true, reason] as const;
    }
  }
  return [false, null] as const;
}

/** Return `(is_generated, reason)` (1:1 with Python `classify_generated`). */
export function classifyGenerated(path: string): readonly [boolean, string | null] {
  return classify(path, GENERATED_PATTERNS);
}

/** Return `(is_vendored, reason)` (1:1 with Python `classify_vendored`). */
export function classifyVendored(path: string): readonly [boolean, string | null] {
  return classify(path, VENDORED_PATTERNS);
}

/** Return `(is_test, reason)` (1:1 with Python `classify_test`). */
export function classifyTest(path: string): readonly [boolean, string | null] {
  return classify(path, TEST_PATTERNS);
}

/**
 * Return a new PRContext with every ChangedFile's classification populated (1:1 with Python
 * `classify_files`). Pre-existing non-default classifications on the input are preserved verbatim —
 * never silently overwritten.
 */
export function classifyFiles(ctx: PRContext): PRContext {
  const newFiles: Array<ChangedFile> = [];
  for (const f of ctx.changed_files) {
    if (f.classification.is_generated || f.classification.is_vendored || f.classification.is_test) {
      // Already classified upstream; preserve verbatim.
      newFiles.push(f);
      continue;
    }

    const [isGen, genReason] = classifyGenerated(f.path);
    const [isVnd, vndReason] = classifyVendored(f.path);
    const [isTst, tstReason] = classifyTest(f.path);

    // Reason attribution precedence: vendored > generated > test (Python comment) — order only affects
    // the debug string; detectors check the individual flags independently.
    let reason: string | null;
    if (isVnd) {
      reason = vndReason;
    } else if (isGen) {
      reason = genReason;
    } else if (isTst) {
      reason = tstReason;
    } else {
      reason = null;
    }

    const classification: FileClassification = {
      is_generated: isGen,
      is_vendored: isVnd,
      is_test: isTst,
      reason,
    };
    newFiles.push({ ...f, classification });
  }

  return { ...ctx, changed_files: newFiles };
}
