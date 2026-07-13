// Runtime plan generation (#78): resolves the concrete values a caller loading a model would need
// for every `"auto"` slot in #45's `LoadModelInput.runtime`-shaped configuration (backend,
// contextSize, gpuLayers, batchSize, threads), validates any caller-supplied override against this
// hardware's actual capability, computes the resulting fit estimate/verdict, and — for a
// "risky"/"unsupported" result — suggests concrete alternatives. Pure: every exported function is
// a plain function of its arguments (no I/O, no clock, no randomness), so the same
// `RuntimePlanInput` always produces the same `RuntimePlan` (issue: "同一入力で決定的なplan").
//
// -------------------------------------------------------------------------------------------
// Design notes
// -------------------------------------------------------------------------------------------
// - `DEFAULT_CONTEXT_SIZE_CAP` (2048) intentionally mirrors model-runtime.ts's own
//   `DEFAULT_CONTEXT_SIZE` constant, but is NOT imported from it: model-runtime.ts pulls in
//   native-loader.ts's types (fine, type-only) and is conceptually the *inference runtime* module,
//   not part of this pure planning layer's dependency surface. If the two constants ever need to
//   diverge or drift, this comment is the tripwire for whoever changes one of them.
//
// - Auto GPU layer count when VRAM is known: a full linear scan over every possible `gpuLayers`
//   value (0..totalOffloadableLayers), picking whichever achieves the best verdict tier — and,
//   among ties, the LARGEST layer count (more GPU offload is generally faster, so it's preferred
//   whenever it doesn't cost anything in fit quality). Cheap: even a 100+-layer model is at most
//   ~100 pure `estimateFit()` calls.
//
// - Auto GPU layer count when VRAM is UNKNOWN: this planner attempts a FULL offload
//   (`gpuLayers = totalOffloadableLayers`) rather than silently falling back to CPU-only. This is
//   a deliberate choice, distinct from (and not in tension with) the issue's ban on treating
//   unknown GPU memory as `0`: fit-estimator.ts already caps the resulting verdict at "risky" and
//   attaches the `GPU_MEMORY_UNKNOWN` reason whenever `gpuLayers > 0` and VRAM is unknown, so the
//   uncertainty is communicated honestly through the verdict/reason rather than hidden by quietly
//   avoiding GPU use. A caller/UI that wants to be more conservative always has the `cpu-fallback`
//   alternative (offered automatically below whenever the plan isn't "recommended"/"possible") and
//   can always override `gpuLayers` down or to `0` explicitly.
//
// - Overrides are validated and CLAMPED, never thrown: an out-of-range or backend-incompatible
//   override is replaced with a resolved value and reported in the `overrides` array (`accepted:
//   false`, plus which reason code and what the substituted value was) rather than raising an
//   exception. This keeps `planRuntime()` a total function (always returns a plan) and leaves the
//   choice of "reject the request" vs. "proceed with the resolved value" to the caller, who has
//   full visibility into what was substituted and why.
//
// - Alternative priority order (issue: "suggestion優先順"), least-to-most disruptive: reduce
//   context size, then reduce GPU layers, then CPU fallback, then a smaller installed model. Only
//   generated when the resolved plan is "risky" or "unsupported" (a "recommended"/"possible" plan
//   returns an empty `alternatives` array — there is nothing to suggest instead of a plan that
//   already works).
import { estimateFit, hasGpuOffloadSupport, totalOffloadableLayers } from "./fit-estimator";
import { meetsOrBetter, verdictRank } from "./estimation-policy";
import { FIT_ESTIMATOR_VERSION } from "../../../../shared/local-llm/fit-contract";
import type { FitModelInput, FitVerdict, InstalledModelCandidate, OverrideResolution, PlanAlternative, RuntimeCandidate, RuntimePlan, RuntimePlanInput } from "../../../../shared/local-llm/fit-contract";
import type { HardwareProfile } from "../../../../shared/local-llm/hardware-contract";

const DEFAULT_CONTEXT_SIZE_CAP = 2048;
const DEFAULT_BATCH_SIZE_CAP = 512;
/** Alternatives never suggest a context size below this floor — anything smaller is barely usable
 * for real chat/completion and not a meaningful "alternative" to offer. */
const MIN_SUGGESTED_CONTEXT_SIZE = 16;
/** How many "smaller model" alternatives to surface at most, closest-size-first. */
const MAX_SMALLER_MODEL_SUGGESTIONS = 3;

type FieldResolution<T> = { value: T; override?: OverrideResolution };

function resolveBackend(hardware: HardwareProfile, requested: string | undefined): FieldResolution<string> {
  const autoBackend = hasGpuOffloadSupport(hardware) ? hardware.gpu.backend!.name : "cpu";
  if (requested === undefined) return { value: autoBackend };
  if (requested === "cpu") return { value: "cpu", override: { field: "backend", requestedValue: requested, accepted: true, resolvedValue: "cpu", reason: "OVERRIDE_ACCEPTED" } };
  if (hasGpuOffloadSupport(hardware) && requested === hardware.gpu.backend!.name) {
    return { value: requested, override: { field: "backend", requestedValue: requested, accepted: true, resolvedValue: requested, reason: "OVERRIDE_ACCEPTED" } };
  }
  return { value: autoBackend, override: { field: "backend", requestedValue: requested, accepted: false, resolvedValue: autoBackend, reason: "OVERRIDE_BACKEND_UNAVAILABLE" } };
}

function resolveContextSize(model: FitModelInput, requested: number | undefined): FieldResolution<number> {
  const autoContextSize = Math.max(1, Math.min(DEFAULT_CONTEXT_SIZE_CAP, model.trainContextSize > 0 ? model.trainContextSize : DEFAULT_CONTEXT_SIZE_CAP));
  if (requested === undefined) return { value: autoContextSize };
  if (!Number.isFinite(requested) || requested < 1) {
    return { value: autoContextSize, override: { field: "contextSize", requestedValue: requested, accepted: false, resolvedValue: autoContextSize, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  const rounded = Math.round(requested);
  if (rounded > model.trainContextSize) {
    return { value: model.trainContextSize, override: { field: "contextSize", requestedValue: requested, accepted: false, resolvedValue: model.trainContextSize, reason: "CONTEXT_CLAMPED_TO_TRAIN_CONTEXT" } };
  }
  return { value: rounded, override: { field: "contextSize", requestedValue: requested, accepted: true, resolvedValue: rounded, reason: "OVERRIDE_ACCEPTED" } };
}

function resolveBatchSize(contextSize: number, requested: number | undefined): FieldResolution<number> {
  const autoBatchSize = Math.max(1, Math.min(DEFAULT_BATCH_SIZE_CAP, contextSize));
  if (requested === undefined) return { value: autoBatchSize };
  if (!Number.isFinite(requested) || requested < 1) {
    return { value: autoBatchSize, override: { field: "batchSize", requestedValue: requested, accepted: false, resolvedValue: autoBatchSize, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  const rounded = Math.round(requested);
  if (rounded > contextSize) {
    return { value: contextSize, override: { field: "batchSize", requestedValue: requested, accepted: false, resolvedValue: contextSize, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  return { value: rounded, override: { field: "batchSize", requestedValue: requested, accepted: true, resolvedValue: rounded, reason: "OVERRIDE_ACCEPTED" } };
}

function resolveThreads(hardware: HardwareProfile, requested: number | undefined): FieldResolution<number> {
  const autoThreads = Math.max(1, hardware.cpu.cores - 1); // leaves one core free for the host process/UI thread
  if (requested === undefined) return { value: autoThreads };
  if (!Number.isFinite(requested) || requested < 1) {
    return { value: autoThreads, override: { field: "threads", requestedValue: requested, accepted: false, resolvedValue: autoThreads, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  const rounded = Math.round(requested);
  if (rounded > hardware.cpu.cores) {
    return { value: hardware.cpu.cores, override: { field: "threads", requestedValue: requested, accepted: false, resolvedValue: hardware.cpu.cores, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  return { value: rounded, override: { field: "threads", requestedValue: requested, accepted: true, resolvedValue: rounded, reason: "OVERRIDE_ACCEPTED" } };
}

/** See this file's header comment for the "known VRAM: exhaustive best-verdict scan" / "unknown
 * VRAM: attempt full offload" split. */
function resolveAutoGpuLayers(model: FitModelInput, hardware: HardwareProfile, backend: string, contextSize: number, batchSize: number): number {
  if (backend === "cpu" || !hasGpuOffloadSupport(hardware)) return 0;
  const total = totalOffloadableLayers(model);
  if (hardware.gpu.memory.status === "unknown") return total;

  let bestLayers = 0;
  let bestVerdict: FitVerdict = "unsupported";
  for (let layers = 0; layers <= total; layers += 1) {
    const estimate = estimateFit({ model, candidate: { backend, contextSize, gpuLayers: layers, batchSize }, hardware });
    if (verdictRank(estimate.verdict) >= verdictRank(bestVerdict)) {
      bestVerdict = estimate.verdict;
      bestLayers = layers;
    }
  }
  return bestLayers;
}

function resolveGpuLayers(model: FitModelInput, backend: string, autoValue: number, requested: number | undefined): FieldResolution<number> {
  const total = totalOffloadableLayers(model);
  if (requested === undefined) return { value: autoValue };
  if (requested > 0 && backend === "cpu") {
    return { value: 0, override: { field: "gpuLayers", requestedValue: requested, accepted: false, resolvedValue: 0, reason: "GPU_LAYERS_UNSUPPORTED_NO_GPU" } };
  }
  if (!Number.isFinite(requested) || requested < 0) {
    return { value: autoValue, override: { field: "gpuLayers", requestedValue: requested, accepted: false, resolvedValue: autoValue, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  const rounded = Math.round(requested);
  if (rounded > total) {
    return { value: total, override: { field: "gpuLayers", requestedValue: requested, accepted: false, resolvedValue: total, reason: "OVERRIDE_OUT_OF_RANGE" } };
  }
  return { value: rounded, override: { field: "gpuLayers", requestedValue: requested, accepted: true, resolvedValue: rounded, reason: "OVERRIDE_ACCEPTED" } };
}

function findSmallerContextMeeting(model: FitModelInput, hardware: HardwareProfile, candidate: RuntimeCandidate, floor: FitVerdict): { contextSize: number; verdict: FitVerdict } | null {
  let size = candidate.contextSize;
  while (size > MIN_SUGGESTED_CONTEXT_SIZE) {
    size = Math.max(MIN_SUGGESTED_CONTEXT_SIZE, Math.floor(size / 2));
    const batchSize = Math.max(1, Math.min(candidate.batchSize, size));
    const estimate = estimateFit({ model, candidate: { ...candidate, contextSize: size, batchSize }, hardware });
    if (meetsOrBetter(estimate.verdict, floor)) return { contextSize: size, verdict: estimate.verdict };
  }
  return null;
}

function findSmallerGpuLayersMeeting(model: FitModelInput, hardware: HardwareProfile, candidate: RuntimeCandidate, floor: FitVerdict): { gpuLayers: number; verdict: FitVerdict } | null {
  for (let layers = candidate.gpuLayers - 1; layers >= 0; layers -= 1) {
    const estimate = estimateFit({ model, candidate: { ...candidate, gpuLayers: layers }, hardware });
    if (meetsOrBetter(estimate.verdict, floor)) return { gpuLayers: layers, verdict: estimate.verdict };
  }
  return null;
}

function buildAlternatives(model: FitModelInput, hardware: HardwareProfile, candidate: RuntimeCandidate, currentVerdict: FitVerdict, installedModels: InstalledModelCandidate[] | undefined): PlanAlternative[] {
  const alternatives: PlanAlternative[] = [];

  const reducedContext = findSmallerContextMeeting(model, hardware, candidate, "possible");
  if (reducedContext && reducedContext.contextSize < candidate.contextSize) {
    alternatives.push({ kind: "reduce-context", contextSize: reducedContext.contextSize, verdict: reducedContext.verdict, description: `Reduce context size to ${reducedContext.contextSize} tokens.` });
  }

  if (candidate.gpuLayers > 0) {
    const reducedLayers = findSmallerGpuLayersMeeting(model, hardware, candidate, "possible");
    if (reducedLayers && reducedLayers.gpuLayers < candidate.gpuLayers) {
      alternatives.push({ kind: "reduce-gpu-layers", gpuLayers: reducedLayers.gpuLayers, verdict: reducedLayers.verdict, description: `Reduce GPU-offloaded layers to ${reducedLayers.gpuLayers}.` });
    }
  }

  if (candidate.backend !== "cpu") {
    const cpuCandidate: RuntimeCandidate = { backend: "cpu", contextSize: candidate.contextSize, gpuLayers: 0, batchSize: candidate.batchSize };
    const cpuEstimate = estimateFit({ model, candidate: cpuCandidate, hardware });
    if (verdictRank(cpuEstimate.verdict) > verdictRank(currentVerdict)) {
      alternatives.push({ kind: "cpu-fallback", verdict: cpuEstimate.verdict, description: "Fall back to CPU-only inference (no GPU offload)." });
    }
  }

  if (installedModels && installedModels.length > 0) {
    const smaller = installedModels
      .filter((candidateModel) => candidateModel.modelId !== model.modelId && candidateModel.sizeBytes < model.sizeBytes)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, MAX_SMALLER_MODEL_SUGGESTIONS);
    for (const smallerModel of smaller) {
      alternatives.push({ kind: "smaller-model", modelId: smallerModel.modelId, displayName: smallerModel.displayName, sizeBytes: smallerModel.sizeBytes, description: `Try a smaller installed model: ${smallerModel.displayName}.` });
    }
  }

  return alternatives;
}

/** Resolves every `"auto"` runtime slot, validates any override, estimates the fit, and — for a
 * non-"recommended"/"possible" result — attaches alternatives. Never throws. */
export function planRuntime(input: RuntimePlanInput): RuntimePlan {
  const { model, hardware, overrides = {}, installedModels } = input;
  const overrideResolutions: OverrideResolution[] = [];
  const pushOverride = (resolution: FieldResolution<number | string>): void => {
    if (resolution.override) overrideResolutions.push(resolution.override);
  };

  const backendResolution = resolveBackend(hardware, overrides.backend);
  pushOverride(backendResolution);
  const backend = backendResolution.value;

  const contextResolution = resolveContextSize(model, overrides.contextSize);
  pushOverride(contextResolution);
  const contextSize = contextResolution.value;

  const batchResolution = resolveBatchSize(contextSize, overrides.batchSize);
  pushOverride(batchResolution);
  const batchSize = batchResolution.value;

  const autoGpuLayers = resolveAutoGpuLayers(model, hardware, backend, contextSize, batchSize);
  const gpuLayersResolution = resolveGpuLayers(model, backend, autoGpuLayers, overrides.gpuLayers);
  pushOverride(gpuLayersResolution);
  const gpuLayers = gpuLayersResolution.value;

  const threadsResolution = resolveThreads(hardware, overrides.threads);
  pushOverride(threadsResolution);
  const threads = threadsResolution.value;

  const candidate: RuntimeCandidate = { backend, contextSize, gpuLayers, batchSize };
  const estimate = estimateFit({ model, candidate, hardware });

  const alternatives = meetsOrBetter(estimate.verdict, "possible") ? [] : buildAlternatives(model, hardware, candidate, estimate.verdict, installedModels);

  return {
    estimatorVersion: FIT_ESTIMATOR_VERSION,
    backend,
    contextSize,
    gpuLayers,
    batchSize,
    threads,
    verdict: estimate.verdict,
    estimate,
    overrides: overrideResolutions,
    alternatives,
  };
}

