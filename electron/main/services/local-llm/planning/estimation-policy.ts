// The 4-tier verdict policy (#78): "recommended(余裕あり)/possible(既定marginで収まる)/
// risky(marginを削れば収まる)/unsupported(現実的な調整でも収まらない)". Pure functions over plain
// numbers only — this file never reads hardware or GGUF metadata itself; fit-estimator.ts is the
// only caller, so classification thresholds live in exactly one place.
import type { FitVerdict } from "../../../../shared/local-llm/fit-contract";

/** Headroom ratio is `(available - required) / available`. A ratio of `0.25` means the plan uses
 * 75% of available memory, leaving 25% spare. Thresholds are inclusive lower bounds — exactly
 * `0.25` is "recommended", exactly `0.10` is "possible", exactly `0` is "risky" (fits with zero
 * spare margin), anything negative is "unsupported" (doesn't fit at all). These are deliberately
 * simple round numbers, not derived from a specific llama.cpp/OS source — documented here as the
 * estimator's own policy choice, versioned via FIT_ESTIMATOR_VERSION so a future tuning pass is
 * distinguishable from this one in any stored/logged estimate. */
export const FIT_MARGIN_THRESHOLDS = {
  recommended: 0.25,
  possible: 0.1,
} as const;

const FIT_VERDICT_RANK: Record<FitVerdict, number> = { unsupported: 0, risky: 1, possible: 2, recommended: 3 };

/** Classifies a single dimension's headroom ratio into a verdict tier. */
export function classifyHeadroom(headroomRatio: number): FitVerdict {
  if (headroomRatio >= FIT_MARGIN_THRESHOLDS.recommended) return "recommended";
  if (headroomRatio >= FIT_MARGIN_THRESHOLDS.possible) return "possible";
  if (headroomRatio >= 0) return "risky";
  return "unsupported";
}

/** Returns whichever of the two verdicts is worse (lower-ranked) — used to combine a RAM-dimension
 * verdict with a VRAM-dimension verdict (a plan is only as good as its worst-fitting resource),
 * and to "cap" a verdict at a ceiling (e.g. `worseVerdict(ramVerdict, "risky")` implements "never
 * report better than risky when GPU memory is unknown", per the issue's explicit ban on
 * misjudging an unknown GPU memory reading). */
export function worseVerdict(a: FitVerdict, b: FitVerdict): FitVerdict {
  return FIT_VERDICT_RANK[a] <= FIT_VERDICT_RANK[b] ? a : b;
}

export function verdictRank(verdict: FitVerdict): number {
  return FIT_VERDICT_RANK[verdict];
}

/** True when `candidate` is at least as good as `floor` (e.g. `meetsOrBetter(verdict, "possible")`
 * is the "good enough to stop searching for a smaller alternative" check runtime-planner.ts's
 * alternative-search loops use). */
export function meetsOrBetter(candidate: FitVerdict, floor: FitVerdict): boolean {
  return FIT_VERDICT_RANK[candidate] >= FIT_VERDICT_RANK[floor];
}
