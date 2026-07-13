// Pure memory-fit estimator (#78). Given a GGUF model's architecture metadata, a candidate runtime
// configuration, and an already-detected HardwareProfile, estimates how much memory loading that
// model would need and whether it fits — WITHOUT ever loading the model or touching
// "node-llama-cpp". Every function here is a plain function of its arguments: no I/O, no clock,
// no randomness, which is what makes "same input -> same output" (issue: "同一入力で決定的な
// plan") trivially true and lets estimator/planner be unit-tested with zero native dependency
// (issue acceptance criterion).
//
// -------------------------------------------------------------------------------------------
// Formula shape and assumptions (issue: "research the real formula... or use a well-reasoned
// approximation and document your formula's assumptions clearly")
// -------------------------------------------------------------------------------------------
// Investigated node-llama-cpp@3.19.0's own `GgufInsights` (node_modules/node-llama-cpp/dist/gguf/
// insights/GgufInsights.js) as the ground truth for what real memory-fit estimation looks like —
// see local-llm-planning-native-comparison.test.mjs for a real, running comparison against it.
// This estimator deliberately does NOT call into GgufInsights (it requires a `Llama` instance,
// which requires loading the native addon — even its own "slim, no backend" fallback
// (`getLlamaWithoutBackend()`) does — which would break this layer's "no native model load"
// requirement), but its formula shapes inform this one:
//
//  - modelBytes: the GGUF file's size on disk. `GgufInsights.modelSize` sums only the tensor
//    payload (excluding the header/KV-metadata section), so this over-estimates by that section's
//    size — negligible for any real multi-GB model, more visible on tiny fixtures (verified:
//    ~14KB metadata overhead on the 1.16MB stories260K.gguf fixture, ~1.2%). Chosen anyway because
//    it needs zero GGUF tensor-table parsing beyond what gguf-metadata-reader.ts already does.
//
//  - kvCacheBytes: matches llama.cpp's own documented source, `llama_kv_cache_init` — confirmed by
//    reading GgufInsights.js's `_estimateContextCacheMemorySplitInBytes` comment ("source:
//    `llama_kv_cache_init` in `llama.cpp`"). Per-layer KV cache size is
//    `2 (K and V) * n_head_kv * head_dim * contextSize * bytesPerElement`, summed over
//    `blockCount` transformer layers. `head_dim = embedding_length / attention_head_count`.
//    `bytesPerElement` defaults to 2 (F16) for both K and V, matching node-llama-cpp's own
//    `kvCacheKeyType`/`kvCacheValueType` defaults — this estimator does not attempt to model a
//    caller requesting quantized KV cache (Q8_0/Q4_0/...), which would need a runtime-candidate
//    field this layer doesn't have yet.
//
//  - computeBufferBytes: llama.cpp's real per-architecture graph/activation overhead calculation
//    (GgufInsights.js's `estimateContextResourceRequirements`) is genuinely architecture-specific —
//    dozens of hand-tuned magic constants per model family (llama/qwen2/gemma/stablelm/phi3/...).
//    Reproducing that exactly is out of scope for a "pure, well-reasoned approximation" estimator;
//    instead this uses a simple, documented proxy: `batchSize * embedding_length * 4 bytes (fp32) *
//    ACTIVATION_TENSOR_MULTIPLIER`, where the multiplier (8) is a rough stand-in for "a handful of
//    concurrently-live intermediate tensors per forward pass" (QKV projections, attention scores,
//    FFN intermediate activations, residual copies). Verified in the comparison test to land in
//    the same order of magnitude as GgufInsights's real number for the checked-in fixture, not to
//    match it exactly — see that test file for the actual numbers and the documented tolerance.
//
//  - overheadBytes: a flat allowance for tokenizer tables, node-llama-cpp/llama.cpp allocator
//    bookkeeping, and general process overhead that scales with neither context size nor batch
//    size. Chosen as a fixed 256 MiB — a round, conservative number, not derived from measurement
//    of a specific model family. Intentionally the largest single component of the breakdown for
//    genuinely tiny models (like the 1.16MB fixture) — this estimator is tuned to be reasonable
//    for realistic (multi-hundred-MB-to-multi-GB) local models, not toy fixtures.
//
//  - GPU/CPU split for partial offload: model weight bytes and KV cache bytes are split
//    proportionally to `gpuLayers / totalOffloadableLayers` between VRAM and RAM. This is a linear
//    approximation — real per-tensor allocation is not perfectly uniform across layers (verified
//    against GgufInsights: a small fixed amount, e.g. the token embedding matrix, can remain
//    CPU-resident even at full GPU offload) — but is the simplest formula that respects "some
//    layers on GPU, the rest on CPU" without needing full per-tensor placement logic.
//    `computeBufferBytes` is counted entirely against VRAM once `gpuLayers > 0` (the compute graph
//    runs primarily on whichever backend is doing inference); `overheadBytes` (host process
//    bookkeeping) always counts against RAM regardless of backend.
import { classifyHeadroom, worseVerdict } from "./estimation-policy";
import { sortFitReasons } from "./fit-reasons";
import { FIT_ESTIMATOR_VERSION } from "../../../../shared/local-llm/fit-contract";
import type { DimensionFit, FitEstimate, FitEstimateInput, FitModelInput, FitReasonCode, FitVerdict, MemoryBreakdown, RuntimeCandidate } from "../../../../shared/local-llm/fit-contract";
import type { HardwareProfile } from "../../../../shared/local-llm/hardware-contract";

/** node-llama-cpp's own default KV cache element type is F16 for both key and value caches (see
 * this file's header comment) — 2 bytes per element. */
export const KV_CACHE_BYTES_PER_ELEMENT = 2;
/** Flat process/runtime overhead allowance — see header comment. */
export const RUNTIME_OVERHEAD_BYTES = 256 * 1024 * 1024;
/** fp32 activation element size used by the compute-buffer approximation. */
export const ACTIVATION_BYTES_PER_ELEMENT = 4;
/** Rough stand-in for "how many concurrently-live activation tensors per forward pass" — see
 * header comment. */
export const ACTIVATION_TENSOR_MULTIPLIER = 8;
/** `GgufInsights.totalLayers` (node-llama-cpp) = `block_count + 1` — the `+1` is the model's
 * output/embedding layer, which is independently offloadable alongside the `block_count`
 * transformer layers. Mirrored here (confirmed against the real stories260K.gguf fixture:
 * `block_count: 5`, `GgufInsights.totalLayers: 6`) so this estimator's `gpuLayers` range matches
 * what a real `LlamaModelOptions.gpuLayers` value would mean. */
export const OUTPUT_LAYER_COUNT = 1;

export function totalOffloadableLayers(model: Pick<FitModelInput, "blockCount">): number {
  return Math.max(0, model.blockCount) + OUTPUT_LAYER_COUNT;
}

/** "model / KV cache / compute / overhead を分離計算" — see this file's header comment for each
 * component's formula and its documented assumptions. */
export function computeMemoryBreakdown(model: FitModelInput, candidate: RuntimeCandidate): MemoryBreakdown {
  const headCountKv = model.attentionHeadCountKv ?? model.attentionHeadCount;
  const headDim = model.attentionHeadCount > 0 ? model.embeddingLength / model.attentionHeadCount : 0;

  const modelBytes = Math.max(0, model.sizeBytes);
  const kvCacheBytes = 2 * Math.max(0, model.blockCount) * Math.max(0, headCountKv) * Math.max(0, headDim) * Math.max(0, candidate.contextSize) * KV_CACHE_BYTES_PER_ELEMENT;
  const computeBufferBytes = Math.max(1, candidate.batchSize) * Math.max(0, model.embeddingLength) * ACTIVATION_BYTES_PER_ELEMENT * ACTIVATION_TENSOR_MULTIPLIER;
  const overheadBytes = RUNTIME_OVERHEAD_BYTES;

  return { modelBytes, kvCacheBytes, computeBufferBytes, overheadBytes, totalBytes: modelBytes + kvCacheBytes + computeBufferBytes + overheadBytes };
}

function headroomRatio(availableBytes: number, requiredBytes: number): number {
  if (availableBytes <= 0) return requiredBytes <= 0 ? 0 : -1;
  return (availableBytes - requiredBytes) / availableBytes;
}

function reasonForVerdict(verdict: FitVerdict, insufficientCode: "RAM_INSUFFICIENT" | "VRAM_INSUFFICIENT"): FitReasonCode {
  if (verdict === "unsupported") return insufficientCode;
  if (verdict === "risky") return "FITS_WITH_REDUCED_MARGIN";
  if (verdict === "possible") return "FITS_WITH_DEFAULT_MARGIN";
  return "FITS_COMFORTABLY";
}

/** True when the hardware profile reports a backend that can actually receive GPU-offloaded
 * layers (i.e. NOT `null` and NOT the "cpu" backend native-loader.ts reports for
 * `llama.gpu === false`). Exported for runtime-planner.ts, which needs the same check when
 * resolving `"auto"` backend/gpuLayers. */
export function hasGpuOffloadSupport(hardware: HardwareProfile): boolean {
  return hardware.gpu.backend !== null && hardware.gpu.backend.supportsGpuOffload;
}

/** Estimates whether `candidate` fits on `hardware` for `model`, and how comfortably. Never
 * throws, never mutates its arguments, never reads a clock or the filesystem — see this file's
 * header comment. */
export function estimateFit(input: FitEstimateInput): FitEstimate {
  const { model, candidate, hardware } = input;
  const breakdown = computeMemoryBreakdown(model, candidate);
  const reasons: FitReasonCode[] = [];

  const totalLayers = totalOffloadableLayers(model);
  const requestedGpuLayers = Math.max(0, candidate.gpuLayers);
  if (requestedGpuLayers > totalLayers) reasons.push("GPU_LAYERS_EXCEED_MODEL_LAYERS");
  const clampedGpuLayers = Math.min(requestedGpuLayers, totalLayers);
  const usesGpu = clampedGpuLayers > 0;

  if (candidate.contextSize > model.trainContextSize) reasons.push("CONTEXT_EXCEEDS_TRAIN_CONTEXT");

  // A caller/override requesting GPU layers on hardware that genuinely cannot offload at all
  // (no backend, or the "cpu" backend) is a structurally impossible plan, independent of memory —
  // there is no device to place those layers on. This is reported and forced to "unsupported"
  // before any VRAM arithmetic, rather than silently falling back to a CPU-only memory estimate
  // that would misrepresent what was actually asked for.
  if (usesGpu && !hasGpuOffloadSupport(hardware)) {
    reasons.push("GPU_LAYERS_UNSUPPORTED_NO_GPU");
    const ramRequiredBytes = breakdown.totalBytes; // treat as fully CPU-resident for reporting purposes
    const ram: DimensionFit = { requiredBytes: ramRequiredBytes, available: { status: "known", availableBytes: hardware.ram.availableBytes }, headroomRatio: headroomRatio(hardware.ram.availableBytes, ramRequiredBytes) };
    return { estimatorVersion: FIT_ESTIMATOR_VERSION, verdict: "unsupported", breakdown, ram, vram: null, reasons: sortFitReasons(reasons) };
  }

  const gpuFraction = totalLayers > 0 ? clampedGpuLayers / totalLayers : 0;

  const ramRequiredBytes = breakdown.overheadBytes + breakdown.modelBytes * (1 - gpuFraction) + breakdown.kvCacheBytes * (1 - gpuFraction) + (usesGpu ? 0 : breakdown.computeBufferBytes);
  const ramHeadroom = headroomRatio(hardware.ram.availableBytes, ramRequiredBytes);
  const ramVerdict = classifyHeadroom(ramHeadroom);
  const ram: DimensionFit = { requiredBytes: ramRequiredBytes, available: { status: "known", availableBytes: hardware.ram.availableBytes }, headroomRatio: ramHeadroom };
  reasons.push(reasonForVerdict(ramVerdict, "RAM_INSUFFICIENT"));

  let overallVerdict = ramVerdict;
  let vram: DimensionFit | null = null;

  if (usesGpu) {
    const vramRequiredBytes = breakdown.modelBytes * gpuFraction + breakdown.kvCacheBytes * gpuFraction + breakdown.computeBufferBytes;
    if (hardware.gpu.memory.status === "known") {
      const vramAvailableBytes = hardware.gpu.memory.freeBytes;
      const vramHeadroom = headroomRatio(vramAvailableBytes, vramRequiredBytes);
      const vramVerdict = classifyHeadroom(vramHeadroom);
      vram = { requiredBytes: vramRequiredBytes, available: { status: "known", availableBytes: vramAvailableBytes }, headroomRatio: vramHeadroom };
      reasons.push(reasonForVerdict(vramVerdict, "VRAM_INSUFFICIENT"));
      overallVerdict = worseVerdict(overallVerdict, vramVerdict);
    } else {
      // "GPU memory不明を`unknown`として保持" — never coerced to a number, and never coerced to a
      // verdict better than "risky": we genuinely do not know whether this fits, so this can never
      // read as "recommended"/"possible", but it is also never marked "unsupported" purely because
      // the reading is missing (that would be exactly the "unknown treated as 0" misjudgment the
      // issue explicitly forbids — RAM_INSUFFICIENT/VRAM_INSUFFICIENT/unsupported must come from an
      // actual known shortfall, not an absent reading).
      vram = { requiredBytes: vramRequiredBytes, available: { status: "unknown" }, headroomRatio: null };
      reasons.push("GPU_MEMORY_UNKNOWN");
      overallVerdict = worseVerdict(overallVerdict, "risky");
    }
  } else if (!hasGpuOffloadSupport(hardware)) {
    reasons.push("NO_GPU_BACKEND_DETECTED");
  }

  // A context size beyond what the model was trained on is not just a memory question — the
  // model's positional encoding was never trained for those positions. This estimator has no
  // knowledge of RoPE scaling/context-extension techniques, so it conservatively blocks rather
  // than silently reporting a memory-only verdict for a configuration that may not work at all.
  if (candidate.contextSize > model.trainContextSize) overallVerdict = worseVerdict(overallVerdict, "unsupported");

  return { estimatorVersion: FIT_ESTIMATOR_VERSION, verdict: overallVerdict, breakdown, ram, vram, reasons: sortFitReasons(reasons) };
}
