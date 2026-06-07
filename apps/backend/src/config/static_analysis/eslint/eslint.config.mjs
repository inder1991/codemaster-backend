// codemaster's opinionated ESLint baseline (flat config).
//
// See docs/superpowers/plans/2026-05-16-bundled-static-analysis-configs.md
// for design rationale. Architect-approved rule selection (minimal):
// universal, high-signal, low-politics rules only. We deliberately do
// NOT extend @eslint/js/recommended — its presets carry stylistic /
// ecosystem-sensitive assumptions inappropriate for a platform reviewer.
//
// Memory: feedback_platform_owned_review_baseline.md — codemaster brings
// its own opinions; per-repo eslint config is irrelevant to bot review.

export default [
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // Bugs + dead code
      "no-unused-vars": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",

      // Security / dangerous patterns
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",

      // Style (cosmetic; only those that catch real bugs)
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
