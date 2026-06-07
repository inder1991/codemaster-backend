// Unit tests for precedence — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/precedence.py (Sub-spec B T7).
// priorityTier / deriveAuthority / deriveDocType. Pure-function tests.

import { describe, expect, it } from "vitest";

import {
  deriveAuthority,
  deriveDocType,
  PriorityTier,
  priorityTier,
  type PriorityClassifiable,
} from "#backend/retrieval/precedence.js";

function pc(args: {
  labels?: ReadonlyArray<string>;
  source?: string;
  docKind?: string | null;
}): PriorityClassifiable {
  return {
    labels: args.labels ?? [],
    source: args.source ?? "confluence",
    doc_kind: args.docKind ?? null,
  };
}

describe("priorityTier", () => {
  it("topic:security_policy → SECURITY_POLICY (highest, wins over everything)", () => {
    expect(priorityTier(pc({ labels: ["topic:security_policy", "lang:python"] }))).toBe(
      PriorityTier.SECURITY_POLICY,
    );
  });

  it("repo_knowledge + doc_kind=adr → REPO_ADR", () => {
    expect(priorityTier(pc({ source: "repo_knowledge", docKind: "adr" }))).toBe(PriorityTier.REPO_ADR);
  });

  it("adr doc_kind but NOT repo_knowledge source → not REPO_ADR (falls through)", () => {
    expect(priorityTier(pc({ source: "confluence", docKind: "adr", labels: ["framework:react"] }))).toBe(
      PriorityTier.FRAMEWORK_GUIDANCE,
    );
  });

  it("framework:* label → FRAMEWORK_GUIDANCE", () => {
    expect(priorityTier(pc({ labels: ["framework:react"] }))).toBe(PriorityTier.FRAMEWORK_GUIDANCE);
  });

  it("lang:* label → LANG_GUIDANCE", () => {
    expect(priorityTier(pc({ labels: ["lang:python"] }))).toBe(PriorityTier.LANG_GUIDANCE);
  });

  it("framework outranks lang when both present", () => {
    expect(priorityTier(pc({ labels: ["lang:python", "framework:django"] }))).toBe(
      PriorityTier.FRAMEWORK_GUIDANCE,
    );
  });

  it("no recognized label → DEFAULT_ONLY", () => {
    expect(priorityTier(pc({ labels: ["default", "topic:performance"] }))).toBe(PriorityTier.DEFAULT_ONLY);
  });
});

describe("deriveAuthority", () => {
  it("maps each tier to its authority class", () => {
    expect(deriveAuthority(PriorityTier.SECURITY_POLICY)).toBe("mandatory");
    expect(deriveAuthority(PriorityTier.REPO_ADR)).toBe("authoritative");
    expect(deriveAuthority(PriorityTier.FRAMEWORK_GUIDANCE)).toBe("advisory");
    expect(deriveAuthority(PriorityTier.LANG_GUIDANCE)).toBe("advisory");
    expect(deriveAuthority(PriorityTier.DEFAULT_ONLY)).toBe("advisory");
  });
});

describe("deriveDocType", () => {
  it("topic:security_policy → security_policy", () => {
    expect(deriveDocType(["topic:security_policy", "lang:python"], "confluence")).toBe("security_policy");
  });

  it("doc_kind=adr → adr", () => {
    expect(deriveDocType([], "repo_knowledge", "adr")).toBe("adr");
  });

  it("framework:* → framework_guidance", () => {
    expect(deriveDocType(["framework:react"], "confluence")).toBe("framework_guidance");
  });

  it("lang:* → language_guidance", () => {
    expect(deriveDocType(["lang:go"], "confluence")).toBe("language_guidance");
  });

  it("otherwise → general_best_practice", () => {
    expect(deriveDocType(["default"], "confluence")).toBe("general_best_practice");
  });
});
