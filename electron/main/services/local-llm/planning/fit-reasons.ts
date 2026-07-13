// Human-readable catalog for fit-contract.ts's closed `FitReasonCode` set (#78). Kept separate
// from the shared contract (which only owns the code *names*, since those are part of the
// Main/IPC-shared type surface) so the actual prose can be iterated on freely without touching a
// shared contract file. Pure string table — no logic, no state, trivially unit-testable via
// exhaustiveness (every FitReasonCode has an entry — enforced by the `Record<FitReasonCode, ...>`
// type itself failing to compile if a code is ever added to fit-contract.ts without a matching
// entry here).
import type { FitReasonCode } from "../../../../shared/local-llm/fit-contract";

export const FIT_REASON_DESCRIPTIONS: Record<FitReasonCode, string> = {
  FITS_COMFORTABLY: "Estimated memory use leaves a comfortable safety margin on this dimension.",
  FITS_WITH_DEFAULT_MARGIN: "Estimated memory use fits within the default safety margin.",
  FITS_WITH_REDUCED_MARGIN: "Estimated memory use only fits once the safety margin is reduced — close to the edge.",
  RAM_INSUFFICIENT: "Estimated memory use exceeds available system RAM even with no safety margin.",
  VRAM_INSUFFICIENT: "Estimated memory use exceeds available GPU VRAM even with no safety margin.",
  GPU_MEMORY_UNKNOWN: "GPU memory could not be determined, so GPU offload cannot be confirmed to fit; the verdict is capped at \"risky\".",
  NO_GPU_BACKEND_DETECTED: "No GPU backend was detected on this hardware; only CPU-only plans are possible.",
  CONTEXT_EXCEEDS_TRAIN_CONTEXT: "The requested context size exceeds the model's trained context length.",
  CONTEXT_CLAMPED_TO_TRAIN_CONTEXT: "The requested context size was clamped down to the model's trained context length.",
  GPU_LAYERS_EXCEED_MODEL_LAYERS: "The requested GPU layer count exceeds the model's total offloadable layers.",
  GPU_LAYERS_UNSUPPORTED_NO_GPU: "GPU layer offload was requested, but the resolved backend has no GPU offload support.",
  OVERRIDE_ACCEPTED: "The caller-supplied override was valid for this hardware/backend and was used as-is.",
  OVERRIDE_OUT_OF_RANGE: "The caller-supplied override was outside the valid range and was replaced with a resolved value.",
  OVERRIDE_BACKEND_UNAVAILABLE: "The caller-supplied backend override is not available on this hardware and was replaced with a resolved value.",
};

export function describeFitReason(code: FitReasonCode): string {
  return FIT_REASON_DESCRIPTIONS[code];
}

/** Stable, canonical ordering for a reasons array (most severe/decision-relevant first) — used by
 * fit-estimator.ts so `reasons` is deterministic regardless of the order individual checks
 * happened to run in, which matters for the "same input -> same output" determinism guarantee. */
const REASON_ORDER: readonly FitReasonCode[] = [
  "RAM_INSUFFICIENT",
  "VRAM_INSUFFICIENT",
  "CONTEXT_EXCEEDS_TRAIN_CONTEXT",
  "GPU_LAYERS_EXCEED_MODEL_LAYERS",
  "GPU_LAYERS_UNSUPPORTED_NO_GPU",
  "GPU_MEMORY_UNKNOWN",
  "NO_GPU_BACKEND_DETECTED",
  "CONTEXT_CLAMPED_TO_TRAIN_CONTEXT",
  "FITS_WITH_REDUCED_MARGIN",
  "FITS_WITH_DEFAULT_MARGIN",
  "FITS_COMFORTABLY",
  "OVERRIDE_OUT_OF_RANGE",
  "OVERRIDE_BACKEND_UNAVAILABLE",
  "OVERRIDE_ACCEPTED",
];

/** Dedupes and sorts a set of reason codes into REASON_ORDER. */
export function sortFitReasons(codes: readonly FitReasonCode[]): FitReasonCode[] {
  const unique = new Set(codes);
  return REASON_ORDER.filter((code) => unique.has(code));
}
