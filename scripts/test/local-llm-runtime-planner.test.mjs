// Unit coverage for #78's runtime-planner.ts. Pure logic only — see fit-estimator.ts's header
// comment for why this whole layer never loads a native model. Bundled the same way every other
// local-llm-*.test.mjs in this repo is.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { planRuntime } from "./electron/main/services/local-llm/planning/runtime-planner.ts";`,
        `export { totalOffloadableLayers } from "./electron/main/services/local-llm/planning/fit-estimator.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-runtime-planner-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-runtime-planner-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return import(file);
}

const modules = await loadModules();
const { planRuntime, totalOffloadableLayers } = modules;

function baseModel(overrides = {}) {
  return {
    modelId: "test-model",
    displayName: "Test Model",
    sizeBytes: 4 * 1024 ** 3,
    trainContextSize: 8192,
    blockCount: 32,
    embeddingLength: 4096,
    attentionHeadCount: 32,
    attentionHeadCountKv: 8,
    ...overrides,
  };
}

function noGpuHardware(overrides = {}) {
  return {
    cpu: { cores: 8 },
    ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
    gpu: { backend: null, memory: { status: "unknown" } },
    detectedAtMs: 1_700_000_000_000,
    source: "detected",
    ...overrides,
  };
}

function gpuKnownHardware(overrides = {}) {
  return noGpuHardware({ gpu: { backend: { name: "cuda", supportsGpuOffload: true }, memory: { status: "known", totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 } }, ...overrides });
}

function gpuUnknownHardware(overrides = {}) {
  return noGpuHardware({ gpu: { backend: { name: "cuda", supportsGpuOffload: true }, memory: { status: "unknown" } }, ...overrides });
}

// =============================================================================================
// Auto backend / gpuLayers resolution
// =============================================================================================

test("planRuntime: no GPU backend at all -> auto backend is 'cpu', gpuLayers is 0, no overrides recorded", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware() });
  assert.equal(plan.backend, "cpu");
  assert.equal(plan.gpuLayers, 0);
  assert.deepEqual(plan.overrides, []);
  assert.equal(plan.estimate.vram, null);
});

test("planRuntime: GPU known and plentiful -> auto backend picks the GPU backend and offloads all layers (best achievable verdict)", () => {
  const model = baseModel();
  const hardware = gpuKnownHardware();
  const plan = planRuntime({ model, hardware });
  assert.equal(plan.backend, "cuda");
  assert.equal(plan.gpuLayers, totalOffloadableLayers(model));
  assert.equal(plan.verdict, "recommended");
});

test("planRuntime: GPU present but VRAM UNKNOWN -> auto plan still attempts full GPU offload (does not silently fall back to CPU), verdict capped at risky, and a cpu-fallback alternative is offered", () => {
  const model = baseModel();
  const hardware = gpuUnknownHardware({ ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 17_179_869_184, availableBytes: 17_179_869_184 } });
  const plan = planRuntime({ model, hardware });
  assert.equal(plan.backend, "cuda");
  assert.equal(plan.gpuLayers, totalOffloadableLayers(model), "must attempt to use the detected GPU rather than silently defaulting to 0 layers just because VRAM is unknown");
  assert.equal(plan.verdict, "risky");
  assert.ok(plan.estimate.reasons.includes("GPU_MEMORY_UNKNOWN"));
  assert.ok(plan.alternatives.some((alt) => alt.kind === "cpu-fallback"));
});

test("planRuntime: context size auto-defaults to min(2048, trainContextSize)", () => {
  const smallTrainContext = planRuntime({ model: baseModel({ trainContextSize: 512 }), hardware: noGpuHardware() });
  assert.equal(smallTrainContext.contextSize, 512);
  const bigTrainContext = planRuntime({ model: baseModel({ trainContextSize: 32768 }), hardware: noGpuHardware() });
  assert.equal(bigTrainContext.contextSize, 2048);
});

test("planRuntime: threads auto-defaults to cores - 1 (leaves one core free), never below 1", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware({ cpu: { cores: 8 } }) });
  assert.equal(plan.threads, 7);
  const singleCore = planRuntime({ model: baseModel(), hardware: noGpuHardware({ cpu: { cores: 1 } }) });
  assert.equal(singleCore.threads, 1);
});

// =============================================================================================
// Invalid user overrides — validated against range/backend capability, clamped + reported, never
// silently ignored and never thrown.
// =============================================================================================

test("planRuntime: contextSize override exceeding trainContextSize is clamped down and reported as CONTEXT_CLAMPED_TO_TRAIN_CONTEXT", () => {
  const model = baseModel({ trainContextSize: 8192 });
  const plan = planRuntime({ model, hardware: noGpuHardware(), overrides: { contextSize: 999_999 } });
  assert.equal(plan.contextSize, 8192);
  const resolution = plan.overrides.find((o) => o.field === "contextSize");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.resolvedValue, 8192);
  assert.equal(resolution.reason, "CONTEXT_CLAMPED_TO_TRAIN_CONTEXT");
  assert.equal(resolution.requestedValue, 999_999);
});

test("planRuntime: a negative/zero contextSize override is rejected and replaced with the auto value", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware(), overrides: { contextSize: -5 } });
  assert.equal(plan.contextSize, 2048);
  const resolution = plan.overrides.find((o) => o.field === "contextSize");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.reason, "OVERRIDE_OUT_OF_RANGE");
});

test("planRuntime: gpuLayers override beyond the model's total offloadable layers is clamped to the maximum and reported OVERRIDE_OUT_OF_RANGE", () => {
  const model = baseModel();
  const plan = planRuntime({ model, hardware: gpuKnownHardware(), overrides: { gpuLayers: 999 } });
  assert.equal(plan.gpuLayers, totalOffloadableLayers(model));
  const resolution = plan.overrides.find((o) => o.field === "gpuLayers");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.reason, "OVERRIDE_OUT_OF_RANGE");
});

test("planRuntime: gpuLayers > 0 override on hardware with no GPU support is rejected to 0 with GPU_LAYERS_UNSUPPORTED_NO_GPU", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware(), overrides: { gpuLayers: 5 } });
  assert.equal(plan.gpuLayers, 0);
  const resolution = plan.overrides.find((o) => o.field === "gpuLayers");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.reason, "GPU_LAYERS_UNSUPPORTED_NO_GPU");
});

test("planRuntime: batchSize override exceeding the resolved contextSize is clamped down to contextSize", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware(), overrides: { contextSize: 1024, batchSize: 99999 } });
  assert.equal(plan.batchSize, 1024);
  const resolution = plan.overrides.find((o) => o.field === "batchSize");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.reason, "OVERRIDE_OUT_OF_RANGE");
});

test("planRuntime: threads override beyond the detected core count is clamped to the core count", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware({ cpu: { cores: 8 } }), overrides: { threads: 999 } });
  assert.equal(plan.threads, 8);
  const resolution = plan.overrides.find((o) => o.field === "threads");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.reason, "OVERRIDE_OUT_OF_RANGE");
});

test("planRuntime: a backend override naming a GPU backend that isn't the detected one falls back to auto and is reported OVERRIDE_BACKEND_UNAVAILABLE", () => {
  const plan = planRuntime({ model: baseModel(), hardware: gpuKnownHardware(), overrides: { backend: "vulkan" } });
  assert.equal(plan.backend, "cuda");
  const resolution = plan.overrides.find((o) => o.field === "backend");
  assert.equal(resolution.accepted, false);
  assert.equal(resolution.reason, "OVERRIDE_BACKEND_UNAVAILABLE");
});

test("planRuntime: a valid override (within range, backend-compatible) is accepted as-is and reported OVERRIDE_ACCEPTED", () => {
  const model = baseModel();
  const plan = planRuntime({ model, hardware: gpuKnownHardware(), overrides: { backend: "cuda", contextSize: 4096, gpuLayers: 10, batchSize: 128, threads: 4 } });
  assert.equal(plan.backend, "cuda");
  assert.equal(plan.contextSize, 4096);
  assert.equal(plan.gpuLayers, 10);
  assert.equal(plan.batchSize, 128);
  assert.equal(plan.threads, 4);
  assert.equal(plan.overrides.length, 5);
  assert.ok(plan.overrides.every((o) => o.accepted && o.reason === "OVERRIDE_ACCEPTED"));
});

// =============================================================================================
// Alternatives: suggestion priority order (reduce-context, reduce-gpu-layers, cpu-fallback,
// smaller-model) — a scenario deliberately constructed so all four kinds apply simultaneously.
// =============================================================================================

test("planRuntime: a badly-overfit forced plan yields alternatives in the documented priority order: reduce-context, reduce-gpu-layers, cpu-fallback, smaller-model", () => {
  const model = baseModel({
    modelId: "big-model",
    displayName: "Big Model",
    sizeBytes: 209_715_200, // 200 MiB
    trainContextSize: 32768,
    blockCount: 8,
    embeddingLength: 1024,
    attentionHeadCount: 16,
    attentionHeadCountKv: 16,
  });
  const hardware = gpuKnownHardware({
    ram: { totalBytes: 34_359_738_368, freeBytes: 17_179_869_184, availableBytes: 17_179_869_184 },
    gpu: { backend: { name: "cuda", supportsGpuOffload: true }, memory: { status: "known", totalBytes: 1_073_741_824, freeBytes: 900_000_000 } },
  });
  const installedModels = [
    { modelId: "small-1", displayName: "Small One", sizeBytes: 100_000_000 },
    { modelId: "small-2", displayName: "Small Two", sizeBytes: 150_000_000 },
    { modelId: "small-3", displayName: "Small Three", sizeBytes: 50_000_000 },
    { modelId: "too-big", displayName: "Too Big", sizeBytes: 300_000_000 }, // larger than `model` — must be excluded
    { modelId: "big-model", displayName: "Self", sizeBytes: 1 }, // same id as the model being planned for — must be excluded even though "smaller"
  ];

  // Force a configuration that overrides bypass the auto-search entirely: full context, full GPU
  // offload, on hardware whose VRAM (900MB) can't hold this 200MB model's weights plus a 32K-token
  // KV cache — see the PR description for the full derivation of these numbers.
  const plan = planRuntime({ model, hardware, overrides: { contextSize: 32768, gpuLayers: totalOffloadableLayers(model) }, installedModels });

  assert.equal(plan.contextSize, 32768);
  assert.equal(plan.gpuLayers, totalOffloadableLayers(model));
  assert.equal(plan.verdict, "unsupported");
  assert.ok(plan.estimate.reasons.includes("VRAM_INSUFFICIENT"));

  const kinds = plan.alternatives.map((alt) => alt.kind);
  assert.deepEqual(kinds, ["reduce-context", "reduce-gpu-layers", "cpu-fallback", "smaller-model", "smaller-model", "smaller-model"]);

  const reduceContext = plan.alternatives.find((alt) => alt.kind === "reduce-context");
  assert.equal(reduceContext.contextSize, 16384);
  assert.ok(reduceContext.contextSize < plan.contextSize);
  assert.ok(["possible", "recommended"].includes(reduceContext.verdict));

  const reduceGpuLayers = plan.alternatives.find((alt) => alt.kind === "reduce-gpu-layers");
  assert.equal(reduceGpuLayers.gpuLayers, 5);
  assert.ok(reduceGpuLayers.gpuLayers < plan.gpuLayers);
  assert.ok(["possible", "recommended"].includes(reduceGpuLayers.verdict));

  const cpuFallback = plan.alternatives.find((alt) => alt.kind === "cpu-fallback");
  assert.equal(cpuFallback.verdict, "recommended");

  const smallerModels = plan.alternatives.filter((alt) => alt.kind === "smaller-model");
  assert.deepEqual(smallerModels.map((alt) => alt.modelId), ["small-2", "small-1", "small-3"]);
  assert.deepEqual(smallerModels.map((alt) => alt.sizeBytes), [150_000_000, 100_000_000, 50_000_000]);
  assert.ok(smallerModels.every((alt) => alt.sizeBytes < model.sizeBytes));
});

test("planRuntime: a comfortably-fitting plan returns an empty alternatives array (nothing to suggest instead of a plan that already works)", () => {
  const plan = planRuntime({ model: baseModel(), hardware: noGpuHardware() });
  assert.equal(plan.verdict, "recommended");
  assert.deepEqual(plan.alternatives, []);
});

// =============================================================================================
// Determinism: the SAME input always produces the SAME plan.
// =============================================================================================

test("planRuntime: the exact same RuntimePlanInput produces byte-identical plans across repeated and interleaved calls", () => {
  const model = baseModel();
  const hardware = gpuUnknownHardware();
  const overrides = { contextSize: 4096, threads: 3 };
  const installedModels = [{ modelId: "other", displayName: "Other", sizeBytes: 1024 }];

  const first = planRuntime({ model, hardware, overrides, installedModels });
  const second = planRuntime({ model, hardware, overrides, installedModels });
  // Interleave an unrelated call to rule out any hidden shared/mutated state between calls.
  planRuntime({ model: baseModel({ sizeBytes: 1 }), hardware: noGpuHardware() });
  const third = planRuntime({ model, hardware, overrides, installedModels });

  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test("planRuntime: never throws for a wildly malformed override set — always returns a total plan", () => {
  assert.doesNotThrow(() => {
    planRuntime({
      model: baseModel(),
      hardware: noGpuHardware(),
      overrides: { backend: "not-a-real-backend", contextSize: -1, gpuLayers: -1, batchSize: 0, threads: -100 },
    });
  });
});
