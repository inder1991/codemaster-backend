// detectors — port of the frozen Python label detectors (Sub-spec B T3-T6):
//   vendor/codemaster-py/codemaster/retrieval/detection/detectors/base.py::LabelDetector (Protocol)
//   vendor/codemaster-py/codemaster/retrieval/detection/detectors/language.py::LanguageDetector
//   vendor/codemaster-py/codemaster/retrieval/detection/detectors/framework.py::FrameworkDetector
//   vendor/codemaster-py/codemaster/retrieval/detection/detectors/infra.py::InfraDetector
//
// Each detector is a pure function over PRContext: no I/O, no clock, no random; order-independent
// (a detector MUST NOT read another detector's output). Each emits ONLY labels in its own namespace.

import { FRAMEWORK_MAPPINGS } from "#backend/retrieval/detection/framework_mappings.js";

import type { PRContext } from "#contracts/pr_context.v1.js";

/**
 * Protocol that all label-emitting detectors satisfy (Python `LabelDetector` Protocol).
 *   - `name`: bounded telemetry label (`language` / `framework` / `infra`).
 *   - `version`: per-detector mapping version (bumps when emitted labels change).
 *   - `namespacePrefix`: the only namespace the detector may emit (Python `NAMESPACE_PREFIX` ClassVar).
 *   - `detect(ctx)`: emit canonical labels for `ctx`. Pure, order-independent.
 */
export type LabelDetector = {
  name: string;
  version: number;
  namespacePrefix: string;
  detect(ctx: PRContext): ReadonlySet<string>;
};

// ─── LanguageDetector (T4) ─────────────────────────────────────────────────────────────────────────

/**
 * Extension → canonical lang label (1:1 with Python `_EXTENSION_TO_LANG_LABEL`). NOT a framework hint:
 * `.tsx` does NOT imply React.
 *
 * EXPORTED so the platform-labels ceiling (`platform_labels.ts`) can union its values — 1:1 with the
 * Python `_build_platform_exposed_labels` reading `_EXTENSION_TO_LANG_LABEL.values()`.
 */
export const EXTENSION_TO_LANG_LABEL: Readonly<Record<string, string>> = {
  ".py": "lang:python",
  ".pyi": "lang:python",
  ".ts": "lang:typescript",
  ".tsx": "lang:typescript",
  ".js": "lang:javascript",
  ".jsx": "lang:javascript",
  ".mjs": "lang:javascript",
  ".cjs": "lang:javascript",
  ".go": "lang:go",
  ".java": "lang:java",
  ".kt": "lang:kotlin",
  ".kts": "lang:kotlin",
  ".rs": "lang:rust",
  ".rb": "lang:ruby",
  ".scala": "lang:scala",
  ".cs": "lang:csharp",
  ".cpp": "lang:cpp",
  ".cc": "lang:cpp",
  ".cxx": "lang:cpp",
  ".c": "lang:c",
  ".h": "lang:c",
  ".hpp": "lang:cpp",
  ".swift": "lang:swift",
  ".php": "lang:php",
};

/**
 * Return the file suffix including the leading dot, lowercased — 1:1 with Python
 * `pathlib.Path(path).suffix.lower()`. Python `PurePath.suffix` is the substring from the LAST dot in
 * the final path component, but ONLY when that dot is not the leading char of the name (a dotfile like
 * `.gitignore` has an EMPTY suffix; `archive.tar.gz` → `.gz`).
 */
function fileSuffix(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  // Python: a leading-dot name (dotfile, dot===0) OR no dot → empty suffix.
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot).toLowerCase();
}

/** Emits only `lang:*` labels via file-extension mapping (1:1 with Python `LanguageDetector`). */
export class LanguageDetector implements LabelDetector {
  public readonly name = "language";
  public readonly version = 1;
  public readonly namespacePrefix = "lang:";

  public detect(ctx: PRContext): ReadonlySet<string> {
    const out = new Set<string>();
    for (const f of ctx.changed_files) {
      const cls = f.classification;
      if (cls.is_generated || cls.is_vendored) {
        continue;
      }
      const ext = fileSuffix(f.path);
      const label: unknown = Reflect.get(EXTENSION_TO_LANG_LABEL, ext);
      if (typeof label === "string") {
        out.add(label);
      }
    }
    return out;
  }
}

// ─── FrameworkDetector (T5) ──────────────────────────────────────────────────────────────────────────

const DEP_TO_FRAMEWORK = FRAMEWORK_MAPPINGS;

// Per-record weight by `ParsedDependencyV1.dependency_type` (Python `_TYPE_WEIGHTS`).
const TYPE_WEIGHTS: Readonly<Record<string, number>> = {
  prod: 1.0,
  dev: 0.6,
  optional: 0.4,
  test: 0.4,
  unknown: 0.3,
};

/** Confidence for legacy `parsed_dependencies` string-list entries (Python `_LEGACY_LIST_CONFIDENCE`). */
const LEGACY_LIST_CONFIDENCE = 0.5;

/** Multi-manifest agreement boost (Python `_MULTI_MANIFEST_BOOST` / `_MULTI_MANIFEST_CAP`). */
const MULTI_MANIFEST_BOOST = 0.05;
const MULTI_MANIFEST_CAP = 0.15;

function frameworkLabelFor(depName: string): string | undefined {
  const label: unknown = Reflect.get(DEP_TO_FRAMEWORK, depName);
  return typeof label === "string" ? label : undefined;
}

/** Per-record weight for a dependency_type, defaulting to the "unknown" weight (Python `_TYPE_WEIGHTS.get`). */
function typeWeight(dependencyType: string): number {
  const weight: unknown = Reflect.get(TYPE_WEIGHTS, dependencyType);
  return typeof weight === "number" ? weight : TYPE_WEIGHTS["unknown"]!;
}

/** Emits only `framework:*` labels from manifest dependencies (1:1 with Python `FrameworkDetector`). */
export class FrameworkDetector implements LabelDetector {
  public readonly name = "framework";
  public readonly version = 1;
  public readonly namespacePrefix = "framework:";

  public detect(ctx: PRContext): ReadonlySet<string> {
    const out = new Set<string>();
    for (const manifest of ctx.manifests) {
      // Prefer the new typed records when populated; their names are canonical-normalized (ADR-0058)
      // so the lookup key is already canonical.
      if (manifest.parsed_dependency_records.length > 0) {
        for (const record of manifest.parsed_dependency_records) {
          const label = frameworkLabelFor(record.name);
          if (label !== undefined) {
            out.add(label);
          }
        }
        continue;
      }
      // Legacy back-compat: pre-parser callers surface the string list.
      for (const dep of manifest.parsed_dependencies) {
        const label = frameworkLabelFor(dep.toLowerCase());
        if (label !== undefined) {
          out.add(label);
        }
      }
    }
    return out;
  }

  /**
   * Closes FOLLOW-UP-framework-detector-confidence-score (1:1 with Python `detect_with_confidence`).
   * Returns a mapping of every label `detect(ctx)` would emit → a confidence score in [0.0, 1.0].
   *
   * Within a single manifest the maximum-weight occurrence wins; across manifests the maximum weight
   * is taken THEN the multi-manifest boost is layered on. Pure / deterministic.
   */
  public detectWithConfidence(ctx: PRContext): Record<string, number> {
    const perManifestMax = new Map<string, Array<number>>();

    for (const manifest of ctx.manifests) {
      const localMax = new Map<string, number>();

      if (manifest.parsed_dependency_records.length > 0) {
        for (const record of manifest.parsed_dependency_records) {
          const label = frameworkLabelFor(record.name);
          if (label === undefined) {
            continue;
          }
          const weight = typeWeight(record.dependency_type);
          if (weight > (localMax.get(label) ?? 0)) {
            localMax.set(label, weight);
          }
        }
      } else {
        for (const dep of manifest.parsed_dependencies) {
          const label = frameworkLabelFor(dep.toLowerCase());
          if (label === undefined) {
            continue;
          }
          if (LEGACY_LIST_CONFIDENCE > (localMax.get(label) ?? 0)) {
            localMax.set(label, LEGACY_LIST_CONFIDENCE);
          }
        }
      }

      for (const [label, weight] of localMax) {
        const list = perManifestMax.get(label) ?? [];
        list.push(weight);
        perManifestMax.set(label, list);
      }
    }

    const out = new Map<string, number>();
    for (const [label, weights] of perManifestMax) {
      const base = Math.max(...weights);
      const boost = Math.min((weights.length - 1) * MULTI_MANIFEST_BOOST, MULTI_MANIFEST_CAP);
      out.set(label, Math.min(1.0, base + boost));
    }
    return Object.fromEntries(out);
  }
}

// ─── InfraDetector (T6) ──────────────────────────────────────────────────────────────────────────────

// EXPORTED so the platform-labels ceiling (`platform_labels.ts`) can union the emitted labels — 1:1 with
// the Python `_build_platform_exposed_labels` reading `(label for _rx, label in _INFRA_PATTERNS)`.
export const INFRA_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Terraform
  [/\.tf$/, "infra:terraform"],
  [/\.tfvars$/, "infra:terraform"],
  // Helm
  [/(?:^|\/)Chart\.ya?ml$/, "infra:helm"],
  // eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen Python regex; the optional `(?:[._-][\w.-]+)?` group consumes ≥1 leading separator + a bounded `[\w.-]+` run before the anchored `\.ya?ml$` tail — no overlapping/ambiguous quantifiers, no catastrophic backtracking (heuristic false positive)
  [/(?:^|\/)values(?:[._-][\w.-]+)?\.ya?ml$/, "infra:helm"],
  // Docker
  // eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen Python regex; the optional `(?:\.[\w.-]+)?` suffix is a single bounded `[\w.-]+` run anchored by `$`, with no overlapping quantifiers — no catastrophic backtracking (heuristic false positive)
  [/(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/, "infra:docker"],
  [/\.dockerfile$/, "infra:docker"],
  // Kustomize
  [/(?:^|\/)kustomization\.ya?ml$/, "infra:kustomize"],
  // Kubernetes (path-based heuristic)
  [/(?:^|\/)k8s\/.+\.ya?ml$/, "infra:kubernetes"],
  [/(?:^|\/)kubernetes\/.+\.ya?ml$/, "infra:kubernetes"],
  [/(?:^|\/)manifests\/.+\.ya?ml$/, "infra:kubernetes"],
  // CI / pipeline
  [/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/, "infra:github-actions"],
  [/(?:^|\/)\.gitlab-ci\.ya?ml$/, "infra:gitlab-ci"],
  [/(?:^|\/)\.circleci\/config\.ya?ml$/, "infra:circleci"],
  [/(?:^|\/)azure-pipelines\.ya?ml$/, "infra:azure-pipelines"],
];

/** Emits only `infra:*` labels via path-based matching (1:1 with Python `InfraDetector`). */
export class InfraDetector implements LabelDetector {
  public readonly name = "infra";
  public readonly version = 1;
  public readonly namespacePrefix = "infra:";

  public detect(ctx: PRContext): ReadonlySet<string> {
    const out = new Set<string>();
    for (const f of ctx.changed_files) {
      const cls = f.classification;
      if (cls.is_generated || cls.is_vendored) {
        continue;
      }
      for (const [rx, label] of INFRA_PATTERNS) {
        if (rx.test(f.path)) {
          out.add(label);
          break;
        }
      }
    }
    return out;
  }
}
