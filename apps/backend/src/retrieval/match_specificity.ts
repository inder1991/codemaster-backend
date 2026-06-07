// Port of `codemaster/retrieval/match_specificity.py` — the match-specificity bucket rendered in the
// confluence prompt frame (Sub-spec B T16). Pure; thresholds verbatim from spec §3.6 line 988.

/** high | medium | baseline — the bucket label rendered as `match_specificity="…"`. */
export type SpecificityBucket = "high" | "medium" | "baseline";

const HIGH_THRESHOLD = 8;
const MEDIUM_THRESHOLD = 4;

/** Bucket the integer match-specificity score into high/medium/baseline (1:1 with `specificity_bucket`). */
export function specificityBucket(score: number): SpecificityBucket {
  if (score >= HIGH_THRESHOLD) {
    return "high";
  }
  if (score >= MEDIUM_THRESHOLD) {
    return "medium";
  }
  return "baseline";
}
