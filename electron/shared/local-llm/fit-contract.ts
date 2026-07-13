// Shared Main-process-internal contract for the fit/runtime planning layer (#78). Pure data shapes
// only — see hardware-contract.ts's header comment for why this whole layer stays framework-free.
import type { HardwareProfile } from "./hardware-contract";

/** Bumped whenever fit-estimator.ts's memory formula or estimation-policy.ts's tier thresholds
 * change in a way that would make an old stored/logged estimate not directly comparable to a new
 * one (issue: "estimatorVersionを出力"). Every `FitEstimate` carries this verbatim. */
export const FIT_ESTIMATOR_VERSION = "local-llm-fit-estimator@1";

/** The issue's literal 4-tier verdict: "recommended(余裕あり)/possible(既定marginで収まる)/
 * risky(marginを削れば収まる)/unsupported(現実的な調整でも収まらない)". Ordered worst-to-best is
 * NOT the declaration order here (declaration order follows the issue's own prose) — see
 * estimation-policy.ts's `FIT_VERDICT_RANK` for the ordering actually used to combine verdicts. */
export type FitVerdict = "recommended" | "possible" | "risky" | "unsupported";

/** Structured reason codes (issue: "reason codeを出力... booleanだけでなく"). Every FitEstimate and
 * every OverrideResolution carries a non-empty subset of these rather than a free-text-only
 * explanation, so a caller (UI, logs, future automated retry logic) can branch on *why* without
 * string-matching prose. fit-reasons.ts (Main-process-only) holds the human-readable catalog for
 * these codes; this file only owns the closed set of code names. */
export type FitReasonCode =
  // -- verdict-driving margin outcomes (estimation-policy.ts) --
  | "FITS_COMFORTABLY"
  | "FITS_WITH_DEFAULT_MARGIN"
  | "FITS_WITH_REDUCED_MARGIN"
  | "RAM_INSUFFICIENT"
  | "VRAM_INSUFFICIENT"
  // -- GPU memory is a genuinely unknown quantity, not a zero one --
  | "GPU_MEMORY_UNKNOWN"
  | "NO_GPU_BACKEND_DETECTED"
  // -- context-size specific --
  | "CONTEXT_EXCEEDS_TRAIN_CONTEXT"
  | "CONTEXT_CLAMPED_TO_TRAIN_CONTEXT"
  // -- gpuLayers specific --
  | "GPU_LAYERS_EXCEED_MODEL_LAYERS"
  | "GPU_LAYERS_UNSUPPORTED_NO_GPU"
  // -- generic override validation (runtime-planner.ts) --
  | "OVERRIDE_ACCEPTED"
  | "OVERRIDE_OUT_OF_RANGE"
  | "OVERRIDE_BACKEND_UNAVAILABLE";

/** "model / KV cache / compute / overhead / safety marginを分離計算" — the issue's explicit
 * requirement that a memory estimate not collapse into a single "model file size" number. Safety
 * margin itself is not a byte quantity here (see estimation-policy.ts) — it's the headroom ratio
 * the verdict tiers are keyed on, applied on top of this breakdown's `totalBytes`. */
export type MemoryBreakdown = {
  modelBytes: number;
  kvCacheBytes: number;
  computeBufferBytes: number;
  overheadBytes: number;
  totalBytes: number;
};

export type MemoryAvailability = { status: "known"; availableBytes: number } | { status: "unknown" };

/** One side (RAM or VRAM) of a fit evaluation: how much this candidate plan needs from this
 * dimension, how much of it is actually available, and the resulting headroom ratio (`null` when
 * availability itself is unknown — never a fabricated number). */
export type DimensionFit = {
  requiredBytes: number;
  available: MemoryAvailability;
  headroomRatio: number | null;
};

/** GGUF fields fit-estimator.ts actually needs. Deliberately a narrow, planning-specific shape —
 * NOT node-llama-cpp's own `GgufFileInfo`/`GgufMetadata` (huge, format-version-coupled) and not a
 * re-export of gguf-metadata-reader.ts's `GgufHeaderResult` verbatim (that type's field names
 * mirror the raw GGUF key spelling; this one mirrors what the estimator's formula calls its
 * variables). A caller (e.g. local-llm-service.ts in a future issue) is expected to map from
 * GgufHeaderResult/InstalledModelEntry into this shape. */
export type FitModelInput = {
  modelId: string;
  displayName: string;
  /** GGUF file size on disk — see fit-estimator.ts's header comment for why this is used as the
   * model-weights memory proxy (and by how much it overestimates true tensor-only size). */
  sizeBytes: number;
  /** `{architecture}.context_length` — the model's trained context window. */
  trainContextSize: number;
  /** `{architecture}.block_count` — transformer layer count, NOT counting the output/embedding
   * layer (see runtime-planner.ts's header comment on `TOTAL_OFFLOADABLE_LAYERS_EXTRA`). */
  blockCount: number;
  /** `{architecture}.embedding_length` */
  embeddingLength: number;
  /** `{architecture}.attention.head_count` */
  attentionHeadCount: number;
  /** `{architecture}.attention.head_count_kv` — absent for classic multi-head attention (MHA)
   * architectures; defaults to `attentionHeadCount` when omitted (fit-estimator.ts's job, not the
   * caller's). */
  attentionHeadCountKv?: number;
};

/** The concrete runtime dimensions a candidate plan is being evaluated at — i.e. exactly the
 * `LoadModelInput.runtime`-shaped slots this whole layer exists to resolve `"auto"` for. */
export type RuntimeCandidate = {
  backend: string; // "cpu", or a GPU backend name matching HardwareProfile.gpu.backend?.name
  contextSize: number;
  gpuLayers: number;
  batchSize: number;
};

export type FitEstimate = {
  estimatorVersion: string;
  verdict: FitVerdict;
  breakdown: MemoryBreakdown;
  ram: DimensionFit;
  /** `null` when this candidate uses no GPU offload at all (`gpuLayers === 0`) — there is no VRAM
   * dimension to report on, which is a different thing from "VRAM dimension exists but is
   * unknown" (`vram.available.status === "unknown"`, when `gpuLayers > 0` and the hardware
   * profile's GPU memory reading is itself unknown). */
  vram: DimensionFit | null;
  reasons: FitReasonCode[];
};

export type FitEstimateInput = { model: FitModelInput; candidate: RuntimeCandidate; hardware: HardwareProfile };

/** A concrete, actionable alternative offered when a plan comes out "risky"/"unsupported" (issue:
 * "縮小context/GPU layers/CPU fallback/別model候補を返す"). Priority order in the array they're
 * returned in is documented and tested in runtime-planner.ts (issue: "suggestion優先順"). */
export type PlanAlternative =
  | { kind: "reduce-context"; contextSize: number; verdict: FitVerdict; description: string }
  | { kind: "reduce-gpu-layers"; gpuLayers: number; verdict: FitVerdict; description: string }
  | { kind: "cpu-fallback"; verdict: FitVerdict; description: string }
  | { kind: "smaller-model"; modelId: string; displayName: string; sizeBytes: number; description: string };

export type RuntimePlanOverrides = { backend?: string; contextSize?: number; gpuLayers?: number; batchSize?: number; threads?: number };

export type OverrideField = "backend" | "contextSize" | "gpuLayers" | "batchSize" | "threads";

/** One entry per field the caller actually supplied an override for (fields left on `"auto"` never
 * appear here — see runtime-planner.ts). `accepted: false` means `resolvedValue` was substituted
 * (clamped or replaced with the auto-computed value) instead of the caller's `requestedValue`. */
export type OverrideResolution = {
  field: OverrideField;
  requestedValue: number | string;
  accepted: boolean;
  resolvedValue: number | string;
  reason: FitReasonCode;
};

/** A lightweight, planning-layer-local view of an installed model — deliberately not a re-export
 * of model-contract.ts's `InstalledModelEntry` (that type carries download/import provenance this
 * layer has no use for); any `InstalledModelEntry` is structurally assignable to this. */
export type InstalledModelCandidate = { modelId: string; displayName: string; sizeBytes: number };

export type RuntimePlanInput = {
  model: FitModelInput;
  hardware: HardwareProfile;
  overrides?: RuntimePlanOverrides;
  /** Enables the "smaller-model" alternative (omit to skip it — never a hard requirement, since
   * an installed-models list may not be available to every caller). */
  installedModels?: InstalledModelCandidate[];
};

/** The resolved answer to every `"auto"` slot in `LoadModelInput.runtime` (#45), plus the fit
 * verdict/estimate that justifies it and concrete alternatives when it's not a comfortable fit. */
export type RuntimePlan = {
  estimatorVersion: string;
  backend: string;
  contextSize: number;
  gpuLayers: number;
  batchSize: number;
  threads: number;
  verdict: FitVerdict;
  estimate: FitEstimate;
  overrides: OverrideResolution[];
  alternatives: PlanAlternative[];
};
